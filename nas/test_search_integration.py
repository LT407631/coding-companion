"""Exercise the real NAS assembly with a local source double, never real accounts."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from playback_cache import PlaybackCache
import test_site_auth as auth_tests


class NasIntegrationTests(unittest.TestCase):
    request = auth_tests.AuthTests.request

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        app = FastAPI()
        for route in ('/filters', '/rank', '/latest', '/browse', '/episodes'):
            app.add_api_route(route, lambda: {'rows': [], 'items': []})
        app.add_api_route('/search', lambda q='': {'results': [{'series_id': '999', 'title': q}]})
        self.calls = []
        def upstream(method, path, body=None, extra_query=None, **options):
            self.calls.append((path, extra_query))
            offset = int((extra_query or {}).get('offset', 0))
            return {'search_tabs': [{'data': [{'series_id': str(offset + 1),
                       'title': 'fixture', 'cover': '', 'episode_cnt': 2}],
                       'next_offset': offset + 1, 'has_more': offset < 1,
                       'search_id': 'fixture-session', 'passback': 'fixture-passback'}]}
        h = SimpleNamespace(OUT_DIR=str(root), CFG={'api_host': 'fixture.test', 'base_query': {}},
                            api=upstream, _parse_search_cell=lambda value: value,
                            get_episodes=lambda sid: ({'title': 'fixture'}, [{'index': 1, 'vid': '101'}]),
                            SG=SimpleNamespace(cache_key=lambda *args: repr(args), cache_set=lambda *args, **kw: None),
                            SIGN_SERVERS=[])
        server = SimpleNamespace(app=app, H=h, STREAM_CACHE=str(root / 'media'),
                                 OD=SimpleNamespace(), _IMG_HOSTS=('fixture.test',), _IMG_OK=False)
        original_cache = PlaybackCache
        def cache(*args, **options):
            options.update(start=False)
            return original_cache(*args, **options)
        spec = importlib.util.spec_from_file_location('nas_integration_fixture', Path(__file__).with_name('nas_server.py'))
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'server': server}), patch('playback_cache.PlaybackCache', cache):
            spec.loader.exec_module(self.module)
        self.app = self.module.app
        self.auth = self.module.site_auth
        self.assertTrue(self.auth.setup(self.auth.initialize(), 'fixture-password'))
        self.cookie = self.auth.login('fixture-password')

    def tearDown(self):
        self.module.catalog.close()
        self.tmp.cleanup()

    def test_private_search_paging_and_legacy_contract(self):
        # Compatibility behavior remains testable but is no longer production's source policy.
        self.assertTrue(self.module.search_pages.website_only)
        self.module.search_pages.website_only = False
        self.assertEqual(self.request('/search/page?q=fixture')[0], 401)
        status, headers, raw = self.request('/search/page?q=fixture', cookie=self.cookie)
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(data['has_more'])
        self.assertIn('private', headers['cache-control'])
        self.assertIn('search;dur=', headers['server-timing'])
        self.assertEqual(self.request('/search/page?q=fixture', cookie=self.cookie)[0], 200)
        self.assertEqual(len(self.calls), 1)
        next_path = '/search/page?q=fixture&cursor=' + data['next_cursor']
        status, _, raw = self.request(next_path, cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)['results'][0]['series_id'], '2')
        self.assertEqual(self.calls[1][1]['search_id'], 'fixture-session')
        _, _, legacy = self.request('/search?q=old', cookie=self.cookie)
        self.assertEqual(json.loads(legacy)['results'][0]['series_id'], '999')

    def test_performance_assets_and_stream_still_require_session(self):
        for path in ('/performance', '/ui/assets/search.js', '/ui/assets/playback-status.js', '/stream?vid=101'):
            self.assertEqual(self.request(path)[0], 401)
        status, headers, raw = self.request('/performance', cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {'phases': {}})
        self.assertEqual(headers['cache-control'], 'no-store')
        for name in ('search.js', 'playback-status.js'):
            self.assertEqual(self.request('/ui/assets/' + name, cookie=self.cookie)[0], 200)

    def test_bad_cursor_and_query_do_not_reach_upstream(self):
        for path in ('/search/page?q=', '/search/page?q=x&cursor=evil', '/search/page?q=x%00y'):
            self.assertIn(self.request(path, cookie=self.cookie)[0], (400, 422))
        self.assertEqual(self.calls, [])

    def test_seasons_use_bounded_source_and_existing_web_fallback(self):
        cache = self.module.season_cache
        self.assertIsInstance(cache.fallback, self.module.HongguoWebSearch)
        self.assertTrue(cache.website_only)
        data = {'items': [{'series_id': '1', 'season': 1}], 'partial': True}
        with patch.object(cache, 'get', return_value=data) as lookup:
            self.assertEqual(self.request('/seasons?series_id=1')[0], 401)
            status, _, body = self.request('/seasons?series_id=1', cookie=self.cookie)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), data)
            lookup.assert_called_once_with(self.module.source, '1', refresh=False, search_hint='')

    def test_production_search_calls_only_website(self):
        fallback = self.module.search_pages.fallback
        with patch.object(fallback, 'search', return_value=[{'series_id': '123', 'title': '官网结果'}]) as search:
            for query in ('one', 'two'):
                status, _, raw = self.request('/search/page?q=' + query, cookie=self.cookie)
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(raw)['source_fallback'])
            self.assertEqual(search.call_count, 2)
        self.assertEqual(self.calls, [])
