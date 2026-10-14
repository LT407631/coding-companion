import hashlib
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException

from catalog_cache import CatalogCache, Payload
from search_pages import CHAIN_TTL, SearchPages, install_search
import test_site_auth as auth_fixture


def reply(ids, more=False, offset=0, **values):
    return {'search_tabs': [dict(data=[{'series_id': str(n), 'title': '剧集' + str(n)} for n in ids],
                                 has_more=more, next_offset=offset, **values)]}


class Source:
    namespace = 'public-host-app-version'

    def __init__(self):
        self.replies, self.calls = [], []
        self.guard = threading.Lock()
        self.started, self.release = None, None

    def _parse_search_cell(self, cell):
        return cell

    def api(self, method, path, extra_query):
        with self.guard:
            self.calls.append((method, path, dict(extra_query)))
            result = self.replies.pop(0)
        if self.started:
            self.started.set()
            self.release.wait(5)
        if isinstance(result, Exception):
            raise result
        return result


class SearchPageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = CatalogCache(self.tmp.name, workers=1)
        self.source = Source()
        self.search = SearchPages(self.source, self.cache)

    def tearDown(self):
        if self.source.release:
            self.source.release.set()
        self.cache.close()
        self.tmp.cleanup()

    def page(self, query='搜索', cursor=''):
        entry, state = self.search.page(query, cursor)
        return json.loads(entry.body), state

    def stale(self):
        with self.cache.guard:
            self.cache.db.execute("UPDATE entries SET checked=? WHERE key LIKE 'search-page-v1:%'", (time.time() - 601,))
            self.cache.db.commit()

    def drain_refresh(self):
        self.cache.pool.submit(lambda: None).result(timeout=5)

    def test_first_page_returns_immediately_and_does_not_fill_forty(self):
        self.source.replies = [reply([1, 2], True, 40, passback='public-passback', search_id='chain-search')]
        result, state = self.page('  搜索  ')
        self.assertEqual(state, 'MISS')
        self.assertEqual(result['query'], '搜索')
        self.assertEqual(len(result['results']), 2)
        self.assertTrue(result['has_more'])
        self.assertRegex(result['next_cursor'], r'^[a-f0-9]{64}$')
        self.assertEqual(len(self.source.calls), 1)
        self.assertEqual(self.source.calls[0][2]['count'], '0')
        self.assertEqual(self.page()[0], result)
        self.assertEqual(len(self.source.calls), 1)

    def test_deduplicates_across_pages_and_preserves_provider_pagination(self):
        self.source.replies = [reply([1, 1, 2], True, 40, passback='opaque', search_id='s1'), reply([2, 3])]
        first, _ = self.page()
        second, _ = self.page(cursor=first['next_cursor'])
        self.assertEqual([r['series_id'] for r in first['results']], ['1', '2'])
        self.assertEqual([r['series_id'] for r in second['results']], ['3'])
        self.assertFalse(second['has_more'])
        self.assertIsNone(second['next_cursor'])
        params = self.source.calls[1][2]
        self.assertEqual((params['offset'], params['passback'], params['search_id']), ('40', 'opaque', 's1'))
        self.assertEqual(self.source.calls[0][:2], ('GET', '/reading/bookapi/search/tab/v'))

    def test_empty_page_can_continue_without_eager_request(self):
        self.source.replies = [reply([], True, 40), reply([9])]
        first, _ = self.page()
        self.assertEqual(first['results'], [])
        self.assertTrue(first['has_more'])
        self.assertEqual(len(self.source.calls), 1)
        self.assertEqual(self.page(cursor=first['next_cursor'])[0]['results'][0]['series_id'], '9')

    def test_duplicate_page_can_continue_but_empty_streak_is_bounded(self):
        self.source.replies = [reply([1], True, 40), reply([1], True, 80), reply([1], True, 120), reply([1], True, 160)]
        result, _ = self.page()
        for _ in range(3):
            result, _ = self.page(cursor=result['next_cursor'])
        self.assertFalse(result['has_more'])
        self.assertEqual(len(self.source.calls), 4)

    def test_same_token_and_cycle_stop_without_looping(self):
        self.source.replies = [reply([1], True, 0)]
        self.assertFalse(self.page()[0]['has_more'])
        self.source.replies = [reply([1], True, 40), reply([2], True, 0)]
        first, _ = self.page('另一个')
        self.assertFalse(self.page('另一个', first['next_cursor'])[0]['has_more'])

    def test_passback_only_advance_is_valid(self):
        self.source.replies = [reply([1], True, 0, passback='p1')]
        self.assertTrue(self.page()[0]['has_more'])

    def test_page_count_is_bounded_without_cropping_results(self):
        self.source.replies = [reply(range(80), True, 80)]
        with patch('search_pages.MAX_PAGES', 1):
            result, _ = self.page()
        self.assertEqual(len(result['results']), 80)
        self.assertFalse(result['has_more'])

    def test_keywords_namespace_and_expired_cursor_are_isolated(self):
        self.source.replies = [reply([1], True, 40), reply([2], True, 40), reply([3], True, 40)]
        first, _ = self.page()
        self.assertEqual(self.page('其他')[0]['results'][0]['series_id'], '2')
        with self.assertRaises(HTTPException) as mismatch:
            self.page('其他', first['next_cursor'])
        self.assertEqual(mismatch.exception.status_code, 400)
        self.source.namespace = 'different-public-source'
        self.assertEqual(self.page()[0]['results'][0]['series_id'], '3')
        with self.assertRaises(HTTPException) as mismatch:
            self.page(cursor=first['next_cursor'])
        self.assertEqual(mismatch.exception.status_code, 400)
        self.source.namespace = 'public-host-app-version'
        with patch('search_pages.time.time', return_value=time.time() + CHAIN_TTL + 1):
            with self.assertRaises(HTTPException) as expired:
                self.page(cursor=first['next_cursor'])
        self.assertEqual(expired.exception.status_code, 410)

    def test_cache_and_cursor_survive_restart(self):
        self.source.replies = [reply([1], True, 40), reply([2])]
        first, _ = self.page()
        self.cache.close()
        self.cache = CatalogCache(self.tmp.name)
        self.search = SearchPages(self.source, self.cache)
        self.assertEqual(self.page()[1], 'HIT')
        self.assertEqual(self.page(cursor=first['next_cursor'])[0]['results'][0]['series_id'], '2')
        self.assertEqual(len(self.source.calls), 2)

    def test_same_key_concurrent_misses_reuse_one_request(self):
        self.source.replies = [reply([1])]
        self.source.started, self.source.release = threading.Event(), threading.Event()
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(self.page) for _ in range(8)]
            self.assertTrue(self.source.started.wait(2))
            self.source.release.set()
            results = [future.result(timeout=5)[0] for future in futures]
        self.assertTrue(all(value == results[0] for value in results))
        self.assertEqual(len(self.source.calls), 1)

    def test_stale_failure_returns_snapshot_and_does_not_retry_storm(self):
        self.source.replies = [reply([1], True, 40), RuntimeError('upstream unavailable')]
        first, _ = self.page()
        self.stale()
        self.assertEqual(self.page(), (first, 'STALE'))
        self.drain_refresh()
        self.assertEqual(self.page(), (first, 'STALE'))
        self.assertEqual(len(self.source.calls), 2)

    def test_stale_success_creates_new_head_but_old_cursor_keeps_old_chain(self):
        self.source.replies = [reply([1], True, 40, search_id='old'),
                               reply([10], True, 40, search_id='new'), reply([1, 2])]
        first, _ = self.page()
        self.stale()
        self.assertEqual(self.page(), (first, 'STALE'))
        self.drain_refresh()
        updated, _ = self.page()
        self.assertEqual(updated['results'][0]['series_id'], '10')
        self.assertNotEqual(first['next_cursor'], updated['next_cursor'])
        old_next, _ = self.page(cursor=first['next_cursor'])
        self.assertEqual([r['series_id'] for r in old_next['results']], ['2'])
        self.assertEqual(self.source.calls[-1][2]['search_id'], 'old')

    def test_clear_removes_page_and_cursor_and_inflight_refresh_cannot_restore_them(self):
        self.source.replies = [reply([1], True, 40), reply([2], True, 40)]
        first, _ = self.page()
        self.stale()
        self.source.started, self.source.release = threading.Event(), threading.Event()
        self.page()
        self.assertTrue(self.source.started.wait(2))
        self.assertEqual(self.cache.clear(), 2)
        self.source.release.set()
        self.drain_refresh()
        self.assertEqual(self.cache.db.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 0)
        with self.assertRaises(HTTPException) as missing:
            self.page(cursor=first['next_cursor'])
        self.assertEqual(missing.exception.status_code, 410)

    def test_invalid_query_and_cursor_rejected_before_upstream(self):
        for query in ('', ' ', 'x' * 101, 'a\n', '\0x', 'x\x7f', 'x\u202e', '\ud800'):
            with self.subTest(query=query), self.assertRaises(HTTPException):
                self.page(query)
        for cursor in ('../cache', 'a' * 63, 'A' * 64, 'a' * 64 + '\n', "' OR 1=1"):
            with self.subTest(cursor=cursor), self.assertRaises(HTTPException):
                self.page(cursor=cursor)
        self.assertEqual(self.source.calls, [])

    def test_public_namespace_fallback_excludes_credentials_and_tracks_app_version(self):
        self.source.namespace = None
        try:
            self.source.CFG = {'api_host': 'https://public.example',
                               'base_query': {'aid': '1', 'version_code': '2', 'token': 'secret-fixture'},
                               'token': 'secret-fixture'}
            self.source.replies = [reply([1], True, 40), reply([2])]
            first, _ = self.page()
            self.source.CFG['token'] = 'changed-secret'
            self.source.CFG['base_query']['token'] = 'changed-secret'
            self.assertEqual(self.page()[1], 'HIT')
            contents = b''.join(row[0] for row in self.cache.db.execute('SELECT body FROM entries'))
            self.assertNotIn(b'secret-fixture', contents)
            self.assertNotIn(b'changed-secret', contents)
            self.source.CFG['base_query']['version_code'] = '3'
            with self.assertRaises(HTTPException) as mismatch:
                self.page(cursor=first['next_cursor'])
            self.assertEqual(mismatch.exception.status_code, 400)
            self.assertEqual(self.page()[0]['results'][0]['series_id'], '2')
        finally:
            self.source.namespace = 'public-host-app-version'

    def test_missing_or_corrupted_cursor_cannot_reuse_other_entries(self):
        with self.assertRaises(HTTPException) as missing:
            self.page(cursor='0' * 64)
        self.assertEqual(missing.exception.status_code, 410)
        self.source.replies = [reply([1], True, 40)]
        first, _ = self.page()
        self.cache.db.execute('UPDATE entries SET body=? WHERE key=?', (b'{}', 'search-cursor-v1:' + first['next_cursor']))
        self.cache.db.commit()
        with self.assertRaises(HTTPException) as corrupt:
            self.page(cursor=first['next_cursor'])
        self.assertEqual(corrupt.exception.status_code, 410)

    def test_stale_following_page_preserves_chain_while_refreshing(self):
        self.source.replies = [reply([1], True, 40, search_id='s1'),
                               reply([2], True, 80), reply([2, 3], True, 80)]
        first, _ = self.page()
        second, _ = self.page(cursor=first['next_cursor'])
        self.stale()
        self.assertEqual(self.page(cursor=first['next_cursor']), (second, 'STALE'))
        self.drain_refresh()
        refreshed, state = self.page(cursor=first['next_cursor'])
        self.assertEqual(state, 'HIT')
        self.assertEqual([r['series_id'] for r in refreshed['results']], ['2', '3'])
        self.assertEqual(self.source.calls[-1][2]['offset'], '40')
        self.assertEqual(self.source.calls[-1][2]['search_id'], 's1')

    def test_expired_head_retains_results_but_never_returns_expired_continuation(self):
        self.source.replies = [reply([1], True, 40), RuntimeError('fixture outage')]
        original, _ = self.search.page('搜索')
        old_cursor = json.loads(original.body)['next_cursor']
        with patch('search_pages.time.time', return_value=time.time() + CHAIN_TTL + 1):
            entry, cache_state = self.search.page('搜索')
            self.assertEqual(cache_state, 'STALE')
            self.assertEqual(json.loads(entry.body), {'query': '搜索', 'results': [{'series_id': '1', 'title': '剧集1'}],
                                                     'has_more': False, 'next_cursor': None, 'restart_required': True})
            self.assertEqual(entry.etag, '"' + hashlib.sha256(entry.body).hexdigest() + '"')
            self.assertNotEqual(entry.etag, original.etag)
            with self.assertRaises(HTTPException) as expired:
                self.page(cursor=old_cursor)
            self.assertEqual(expired.exception.status_code, 410)
        self.drain_refresh()
        stored = self.cache.db.execute("SELECT body FROM entries WHERE key LIKE 'search-page-v1:%'").fetchone()[0]
        self.assertEqual(stored, original.body)

    def test_capacity_eviction_of_cursor_sanitizes_fresh_head_and_refreshes_in_background(self):
        self.cache.max_bytes = 1000
        self.source.replies = [reply([1], True, 40), reply([2], True, 80)]
        original, _ = self.search.page('搜索')
        old_cursor = json.loads(original.body)['next_cursor']
        # Preserve the newer head while the real capacity policy evicts its
        # older cursor. The returned snapshot must remain immediately usable.
        self.cache.put('unrelated-fixture', Payload(b'x' * (999 - len(original.body))))
        self.assertIsNone(self.cache.read('search-cursor-v1:' + old_cursor))
        self.source.started, self.source.release = threading.Event(), threading.Event()
        entry, cache_state = self.search.page('搜索')
        self.assertEqual(cache_state, 'HIT')
        self.assertTrue(json.loads(entry.body)['restart_required'])
        self.assertFalse(json.loads(entry.body)['has_more'])
        self.assertIsNone(json.loads(entry.body)['next_cursor'])
        self.assertEqual(entry.etag, '"' + hashlib.sha256(entry.body).hexdigest() + '"')
        self.assertTrue(self.source.started.wait(2))
        stored = self.cache.db.execute("SELECT body FROM entries WHERE key LIKE 'search-page-v1:%'").fetchone()[0]
        self.assertEqual(stored, original.body)
        self.source.release.set()
        self.drain_refresh()
        updated, _ = self.page()
        self.assertTrue(updated['has_more'])
        self.assertNotIn('restart_required', updated)
        self.assertEqual(updated['results'][0]['series_id'], '2')

    def test_missing_following_cursor_is_sanitized_without_rebasing_chain(self):
        self.source.replies = [reply([1], True, 40, search_id='old'), reply([2], True, 80),
                               RuntimeError('fixture outage')]
        first, _ = self.page()
        second, _ = self.page(cursor=first['next_cursor'])
        self.cache.db.execute('DELETE FROM entries WHERE key=?', ('search-cursor-v1:' + second['next_cursor'],))
        self.cache.db.commit()
        entry, _ = self.search.page('搜索', first['next_cursor'])
        page = json.loads(entry.body)
        self.assertEqual(page['results'], second['results'])
        self.assertTrue(page['restart_required'])
        self.assertFalse(page['has_more'])
        self.assertIsNone(page['next_cursor'])
        self.drain_refresh()
        self.assertEqual(self.source.calls[-1][2]['search_id'], 'old')
        self.assertEqual(self.source.calls[-1][2]['offset'], '40')

    def test_conditional_request_uses_sanitized_body_etag(self):
        self.source.replies = [reply([1], True, 40), RuntimeError('fixture outage')]
        original, _ = self.search.page('搜索')
        self.app = FastAPI()
        install_search(self.app, self.source, self.cache)
        path = '/search/page?' + urlencode({'q': '搜索'})
        with patch('search_pages.time.time', return_value=time.time() + CHAIN_TTL + 1):
            status, headers, body = auth_fixture.AuthTests.request(self, path, headers={'if-none-match': original.etag})
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)['restart_required'])
            self.assertEqual(headers['etag'], '"' + hashlib.sha256(body).hexdigest() + '"')
            self.drain_refresh()
            self.assertEqual(auth_fixture.AuthTests.request(self, path, headers={'if-none-match': headers['etag']})[0], 304)

    def test_invalid_upstream_fails_without_poisoning_cache(self):
        for index, data in enumerate(({}, {'search_tabs': {}}, {'code': 1}, {'search_tabs': [{'data': [], 'has_more': True, 'next_offset': -1}]})):
            self.source.replies = [data]
            with self.assertRaises(HTTPException) as failure:
                self.page('case' + str(index))
            self.assertEqual(failure.exception.status_code, 502)
        self.assertEqual(self.cache.db.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 0)

    def test_route_metadata_private_and_conditional_response(self):
        self.source.replies = [reply([1])]
        self.app = FastAPI()
        install_search(self.app, self.source, self.cache)
        self.app.add_api_route('/search', lambda: {'legacy': True})
        path = '/search/page?' + urlencode({'q': '搜索'})
        status, headers, body = auth_fixture.AuthTests.request(self, path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['results'][0]['series_id'], '1')
        self.assertIn('private', headers['cache-control'])
        self.assertEqual(headers['x-nas-cache'], 'MISS')
        self.assertIn('x-nas-updated', headers)
        self.assertEqual(auth_fixture.AuthTests.request(self, path, headers={'if-none-match': headers['etag']})[0], 304)
        self.assertEqual(auth_fixture.AuthTests.request(self, '/search')[2], b'{"legacy":true}')
        self.assertEqual(auth_fixture.AuthTests.request(self, '/search/page?' + urlencode({'q': 'a\n'}))[0], 400)
        self.assertEqual(auth_fixture.AuthTests.request(self, path + '&cursor=../cache')[0], 422)
        self.assertEqual(len(self.source.calls), 1)


if __name__ == '__main__':
    unittest.main()
