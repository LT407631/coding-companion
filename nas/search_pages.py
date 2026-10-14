"""One upstream search page per request, with durable, isolated pagination chains."""
import hashlib
import json
import re
import time
import unicodedata
import uuid
from dataclasses import replace

from fastapi import HTTPException, Query, Request
from fastapi.responses import Response

from catalog_cache import Payload, json_bytes, not_modified, response_headers


PAGE_TTL = 600
CHAIN_TTL = 3600
MAX_PAGES = 64
MAX_SEEN = 4096
MAX_EMPTY_PAGES = 3
CURSOR_PATTERN = r'^(?:[0-9a-f]{64})?$'


def _query(value):
    if not isinstance(value, str) or any(unicodedata.category(c) in {'Cc', 'Cf', 'Cs'} for c in value):
        raise HTTPException(400, '搜索关键词无效')
    value = value.strip()
    if not value or len(value) > 100:
        raise HTTPException(400, '搜索关键词须为1至100个字符')
    return value


def _namespace(source):
    public = getattr(source, 'namespace', None)
    if callable(public):
        public = public()
    if public is None:
        cfg = getattr(source, 'CFG', {})
        cfg = cfg if isinstance(cfg, dict) else {}
        params = cfg.get('base_query', {})
        params = params if isinstance(params, dict) else {}
        public = {'api_host': cfg.get('api_host', ''),
                  'app': {k: params[k] for k in ('aid', 'app_name', 'version_code', 'version_name') if k in params}}
    return hashlib.sha256(json_bytes(public)).hexdigest()


def _token(state):
    return [str(state['offset']), state['passback'], state['search_id']]


class SearchPages:
    def __init__(self, source, cache, fallback=None):
        self.source, self.cache, self.fallback = source, cache, fallback

    def page(self, query, cursor=''):
        query = _query(query)
        if not isinstance(cursor, str) or not re.fullmatch(CURSOR_PATTERN, cursor):
            raise HTTPException(400, '搜索游标无效')
        namespace = _namespace(self.source)
        state = None
        if cursor:
            entry = self.cache.read('search-cursor-v1:' + cursor)
            if not entry or hashlib.sha256(entry.body).hexdigest() != cursor:
                raise HTTPException(410, '搜索分页已过期，请重新搜索')
            state = json.loads(entry.body)
            if state['query'] != query or state['namespace'] != namespace:
                raise HTTPException(400, '分页与当前搜索来源或关键词不匹配')
            if state['expires'] <= time.time():
                raise HTTPException(410, '搜索分页已过期，请重新搜索')
        key = 'search-page-v1:' + hashlib.sha256(json_bytes([namespace, query, cursor])).hexdigest()
        generation = self.cache.generation

        def load(previous):
            current = state or {'query': query, 'namespace': namespace, 'chain': uuid.uuid4().hex,
                                'expires': time.time() + CHAIN_TTL, 'offset': 0,
                                'passback': '', 'search_id': '', 'seen': [], 'visited': [],
                                'pages': 0, 'empty_pages': 0}
            if current['expires'] <= time.time():
                raise HTTPException(410, '搜索分页已过期，请重新搜索')
            return self._load(current, generation)

        try:
            entry, cache_state = self.cache.get(key, load, PAGE_TTL)
            page = json.loads(entry.body)
            if page.get('has_more') and not self._continuation_valid(
                    page.get('next_cursor'), query, namespace, state):
                # Keep usable results visible even if a cursor was evicted or
                # expired. Refresh through the bounded pool, never rebase an
                # existing chain or persist this response-only modification.
                self.cache.refresh(key, load)
                page.update(has_more=False, next_cursor=None, restart_required=True)
                body = json_bytes(page)
                entry = replace(entry, body=body, etag='"' + hashlib.sha256(body).hexdigest() + '"')
            return entry, cache_state
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, '搜索暂时加载失败，请稍后重试') from exc

    def _continuation_valid(self, cursor, query, namespace, state):
        if not isinstance(cursor, str) or not re.fullmatch(r'[0-9a-f]{64}', cursor):
            return False
        entry = self.cache.read('search-cursor-v1:' + cursor)
        if not entry or hashlib.sha256(entry.body).hexdigest() != cursor:
            return False
        try:
            resume = json.loads(entry.body)
            expires = resume.get('expires')
            return (resume.get('query') == query and resume.get('namespace') == namespace
                    and isinstance(expires, (int, float)) and expires > time.time()
                    and (state is None or resume.get('chain') == state['chain']))
        except (ValueError, AttributeError):
            return False

    def _load(self, state, generation):
        params = {'query': state['query'], 'tab_name': 'feed', 'search_source': '1',
                  'offset': str(state['offset']), 'count': '0', 'use_correct': 'true'}
        for key in ('passback', 'search_id'):
            if state[key]:
                params[key] = state[key]
        try:
            response = self.source.api('GET', '/reading/bookapi/search/tab/v', extra_query=params)
        except Exception:
            if self.fallback is None or state['pages']:
                raise
            return self._fallback(state)
        if not isinstance(response, dict) or response.get('code', 0) not in (0, '0'):
            if self.fallback is None or state['pages']:
                raise ValueError('Invalid upstream search response')
            return self._fallback(state)
        tabs = response.get('search_tabs')
        if not isinstance(tabs, list):
            raise ValueError('Missing upstream search tabs')
        if not tabs:
            return Payload(json_bytes({'query': state['query'], 'results': [], 'has_more': False, 'next_cursor': None}))
        tab = tabs[0]
        if not isinstance(tab, dict) or not isinstance(tab.get('data'), list) or 'has_more' not in tab:
            raise ValueError('Invalid upstream search page')
        cells = tab['data']
        if len(cells) > 200:
            raise ValueError('Oversized upstream search page')
        seen = set(state['seen'])
        results = []
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            row = self.source._parse_search_cell(cell)
            if not row or not isinstance(row, dict):
                continue
            sid = str(row.get('series_id') or '')
            if not re.fullmatch(r'\d{1,24}', sid) or sid in seen:
                continue
            results.append(dict(row, series_id=sid))
            seen.add(sid)
        offset = tab.get('next_offset')
        if offset is None:
            offset = state['offset']
        if isinstance(offset, bool) or not re.fullmatch(r'\d{1,10}', str(offset)):
            raise ValueError('Invalid upstream search offset')
        offset = int(offset)
        passback = tab.get('passback') or state['passback']
        search_id = tab.get('search_id') or state['search_id']
        if not isinstance(passback, str) or len(passback) > 8192 or not isinstance(search_id, str) or len(search_id) > 512:
            raise ValueError('Invalid upstream pagination metadata')
        visited = state['visited'] + [_token(state)]
        pages = state['pages'] + 1
        empty_pages = 0 if results else state['empty_pages'] + 1
        resume = dict(state, offset=offset, passback=passback, search_id=search_id,
                      seen=sorted(seen), visited=visited, pages=pages, empty_pages=empty_pages)
        # An empty/duplicate page can still advance. Stop cycles and bounded runs
        # without fetching another page before returning this response.
        more = bool(tab['has_more']) and _token(resume) not in visited
        more = more and pages < MAX_PAGES and len(seen) < MAX_SEEN and empty_pages < MAX_EMPTY_PAGES
        next_cursor = None
        if more:
            body = json_bytes(resume)
            next_cursor = hashlib.sha256(body).hexdigest()
            self.cache.put('search-cursor-v1:' + next_cursor, Payload(body), generation=generation)
        return Payload(json_bytes({'query': state['query'], 'results': results,
                                   'has_more': more, 'next_cursor': next_cursor}))

    def _fallback(self, state):
        results = self.fallback.search(state['query'])
        if not isinstance(results, list) or len(results) > 50:
            raise ValueError('Invalid fallback search results')
        clean, seen = [], set()
        for row in results:
            if not isinstance(row, dict):
                continue
            sid = str(row.get('series_id') or '')
            if re.fullmatch(r'\d{1,24}', sid) and sid not in seen:
                seen.add(sid)
                clean.append(dict(row, series_id=sid))
        return Payload(json_bytes({'query': state['query'], 'results': clean,
                                   'has_more': False, 'next_cursor': None,
                                   'source_fallback': True}))


def install_search(app, source, cache, fallback=None):
    search = SearchPages(source, cache, fallback)

    @app.get('/search/page')
    def search_page(request: Request, q: str = Query(..., max_length=120),
                    cursor: str = Query('', pattern=CURSOR_PATTERN)):
        entry, state = search.page(q, cursor)
        headers = response_headers(entry, state)
        if not_modified(request.headers.get('if-none-match'), entry.etag):
            return Response(status_code=304, headers=headers)
        return Response(entry.body, media_type=entry.media_type, headers=headers)

    return search
