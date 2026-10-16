"""Homepage catalogue pages; cursors contain only public upstream pagination state."""
import hashlib
import json
import re
import secrets
import time
import uuid
from typing import Literal

from fastapi import HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from catalog_cache import Payload, json_bytes, not_modified, response_headers


class Library:
    def __init__(self, source, cache):
        self.source, self.cache = source, cache

    def page(self, genre, order, theme='', cursor=''):
        params = {'genre': genre, 'order': order, 'theme': theme}
        state = {'offset': 0, 'session': '', 'seen': []}
        if cursor:
            entry = self.cache.read('library-cursor:' + cursor)
            if not entry:
                raise HTTPException(410, '片单已更新，请重新打开首页继续浏览')
            stored = json.loads(entry.body)
            if stored['params'] != params:
                raise HTTPException(400, '分页与当前分类不匹配')
            state = stored['state']
        key = 'library-page24:' + hashlib.sha256(json_bytes([params, cursor])).hexdigest()
        generation = self.cache.generation

        def load(previous):
            items, more, offset, session = self._read(params, state)
            seen = set(state['seen'])
            unique = []
            for item in items:
                sid = item['series_id']
                if sid not in seen:
                    unique.append(item)
                    seen.add(sid)
            if more and offset <= state['offset']:
                raise ValueError('Upstream pagination did not advance')
            next_cursor = None
            if more:
                resume = {'params': params, 'state': {'offset': offset, 'session': session, 'seen': sorted(seen)}}
                body = json_bytes(resume)
                next_cursor = hashlib.sha256(body).hexdigest()
                self.cache.put('library-cursor:' + next_cursor, Payload(body), generation=generation)
            return Payload(json_bytes({'items': unique, 'has_more': more, 'next_cursor': next_cursor}))

        try:
            return self.cache.get(key, load, 900 if not cursor else 86400)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, '片单暂时加载失败，请稍后重试') from exc

    def prefetch(self, genre, order, theme, entry):
        """Warm two following metadata pages; reuse durable snapshots, never fetch videos."""
        page = json.loads(entry.body)
        cursor = page.get('next_cursor')
        if not page.get('has_more') or not cursor:
            return False
        key = 'library-prefetch:' + hashlib.sha256(json_bytes([genre, order, theme, cursor])).hexdigest()
        previous = self.cache.read(key)
        if previous and time.time() - previous.checked < 86400:
            return False

        def warm(previous):
            next_cursor = cursor
            for _ in range(2):
                result, _ = self.page(genre, order, theme, next_cursor)
                data = json.loads(result.body)
                if not data.get('has_more') or not data.get('next_cursor'):
                    break
                next_cursor = data['next_cursor']
            return Payload(json_bytes({'ready': True}))

        # Existing bounded worker pool, single flight and outage backoff apply.
        return self.cache.refresh(key, warm)

    def random_item(self, genre, order, theme='', exclude=()):
        """Choose from three real catalogue pages without inventing titles."""
        blocked = {str(value) for value in exclude}
        cursor, candidates = '', []
        for _ in range(3):
            entry, _ = self.page(genre, order, theme, cursor)
            page = json.loads(entry.body)
            candidates.extend(item for item in page.get('items', [])
                              if str(item.get('series_id', '')) not in blocked)
            cursor = page.get('next_cursor') or ''
            if not page.get('has_more') or not cursor:
                break
        if not candidates:
            raise HTTPException(404, '当前筛选范围暂时没有新的随机剧集')
        return secrets.choice(candidates)

    def _read(self, params, state):
        h = self.source
        ranked = params['genre'] == 'comic_series' and params['order'] == 'hot' and not params['theme']
        session = state['session'] or (str(uuid.uuid4()) if ranked else '')
        for attempt in range(2):
            if ranked:
                query = {'cell_id': h.COMIC_RANK_CELL, 'tab_type': '26', 'client_req_type': '2',
                         'client_template': '2', 'screen_width_px': '1350',
                         'selected_items': 'comic_series_rank', 'sub_selected_items': h.RANK_BOARDS['hot'],
                         'session_uuid': session, 'offset': str(state['offset'])}
                result = h.api('GET', '/reading/bookapi/bookmall/cell/change/v', extra_query=query, signed=h.SIGN_LIST)
            else:
                scene, genre = h.GENRES[params['genre']]
                selected = {'genre': [genre], 'category_dim_theme': h._ids(params['theme'], h.FILTER_CATE),
                            'category_dim_role': [], 'category_dim_epoch': [], 'sort': ['online_time' if params['order'] == 'latest' else 'hot_score'],
                            'gender': [], 'creation_status': [], 'online_time': []}
                body = {'filter_ids': ','.join(state['seen']), 'req_scene': scene, 'offset': state['offset'],
                        'need_selector_panel': False, 'limit': 24, 'select_items': selected,
                        'session_id': session, 'req_type': 'only_content', 'client_req_type': 3}
                result = h.api('POST', '/reading/distribution/category/landpage/v', body=body, signed=h.SIGN_LIST)
            if not isinstance(result, dict) or result.get('code', 0) not in (0, '0') or not isinstance(result.get('data'), dict):
                raise ValueError('Invalid upstream catalogue response')
            data = result['data'].get('cell_view') if ranked else result['data']
            if not isinstance(data, dict) or not isinstance(data.get('cell_data' if ranked else 'video_data'), list) or 'has_more' not in data:
                raise ValueError('Missing upstream pagination')
            raw = data['cell_data' if ranked else 'video_data']
            if raw or attempt:
                break
        items = []
        for row in raw:
            value = row.get('video_data') if ranked else row
            if isinstance(value, list):
                value = value[0] if value else {}
            if not isinstance(value, dict):
                continue
            sid = str(value.get('series_id') or value.get('book_id') or '')
            if not re.fullmatch(r'\d{1,24}', sid):
                continue
            schema = value.get('category_schema', '')
            categories = list(dict.fromkeys(re.findall(r'"name"\s*:\s*"([^"]+)"', schema if isinstance(schema, str) else '')))
            items.append({'series_id': sid, 'title': value.get('title', ''), 'cover': value.get('cover', ''),
                          'episode_cnt': value.get('episode_cnt', 0), 'score': value.get('score', ''),
                          'play_cnt': value.get('play_cnt', 0), 'hot': value.get('rec_text', ''),
                          'copyright': value.get('copyright', ''), 'category': ' / '.join(categories),
                          'intro': (value.get('video_desc') or '')[:50]})
        more = bool(data['has_more'])
        offset = int(data.get('next_offset') if data.get('next_offset') is not None else state['offset'] + len(raw))
        return items, more, offset, session if ranked else str(data.get('session_id') or session)


class RandomRequest(BaseModel):
    genre: Literal['short_play', 'comic_series', 'ai_series'] = 'comic_series'
    order: Literal['latest', 'hot'] = 'latest'
    theme: str = Field(default='', max_length=80)
    exclude: list[str] = Field(default_factory=list, max_length=300)


def install_library(app, source, cache):
    library = Library(source, cache)

    @app.get('/library')
    def homepage_library(request: Request,
                         genre: Literal['short_play', 'comic_series', 'ai_series'] = 'comic_series',
                         order: Literal['latest', 'hot'] = 'latest',
                         theme: str = Query('', max_length=80),
                         cursor: str = Query('', pattern=r'^(?:[0-9a-f]{64})?$')):
        entry, state = library.page(genre, order, theme, cursor)
        library.prefetch(genre, order, theme, entry)
        headers = response_headers(entry, state)
        if not_modified(request.headers.get('if-none-match'), entry.etag):
            return Response(status_code=304, headers=headers)
        return Response(entry.body, media_type=entry.media_type, headers=headers)

    @app.post('/library/random')
    def random_library(body: RandomRequest):
        if any(not re.fullmatch(r'\d{1,24}', str(value)) for value in body.exclude):
            raise HTTPException(400, '随机排除列表无效')
        item = library.random_item(body.genre, body.order, body.theme, body.exclude)
        return Response(json_bytes({'item': item}), media_type='application/json',
                        headers={'Cache-Control': 'no-store'})

    return library
