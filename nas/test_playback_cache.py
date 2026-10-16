import ast
import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from playback_cache import PlaybackCache
from media_source import MediaSource, PermanentSourceError
from source_requests import SourceTimeout

EPS = [{"index": n, "vid": str(1000 + n)} for n in range(1, 12)]


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'cache'
        self.calls = []
        def build(vid, stage):
            self.calls.append(vid)
            stage.write_bytes(b'valid-media')
        self.build = build
        self.make = lambda build=build: PlaybackCache(self.root, build, validate=lambda p: p.read_bytes() == b'valid-media', start=False, reserve=0)
        self.c = self.make()

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_video_waits_for_atomic_publish(self):
        started, finish = threading.Event(), threading.Event()
        def build(vid, stage):
            stage.write_bytes(b'partial')
            started.set()
            finish.wait(3)
            stage.write_bytes(b'valid-media')
        c = self.make(build)
        results = []
        a = threading.Thread(target=lambda: results.append(c.ensure('1001')))
        b = threading.Thread(target=lambda: results.append(c.ensure('1001')))
        a.start(); self.assertTrue(started.wait(2)); b.start()
        self.assertFalse(c.path('1001').exists())
        self.assertEqual(results, [])
        finish.set(); a.join(3); b.join(3)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].read_bytes(), b'valid-media')
        self.assertEqual(list(c.root.glob('*.work*')), [])

    def test_failed_remux_never_becomes_cache(self):
        def build(vid, stage):
            stage.write_bytes(b'partial')
            raise RuntimeError('remux failed')
        c = self.make(build)
        with patch('playback_cache.time.sleep'), self.assertRaises(RuntimeError):
            c.ensure('1001')
        self.assertFalse(c.path('1001').exists())
        self.assertEqual(list(c.root.iterdir()), [])

    def test_manual_quality_has_an_independent_bounded_cache_key(self):
        auto = self.c.ensure('1001')
        manual = self.c.ensure('1001q720')
        self.assertNotEqual(auto, manual)
        self.assertEqual(self.calls, ['1001', '1001q720'])
        self.assertEqual(manual.name, '1001q720_best.mp4')
        with self.assertRaisesRegex(ValueError, '视频编号无效'):
            self.c.path('1001q2160')

    def test_clear_all_removes_manual_quality_cache(self):
        path = self.c.ensure('1001q480')
        self.assertTrue(path.exists())
        self.c.clear_all()
        self.assertFalse(path.exists())

    def test_old_corrupt_cache_is_rebuilt_and_good_cache_reused(self):
        self.c.path('1001').write_bytes(b'partial')
        self.c.ensure('1001'); self.c.ensure('1001')
        self.assertEqual(self.calls, ['1001'])

    def test_ahead_dedup_priority_and_sliding_window(self):
        self.c.prepare('viewer-one', '2001', EPS, 1)
        self.c.prepare('viewer-one', '2001', EPS, 1)
        self.assertEqual(len(self.c.jobs), 6)
        self.c.prepare('viewer-one', '2001', EPS, 5)
        self.assertEqual(set(k[1] for k in self.c.jobs), set(range(5, 11)))
        self.assertEqual(min(self.c.jobs, key=lambda k: self.c.jobs[k][:2]), ('2001', 5))

    def test_smart_requires_completed_threshold(self):
        self.c.configure({**self.c.settings, 'mode': 'smart', 'ahead': 3})
        self.c.prepare('viewer-one', '2001', EPS, 3, 2)
        self.assertEqual(len(self.c.jobs), 4)
        self.c.prepare('viewer-one', '2001', EPS, 4, 3)
        self.assertEqual(set(k[1] for k in self.c.jobs), set(range(4, 12)))

    def test_off_still_prepares_current(self):
        self.c.configure({**self.c.settings, 'mode': 'off'})
        self.c.prepare('viewer-one', '2001', EPS, 7)
        self.assertEqual(list(self.c.jobs), [('2001', 7)])

    def test_random_preview_only_queues_current_episode(self):
        self.c.configure({**self.c.settings, 'mode': 'full'})
        status = self.c.prepare('preview-user', '2001', EPS, 3, preview=True)
        self.assertEqual(status['queued'], 1)
        self.assertEqual(self.c.sessions['preview-user']['wanted'], {3})
        self.assertTrue(self.c.sessions['preview-user']['preview'])

    def test_random_pool_background_is_low_priority_and_foreground_upgrades_it(self):
        self.c.prepare('pool-user', '2001', EPS, 3, preview=True, background=True)
        self.assertEqual(self.c.jobs[('2001', 3)][0], 2)
        self.assertTrue(self.c.sessions['pool-user']['background'])
        self.assertGreater(self.c.sessions['pool-user']['until'] - time.monotonic(), 500)
        self.c.prepare('viewer-one', '2001', EPS, 3, preview=True)
        self.assertEqual(self.c.jobs[('2001', 3)][0], 0)
        self.assertFalse(self.c.results[('2001', 3)]['background'])

    def test_foreground_retries_a_failed_background_preview_only(self):
        self.c.prepare('pool-user', '2001', EPS, 2, preview=True, background=True)
        self.c.jobs.pop(('2001', 2))
        self.c.results[('2001', 2)] = {'state': 'error', 'background': True}
        self.c.prepare('viewer-one', '2001', EPS, 2, preview=True)
        self.assertEqual(self.c.results[('2001', 2)]['state'], 'queued')
        self.assertEqual(self.c.jobs[('2001', 2)][0], 0)

    def test_settings_and_series_persist(self):
        self.c.configure({**self.c.settings, 'ahead': 3, 'mode': 'full'})
        self.c.prepare('viewer-one', '2001', EPS, 1)
        c = self.make()
        self.assertEqual(c.settings['ahead'], 3)
        self.assertEqual(c.series, self.c.series)
        self.assertFalse(c.jobs)

    def test_cleanup_waits_for_other_viewer_and_stream_then_only_own_files(self):
        self.c.prepare('viewer-one', '2001', EPS, 11)
        self.c.prepare('viewer-two', '2001', EPS, 10)
        path = self.c.ensure('1011')
        manual = self.root.parent / 'manual.mp4'; manual.write_bytes(b'keep')
        other = self.c.ensure('9999')
        self.c.acquire('1011')
        self.c.close('viewer-one', True)
        self.assertTrue(path.exists())
        self.c.close('viewer-two')
        self.assertTrue(path.exists())
        self.c.release('1011')
        self.assertFalse(path.exists())
        self.assertTrue(manual.exists()); self.assertTrue(other.exists())
        self.assertFalse(self.c.jobs)

    def test_late_heartbeat_cannot_reopen_closed_viewer(self):
        self.c.prepare('viewer-one', '2001', EPS, 1)
        self.c.close('viewer-one')
        self.c.prepare('viewer-one', '2001', EPS, 2)
        self.assertNotIn('viewer-one', self.c.sessions)

    def test_cleanup_disabled_and_session_expiry(self):
        self.c.configure({**self.c.settings, 'cleanup': False})
        self.c.prepare('viewer-one', '2001', EPS, 11)
        path = self.c.ensure('1011')
        self.c.close('viewer-one', True)
        self.assertTrue(path.exists())
        self.c.prepare('viewer-new', '2001', EPS, 2)
        self.c.sessions['viewer-new']['until'] = 0
        self.assertEqual(list(self.c._active()), [])

    def test_disk_reserve_stops_download(self):
        with patch('playback_cache.shutil.disk_usage', return_value=type('Disk', (), {'free': 0})()), self.assertRaisesRegex(RuntimeError, '容量不足'):
            self.c.ensure('1001')
        self.assertFalse(self.calls)

    def test_stream_disconnect_releases_cleanup_lease(self):
        source = ast.parse(Path(__file__).with_name('nas_server.py').read_text())
        definition = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'LeasedFileResponse')
        released = []
        class Response:
            def __init__(self, *args, **kwargs):
                pass
            async def __call__(self, *args):
                raise OSError('client disconnected')
        class Cache:
            def release(self, vid):
                released.append(vid)
        namespace = {'FileResponse': Response, 'playback': Cache()}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), 'response', 'exec'), namespace)
        with self.assertRaises(OSError):
            asyncio.run(namespace['LeasedFileResponse']('file.mp4', '1001')({}, None, None))
        self.assertEqual(released, ['1001'])

    def test_failed_job_can_be_retried_explicitly(self):
        self.c.prepare('viewer-one', '2001', EPS, 1)
        self.c.jobs.pop(('2001', 1))
        self.c.results[('2001', 1)] = {'state': 'error'}
        self.c.prepare('viewer-one', '2001', EPS, 1)
        self.assertNotIn(('2001', 1), self.c.jobs)
        self.c.prepare('viewer-one', '2001', EPS, 1, retry=True)
        self.assertEqual(self.c.results[('2001', 1)]['state'], 'queued')

    def test_dynamic_cleanup_includes_finished_and_previous_keeps_future(self):
        self.c.configure({**self.c.settings, 'cleanup_previous': True})
        self.c.prepare('viewer-one', '2001', EPS, 3)
        paths = [self.c.ensure(str(1000+n)) for n in range(1, 6)]
        self.c.complete('viewer-one', 3)
        self.assertFalse(any(p.exists() for p in paths[:3]))
        self.assertTrue(all(p.exists() for p in paths[3:]))
        self.c.prepare('viewer-one', '2001', EPS, 3)
        self.assertNotIn(('2001', 3), self.c.jobs, 'late heartbeat must not re-cache ended episode')
        self.c.prepare('viewer-one', '2001', EPS, 3, retry=True)
        self.assertIn(('2001', 3), self.c.jobs, 'explicit replay must work')

    def test_dynamic_cleanup_waits_for_other_viewer_and_file_lease(self):
        self.c.configure({**self.c.settings, 'cleanup_previous': True, 'mode': 'off'})
        self.c.prepare('viewer-one', '2001', EPS, 3)
        self.c.prepare('viewer-two', '2001', EPS, 2)
        paths = [self.c.ensure(str(1000+n)) for n in range(1, 4)]
        self.c.acquire('1003')
        self.c.complete('viewer-one', 3)
        self.assertFalse(paths[0].exists()); self.assertTrue(paths[1].exists()); self.assertTrue(paths[2].exists())
        self.c.close('viewer-two'); self.assertFalse(paths[1].exists())
        self.c.release('1003'); self.assertFalse(paths[2].exists())

    def test_manual_switch_does_not_clean_and_invalid_complete_rejected(self):
        self.c.configure({**self.c.settings, 'cleanup_previous': True})
        self.c.prepare('viewer-one', '2001', EPS, 1)
        path = self.c.ensure('1001')
        self.c.prepare('viewer-one', '2001', EPS, 5)
        self.assertTrue(path.exists())
        with self.assertRaises(ValueError): self.c.complete('viewer-one', 1)
        self.assertTrue(path.exists())

    def test_clear_all_cancels_queue_keeps_current_until_release(self):
        self.c.prepare('viewer-one', '2001', EPS, 3)
        current = self.c.ensure('1003'); other = self.c.ensure('9999')
        manual = self.root.parent / 'manual.mp4'; manual.write_bytes(b'keep')
        self.c.acquire('1003')
        result = self.c.clear_all()
        self.assertEqual(result['deferred_videos'], 1)
        self.assertTrue(current.exists()); self.assertFalse(other.exists()); self.assertTrue(manual.exists())
        self.assertFalse(self.c.jobs)
        self.c.prepare('viewer-one', '2001', EPS, 3)
        self.assertFalse(self.c.jobs, 'heartbeat must not restart cancelled ahead queue')
        self.c.close('viewer-one'); self.assertTrue(current.exists())
        self.c.release('1003'); self.assertFalse(current.exists())
        self.c.prepare('viewer-new', '2001', EPS, 4)
        self.assertGreater(len(self.c.jobs), 1)

    def test_clear_all_invalidates_inflight_background_publication(self):
        started, finish = threading.Event(), threading.Event()
        errors = []
        def build(vid, stage):
            started.set(); finish.wait(3); stage.write_bytes(b'valid-media')
        c = self.make(build)
        def run():
            try: c.ensure('1001', foreground=False, generation=0)
            except RuntimeError as exc: errors.append(str(exc))
        worker = threading.Thread(target=run); worker.start()
        self.assertTrue(started.wait(1)); c.clear_all(); finish.set(); worker.join(3)
        self.assertEqual(errors, ['缓存任务已取消']); self.assertFalse(c.path('1001').exists())
        self.assertFalse(list(c.root.glob('*.work*')))

    def test_deferred_cleanup_persists_across_restart(self):
        self.c.prepare('viewer-one', '2001', EPS, 1)
        path = self.c.ensure('1001'); self.c.clear_all()
        self.assertTrue(path.exists())
        restarted = self.make(); restarted.status()
        self.assertFalse(path.exists())
        self.assertFalse(restarted.settings['cleanup_previous'])

    def test_dynamic_mode_cleans_entire_season_at_final_episode(self):
        self.c.configure({**self.c.settings, 'cleanup_previous': True, 'cleanup': False})
        self.c.prepare('viewer-one', '2001', EPS, 11)
        path = self.c.ensure('1001'); self.c.close('viewer-one', True)
        self.assertFalse(path.exists())

    def test_season_cache_clear_ignores_old_background_write(self):
        from seasons import SeasonCache
        c = SeasonCache(self.root.parent / 'seasons.json')
        data = {'album_id': '1', 'items': [{'series_id': '2001'}]}
        c.put('2001', data); generation = c._generation; c.clear()
        c.put('2001', data, generation)
        self.assertFalse(c.path.exists()); self.assertFalse(c._groups)
        c.put('2001', data, c._generation); self.assertTrue(c.path.exists())

    def start_workers(self, cache, foreground=True):
        stop = threading.Event()
        original_wait = cache.guard.wait
        class Stopped(BaseException):
            pass
        def wait(timeout=None):
            if stop.is_set(): raise Stopped()
            result = original_wait(timeout)
            if stop.is_set(): raise Stopped()
            return result
        cache.guard.wait = wait
        def run(current_only):
            try: cache._worker(current_only)
            except Stopped: pass
        workers = [threading.Thread(target=run, args=(False,))]
        if foreground: workers.append(threading.Thread(target=run, args=(True,)))
        for worker in workers: worker.start()
        def finish():
            with cache.guard:
                stop.set(); cache.jobs.clear(); cache.sessions.clear(); cache.guard.notify_all()
            for worker in workers:
                worker.join(3)
                self.assertFalse(worker.is_alive())
        return finish

    def test_track_batch_runs_in_worker_not_prepare_and_downloads_reuse_it(self):
        calls = []
        class Provider:
            def get_video_tracks(self, vids, force=False):
                calls.append(list(vids))
                return {v: [{'main_url': 'test:' + v,
                             'video_meta': {'size': 100, 'definition': '1080p'}}] for v in vids}
        source = MediaSource(Provider())
        def build(vid, stage):
            self.assertEqual(source.track(vid)['url'], 'test:' + vid)
            stage.write_bytes(b'valid-media')
        cache = PlaybackCache(self.root, build, validate=lambda p: True, reserve=0,
                              start=False, prepare_tracks=source.prefetch)
        cache.configure({**cache.settings, 'ahead': 4})
        cache.prepare('viewer-one', '2001', EPS, 1)
        self.assertEqual(calls, [])
        finish = self.start_workers(cache, foreground=False)
        try:
            with cache.guard:
                self.assertTrue(cache.guard.wait_for(lambda: cache.results.get(('2001', 5), {}).get('state') == 'ready', 3))
            self.assertEqual(calls, [['1001', '1002', '1003', '1004', '1005']])
        finally: finish()

    def test_jump_current_finishes_while_ahead_download_is_blocked(self):
        background, release = threading.Event(), threading.Event()
        calls = []
        def build(vid, stage):
            calls.append(vid)
            if vid == '1002':
                background.set()
                if not release.wait(3): raise RuntimeError('test release missing')
            stage.write_bytes(b'valid-media')
        cache = PlaybackCache(self.root, build, validate=lambda p: True, start=False,
                              reserve=0, foreground_worker=True)
        cache.prepare('viewer-one', '2001', EPS, 1)
        finish = self.start_workers(cache)
        try:
            self.assertTrue(background.wait(1))
            cache.prepare('viewer-one', '2001', EPS, 7)
            with cache.guard:
                self.assertTrue(cache.guard.wait_for(lambda: cache.results.get(('2001', 7), {}).get('state') == 'ready', 1))
            self.assertFalse(release.is_set())
            self.assertEqual(calls[:3], ['1001', '1002', '1007'])
            cache.acquire('1007')
            cache.clear_all(); cache.close('viewer-one', finished=True)
            self.assertTrue(cache.path('1007').exists())
            release.set()
            with cache.guard:
                self.assertTrue(cache.guard.wait_for(lambda: not cache.inflight, 3))
            self.assertFalse(cache.path('1002').exists())
            self.assertTrue(cache.path('1007').exists())
            cache.release('1007')
            self.assertFalse(cache.path('1007').exists())
        finally:
            release.set(); finish()

    def test_two_slots_and_same_video_still_download_once(self):
        entered, release, third_entered = threading.Event(), threading.Event(), threading.Event()
        count, calls, results, errors = [0], [], [], []
        def build(vid, stage):
            with cache.guard:
                calls.append(vid); count[0] += 1
                if count[0] == 2: entered.set()
                if count[0] == 3: third_entered.set()
            if not release.wait(3): raise RuntimeError('test release missing')
            stage.write_bytes(b'valid-media')
        cache = PlaybackCache(self.root, build, validate=lambda p: True, start=False,
                              reserve=0, foreground_worker=True)
        def run(vid):
            try: results.append(cache.ensure(vid))
            except Exception as exc: errors.append(exc)
        workers = [threading.Thread(target=run, args=(v,)) for v in ['1001', '1001', '1002', '1003']]
        for worker in workers: worker.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertFalse(third_entered.is_set())
            self.assertEqual(list(cache.root.glob('*_best.mp4')), [])
        finally:
            release.set()
            for worker in workers: worker.join(3)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 4)
        self.assertEqual(sorted(calls), ['1001', '1002', '1003'])
        self.assertEqual(cache.writers, set()); self.assertEqual(cache.reservations, {})
        self.assertEqual(list(cache.root.glob('*.work*')), [])

    def test_disk_reservations_do_not_allow_second_writer_to_overcommit(self):
        started, release = threading.Event(), threading.Event()
        def build(vid, stage):
            started.set()
            if not release.wait(3): raise RuntimeError('test release missing')
            stage.write_bytes(b'valid-media')
        cache = PlaybackCache(self.root, build, validate=lambda p: True, start=False,
                              reserve=0, foreground_worker=True)
        errors = []
        def run():
            try: cache.ensure('1001')
            except Exception as exc: errors.append(exc)
        with patch('playback_cache.shutil.disk_usage', return_value=type('Disk', (), {'free': 100 * 1024**2})()):
            worker = threading.Thread(target=run); worker.start()
            try:
                self.assertTrue(started.wait(1))
                with self.assertRaisesRegex(RuntimeError, '容量不足'): cache.ensure('1002')
                self.assertEqual(set(cache.reservations), {'1001'})
            finally: release.set(); worker.join(3)
        self.assertEqual(errors, [])

    def test_permanent_source_error_is_not_retried(self):
        def build(vid, stage):
            self.calls.append(vid)
            stage.write_bytes(b'partial')
            raise PermanentSourceError('no playable source')
        cache = self.make(build)
        with patch('playback_cache.time.sleep') as sleep, self.assertRaises(PermanentSourceError): cache.ensure('1001')
        self.assertEqual(self.calls, ['1001']); sleep.assert_not_called()
        self.assertFalse(list(cache.root.glob('*.work*')))

    def test_source_budget_failure_is_not_repeated_by_download_retry(self):
        def build(vid, stage):
            self.calls.append(vid)
            raise SourceTimeout('track budget exhausted')
        cache = self.make(build)
        with patch('playback_cache.time.sleep') as sleep, self.assertRaises(SourceTimeout): cache.ensure('1001')
        self.assertEqual(self.calls, ['1001']); sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
