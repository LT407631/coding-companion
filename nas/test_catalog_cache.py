import tempfile
import threading
import time
import unittest
from pathlib import Path

from catalog_cache import CatalogCache, Payload, json_bytes, request_key, not_modified


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = CatalogCache(self.tmp.name, max_bytes=4096)
        self.calls = 0

    def tearDown(self):
        self.cache.close()
        self.tmp.cleanup()

    def load(self, previous):
        self.calls += 1
        return Payload(json_bytes({'items': [1]}))

    def wait_refresh(self):
        for _ in range(100):
            with self.cache.guard:
                if not self.cache.pending:
                    return
            time.sleep(.005)
        self.fail('background refresh did not finish')

    def test_restart_retains_cache(self):
        a, state = self.cache.get('rank:hot', self.load, 1800)
        self.assertEqual(state, 'MISS')
        self.cache.close()
        self.cache = CatalogCache(self.tmp.name)
        b, state = self.cache.get('rank:hot', self.load, 1800)
        self.assertEqual((a.body, a.etag), (b.body, b.etag))
        self.assertEqual((self.calls, state), (1, 'HIT'))

    def test_cold_concurrent_requests_download_once(self):
        started, release = threading.Event(), threading.Event()
        def load(previous):
            self.calls += 1
            started.set(); release.wait(2)
            return Payload(b'good')
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.cache.get('image:x', load, 100))) for _ in range(5)]
        for t in threads: t.start()
        self.assertTrue(started.wait(1)); release.set()
        for t in threads: t.join(3)
        self.assertEqual(self.calls, 1)
        self.assertEqual(len(results), 5)
        self.assertTrue(all(r[0].body == b'good' for r in results))

    def test_stale_returns_immediately_refresh_is_single_flight(self):
        self.cache.get('x', self.load, 60)
        started, release = threading.Event(), threading.Event()
        def slow(previous):
            started.set(); release.wait(2)
            return Payload(b'new')
        start = time.monotonic()
        a, state = self.cache.get('x', slow, 0)
        self.assertLess(time.monotonic()-start, .1)
        self.assertEqual((a.body, state), (json_bytes({'items':[1]}), 'STALE'))
        self.assertTrue(started.wait(1))
        self.cache.get('x', slow, 0)
        self.assertEqual(len(self.cache.pending), 1)
        release.set(); self.wait_refresh()
        self.assertEqual(self.cache.read('x').body, b'new')

    def test_unchanged_body_retains_etag_and_updated_time(self):
        a, _ = self.cache.get('x', self.load, 100)
        b = self.cache.put('x', Payload(json_bytes({'items':[1]})), a)
        self.assertEqual((a.etag,a.updated,a.body),(b.etag,b.updated,b.body))
        self.assertGreaterEqual(b.checked,a.checked)

    def test_source_304_retains_body(self):
        a = self.cache.put('x', Payload(b'jpeg', 'image/jpeg', 'source-etag', 'modified'))
        b = self.cache.put('x', None, a)
        self.assertEqual((b.body,b.etag,b.source_etag), (a.body,a.etag,'source-etag'))

    def test_refresh_failure_preserves_snapshot_and_backoff(self):
        a, _ = self.cache.get('x', self.load, 100)
        def failed(previous):
            raise RuntimeError('upstream failed')
        self.cache.get('x', failed, 0);self.wait_refresh()
        self.assertEqual(self.cache.read('x').body, a.body)
        self.assertFalse(self.cache.refresh('x', failed))
        self.assertFalse(self.cache.pending)

    def test_cold_failure_not_cached(self):
        def failed(previous):
            self.calls += 1
            raise RuntimeError('upstream failed')
        with self.assertRaises(RuntimeError):self.cache.get('x', failed, 100)
        with self.assertRaises(RuntimeError):self.cache.get('x', failed, 100)
        self.assertIsNone(self.cache.read('x'));self.assertEqual(self.calls, 1)

    def test_capacity_evicts_only_old_catalog_entries(self):
        self.cache.max_bytes = 10
        self.cache.put('old', Payload(b'123456'))
        self.cache.put('new', Payload(b'123456'))
        self.assertIsNone(self.cache.read('old'))
        self.assertIsNotNone(self.cache.read('new'))
        self.assertTrue(Path(self.tmp.name,'cache.sqlite3').exists())

    def test_key_normalization_and_refresh_not_part_of_identity(self):
        a=request_key('/latest', {'genre':'comic_series','limit':12,'refresh':False,'no_cache':False})
        b=request_key('/latest', {'refresh':True,'limit':12,'genre':'comic_series'})
        self.assertEqual(a,b)
        self.assertNotEqual(a,request_key('/latest', {'genre':'ai_series','limit':12}))
        self.assertNotEqual(a,request_key('/rank', {'genre':'comic_series','limit':12}))

    def test_conditional_etag_matches_weak_multiple_and_wildcard(self):
        self.assertTrue(not_modified('W/"123"', '"123"'))
        self.assertTrue(not_modified('"other", "123"', '"123"'))
        self.assertTrue(not_modified('*', '"123"'))
        self.assertFalse(not_modified('"other"', '"123"'))
        self.assertFalse(not_modified(None, '"123"'))

    def test_invalid_body_not_stored(self):
        with self.assertRaises(ValueError):self.cache.put('x', Payload(b''))
        self.assertIsNone(self.cache.read('x'))

    def test_clear_removes_entries_and_rejects_old_refresh(self):
        self.cache.put('x', Payload(b'old'))
        started, release = threading.Event(), threading.Event()
        def slow(previous):
            started.set(); release.wait(2); return Payload(b'new')
        self.cache.get('x', slow, 0); self.assertTrue(started.wait(1))
        self.assertEqual(self.cache.clear(), 1); release.set()
        self.cache.pool.shutdown(wait=True)
        self.assertIsNone(self.cache.read('x'))
        self.assertFalse(self.cache.pending)

    def test_clear_during_cold_load_does_not_resurrect_cache(self):
        started, release = threading.Event(), threading.Event()
        results = []
        def slow(previous):
            started.set(); release.wait(2); return Payload(b'old-flight')
        worker = threading.Thread(target=lambda: results.append(self.cache.get('x', slow, 100)))
        worker.start(); self.assertTrue(started.wait(1)); self.cache.clear(); release.set(); worker.join(3)
        self.assertEqual(results[0][0].body, b'old-flight')
        self.assertIsNone(self.cache.read('x'))
        self.cache.get('x', self.load, 100); self.assertIsNotNone(self.cache.read('x'))


if __name__ == '__main__':unittest.main()
