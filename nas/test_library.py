import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from catalog_cache import CatalogCache
from library import Library, install_library
import test_site_auth as auth_fixture


class Source:
    GENRES = {'comic_series': ('comic_series', 'comic_series'), 'short_play': ('default', 'short_play'), 'ai_series': ('ai_series', 'ai_series')}
    FILTER_CATE = {}
    COMIC_RANK_CELL = 'fixture'
    RANK_BOARDS = {'hot': 'comic_series_hot_play'}
    SIGN_LIST = False

    def __init__(self):
        self.calls, self.replies = [], []
        self.guard = threading.Lock()

    def _ids(self, value, mapping):
        return [value] if value else []

    def api(self, method, path, **kwargs):
        with self.guard:
            self.calls.append((method, path, kwargs))
            if self.replies:
                reply = self.replies.pop(0)
                if isinstance(reply, Exception):
                    raise reply
                return reply
        offset = int(kwargs.get('body', kwargs.get('extra_query', {})).get('offset', 0))
        items = [{'series_id': str(n), 'title': 'fixture ' + str(n), 'play_cnt': n} for n in range(offset + 1, offset + 19)]
        data = {'has_more': offset < 144, 'next_offset': offset + 18, 'session_id': 'fixture-session'}
        if method == 'GET':
            data['cell_data'] = [{'video_data': v} for v in items]
            return {'data': {'cell_view': data}}
        data['video_data'] = items
        return {'data': data}


class LibraryTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).parent / 'build'
        output.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=output)
        self.cache = CatalogCache(self.tmp.name)
        self.source = Source()
        self.library = Library(self.source, self.cache)

    def tearDown(self):
        self.cache.close()
        self.tmp.cleanup()

    def page(self, cursor='', order='latest', genre='comic_series', theme=''):
        return json.loads(self.library.page(genre, order, theme, cursor)[0].body)

    def test_continues_beyond_120_and_honors_offset_session_and_end(self):
        result, ids = self.page(), []
        while True:
            ids += [v['series_id'] for v in result['items']]
            if not result['has_more']:
                break
            result = self.page(result['next_cursor'])
        self.assertEqual(len(ids), 162)
        self.assertEqual(len(set(ids)), 162)
        self.assertIsNone(result['next_cursor'])
        body = self.source.calls[1][2]['body']
        self.assertEqual(body['offset'], 18)
        self.assertEqual(body['session_id'], 'fixture-session')
        self.assertEqual(body['select_items']['online_time'], [])
        self.assertEqual(len(body['filter_ids'].split(',')), 18)

    def test_first_page_cache_and_parallel_miss_only_fetch_once(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            pages = list(pool.map(lambda _: self.page(), range(8)))
        self.assertTrue(all(p == pages[0] for p in pages))
        self.assertEqual(len(self.source.calls), 1)
        self.assertEqual(self.source.calls[0][2]['body']['limit'], 24)

    def test_rank_and_theme_use_the_correct_independent_source(self):
        hot = self.page(order='hot')
        self.page(hot['next_cursor'], order='hot')
        self.assertEqual(self.source.calls[0][0], 'GET')
        self.assertEqual(self.source.calls[0][2]['extra_query']['session_uuid'], self.source.calls[1][2]['extra_query']['session_uuid'])
        self.page(order='hot', theme='玄幻')
        self.assertEqual(self.source.calls[-1][2]['body']['select_items']['sort'], ['hot_score'])

    def test_duplicates_advance_without_invented_items(self):
        first = self.page()
        self.source.replies = [{'data': {'video_data': first['items'], 'has_more': True, 'next_offset': 36}}]
        duplicate = self.page(first['next_cursor'])
        self.assertEqual(duplicate['items'], [])
        self.assertTrue(duplicate['has_more'])
        self.assertNotEqual(first['next_cursor'], duplicate['next_cursor'])

    def test_empty_source_retry_and_invalid_response_not_cached_as_end(self):
        self.source.replies = [{'data': {'video_data': [], 'has_more': False, 'next_offset': 0}}]
        self.assertEqual(len(self.page()['items']), 18)
        self.source.replies = [{'code': 500, 'data': {}}]
        with self.assertRaises(HTTPException) as caught:
            self.page(order='hot')
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(len(self.source.calls), 3)

    def test_nonadvancing_source_rejected_and_cursor_binding_expiry(self):
        first = self.page()
        for kwargs in ({'order': 'hot'}, {'genre': 'ai_series'}, {'theme': '玄幻'}):
            with self.assertRaises(HTTPException) as caught:
                self.page(first['next_cursor'], **kwargs)
            self.assertEqual(caught.exception.status_code, 400)
        self.source.replies = [{'data': {'video_data': first['items'], 'has_more': True, 'next_offset': 18}}]
        with self.assertRaises(HTTPException) as caught:
            self.page(first['next_cursor'])
        self.assertEqual(caught.exception.status_code, 502)
        self.cache.clear()
        with self.assertRaises(HTTPException) as caught:
            self.page(first['next_cursor'])
        self.assertEqual(caught.exception.status_code, 410)

    def test_cursor_survives_service_restart(self):
        first = self.page()
        self.cache.close()
        self.cache = CatalogCache(self.tmp.name)
        self.library = Library(self.source, self.cache)
        self.assertEqual(self.page(first['next_cursor'])['items'][0]['series_id'], '19')

    def wait_prefetch(self):
        for _ in range(400):
            with self.cache.guard:
                if not self.cache.pending:
                    return
            time.sleep(.005)
        self.fail('prefetch did not finish')

    def test_prefetch_two_pages_without_reloading_cached_content(self):
        first, _ = self.library.page('comic_series', 'latest')
        self.assertTrue(self.library.prefetch('comic_series', 'latest', '', first))
        self.wait_prefetch()
        self.assertEqual(len(self.source.calls), 3)
        cursor = json.loads(first.body)['next_cursor']
        second = self.page(cursor)
        self.assertEqual(second['items'][0]['series_id'], '19')
        self.assertEqual(self.page(second['next_cursor'])['items'][0]['series_id'], '37')
        self.assertEqual(len(self.source.calls), 3)
        self.assertFalse(self.library.prefetch('comic_series', 'latest', '', first))
        self.cache.close()
        self.cache = CatalogCache(self.tmp.name)
        self.library = Library(self.source, self.cache)
        self.assertFalse(self.library.prefetch('comic_series', 'latest', '', first))
        self.assertEqual(self.page(cursor)['items'][0]['series_id'], '19')
        self.assertEqual(len(self.source.calls), 3)

    def test_random_uses_three_real_pages_and_respects_exclusions(self):
        blocked = [str(value) for value in range(1, 54)]
        with patch('library.secrets.choice', side_effect=lambda values: values[0]):
            item = self.library.random_item('comic_series', 'latest', '', blocked)
        self.assertEqual(item['series_id'], '54')
        self.assertEqual(len(self.source.calls), 3)
        with self.assertRaises(HTTPException) as caught:
            self.library.random_item('comic_series', 'latest', '', blocked + ['54'])
        self.assertEqual(caught.exception.status_code, 404)

    def test_random_batch_returns_ten_unique_real_items(self):
        items = self.library.random_items('comic_series', 'latest', '', [str(value) for value in range(1, 7)], 10)
        ids = [item['series_id'] for item in items]
        self.assertEqual(len(ids), 10)
        self.assertEqual(len(set(ids)), 10)
        self.assertFalse(set(ids).intersection({str(value) for value in range(1, 7)}))
        self.assertEqual(len(self.source.calls), 3)

    def test_prefetch_never_blocks_foreground_and_coalesces_requests(self):
        first, _ = self.library.page('comic_series', 'latest')
        original = self.source.api
        started, release = threading.Event(), threading.Event()
        def slow(*args, **kwargs):
            started.set(); release.wait(2)
            return original(*args, **kwargs)
        self.source.api = slow
        try:
            start = time.monotonic()
            self.assertTrue(self.library.prefetch('comic_series', 'latest', '', first))
            self.assertLess(time.monotonic() - start, .1)
            self.assertTrue(started.wait(1))
            for _ in range(10):
                self.assertFalse(self.library.prefetch('comic_series', 'latest', '', first))
        finally:
            release.set(); self.wait_prefetch()
        self.assertEqual(len(self.source.calls), 3)

    def test_prefetch_failure_preserves_old_content_and_respects_backoff(self):
        first, _ = self.library.page('comic_series', 'latest')
        self.source.replies = [RuntimeError('source outage')]
        self.library.prefetch('comic_series', 'latest', '', first)
        self.wait_prefetch()
        self.assertFalse(self.library.prefetch('comic_series', 'latest', '', first))
        cached, _ = self.library.page('comic_series', 'latest')
        self.assertEqual(first.body, cached.body)
        self.assertEqual(len(self.source.calls), 2)

    def test_finished_library_does_not_prefetch(self):
        self.source.replies = [{'data': {'video_data': [{'series_id': '1'}], 'has_more': False}}]
        first, _ = self.library.page('comic_series', 'latest')
        self.assertFalse(self.library.prefetch('comic_series', 'latest', '', first))
        self.assertEqual(len(self.source.calls), 1)

    def test_new_first_page_is_incremental_and_old_pagination_remains_cached(self):
        first, _ = self.library.page('comic_series', 'latest')
        self.library.prefetch('comic_series', 'latest', '', first); self.wait_prefetch()
        old_cursor = json.loads(first.body)['next_cursor']
        old_second = self.page(old_cursor)
        self.source.replies = [{'data': {'video_data': [{'series_id': '999', 'title': 'new'}], 'has_more': True, 'next_offset': 1}}]
        key = self.cache.db.execute("SELECT key FROM entries WHERE key LIKE 'library-page24:%' AND body=?", (first.body,)).fetchone()[0]
        self.cache.db.execute('UPDATE entries SET checked=0 WHERE key=?', (key,)); self.cache.db.commit()
        stale, state = self.library.page('comic_series', 'latest')
        self.assertEqual((stale.body, state), (first.body, 'STALE'))
        self.wait_prefetch()
        self.assertEqual(self.page()['items'][0]['series_id'], '999')
        count = len(self.source.calls)
        self.assertEqual(self.page(old_cursor), old_second)
        self.assertEqual(len(self.source.calls), count)


class LibraryAuthTests(unittest.TestCase):
    request = auth_fixture.AuthTests.request
    login = auth_fixture.AuthTests.login

    def setUp(self):
        auth_fixture.AuthTests.setUp(self)
        self.cache = CatalogCache(self.root / 'catalogue')
        self.source = Source()
        install_library(self.app, self.source, self.cache)

    def tearDown(self):
        self.cache.close()
        auth_fixture.AuthTests.tearDown(self)

    def test_anonymous_denied_validated_and_revoked(self):
        self.assertEqual(self.request('/library')[0], 401)
        self.assertEqual(self.request('/library/random', 'POST', {'genre': 'comic_series'})[0], 401)
        self.assertEqual(self.source.calls, [])
        token, _ = self.login()
        for query in ('order=unknown', 'genre=unknown', 'cursor=../secret', 'theme=' + 'x' * 81):
            self.assertEqual(self.request('/library?' + query, cookie=token)[0], 422)
        status, headers, body = self.request('/library', cookie=token)
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)['items']), 18)
        self.assertIn('private', headers['cache-control'])
        status, headers, body = self.request('/library/random', 'POST',
                                             {'genre': 'comic_series', 'order': 'latest', 'theme': '', 'exclude': ['1']},
                                             cookie=token)
        self.assertEqual(status, 200)
        self.assertNotEqual(json.loads(body)['item']['series_id'], '1')
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(self.request('/library/random', 'POST', {'exclude': ['bad']}, cookie=token)[0], 400)
        self.auth.logout(token)
        self.assertEqual(self.request('/library', cookie=token)[0], 401)


if __name__ == '__main__':
    unittest.main()
