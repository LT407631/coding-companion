import threading
import unittest
from unittest.mock import patch

from media_source import MediaSource, PermanentSourceError


def option(vid, size=100, definition="1080p"):
    return {"main_url": "https://example.invalid/" + vid, "video_meta": {"size": size, "definition": definition},
            "encrypt_info": {"encrypt": True, "spade_a": "test-only-key"}}


class Provider:
    def __init__(self):
        self.calls = []

    def get_video_tracks(self, vids, force=False):
        self.calls.append((list(vids), force))
        return {v: [option(v)] for v in vids}


class MediaSourceTests(unittest.TestCase):
    def test_five_episodes_reuse_one_batch_and_best_remains_largest(self):
        p = Provider()
        original = p.get_video_tracks
        def tracks(vids, force=False):
            values = original(vids, force)
            for v in vids:
                values[v].extend([option(v + "small", 10, "2160p"), option(v + "largest", 200, "720p")])
            return values
        p.get_video_tracks = tracks
        c = MediaSource(p)
        c.prefetch(["1", "2", "3", "4", "5"])
        self.assertEqual([c.track(str(v))["url"] for v in range(1, 6)],
                         ["https://example.invalid/" + str(v) + "largest" for v in range(1, 6)])
        self.assertEqual(c.track("1")["urls"], ["https://example.invalid/1largest"])
        self.assertEqual(c.track("1")["definition"], "720p")
        self.assertEqual(p.calls, [(["1", "2", "3", "4", "5"], False)])

    def test_direct_track_and_invalidation_force_only_failed_episode(self):
        p, c = Provider(), None
        c = MediaSource(p)
        c.prefetch(["1", "2"])
        c.invalidate("1")
        c.track("1"); c.track("2"); c.track("3")
        self.assertEqual(p.calls, [(["1", "2"], False), (["1"], True), (["3"], False)])

    def test_missing_member_falls_back_individually_and_siblings_survive(self):
        p = Provider()
        def tracks(vids, force=False):
            p.calls.append((list(vids), force))
            return {v: [option(v)] for v in vids if v != "2" or len(vids) == 1}
        p.get_video_tracks = tracks
        c = MediaSource(p)
        c.prefetch(["1", "2", "3"])
        self.assertEqual(p.calls, [(["1", "2", "3"], False)])
        for v in ("1", "2", "3"):
            self.assertTrue(c.track(v)["url"])
        self.assertEqual(p.calls, [(["1", "2", "3"], False), (["2"], False)])

    def test_future_missing_member_never_delays_current_with_fallback(self):
        p = Provider()
        def tracks(vids, force=False):
            p.calls.append((list(vids), force))
            if len(vids) == 1 and vids == ['2']:
                raise RuntimeError('future source would be slow')
            return {'1': [option('1')]}
        p.get_video_tracks = tracks
        c = MediaSource(p)
        c.prefetch(['1', '2'])
        self.assertTrue(c.track('1'))
        self.assertEqual(p.calls, [(['1', '2'], False)])

    def test_permanent_missing_track_does_not_poison_other_vid(self):
        p = Provider()
        p.get_video_tracks = lambda vids, force=False: {v: [option(v)] for v in vids if v != "2"}
        c = MediaSource(p)
        c.prefetch(["1", "2"])
        self.assertTrue(c.track("1"))
        with self.assertRaises(PermanentSourceError): c.track("2")

    def test_concurrent_same_vid_joins_batch_singleflight(self):
        entered, finish = threading.Event(), threading.Event()
        p = Provider()
        def tracks(vids, force=False):
            p.calls.append((list(vids), force)); entered.set()
            if not finish.wait(3): raise RuntimeError("test release missing")
            return {v: [option(v)] for v in vids}
        p.get_video_tracks = tracks
        c, results = MediaSource(p), []
        batch = threading.Thread(target=lambda: c.prefetch(["1", "2"]))
        batch.start(); self.assertTrue(entered.wait(1))
        reader = threading.Thread(target=lambda: results.append(c.track("1")))
        reader.start()
        self.assertEqual(results, [])
        finish.set(); batch.join(3); reader.join(3)
        self.assertEqual(len(results), 1)
        self.assertEqual(len(p.calls), 1)

    def test_invalidated_inflight_track_is_not_published(self):
        entered, finish = threading.Event(), threading.Event()
        p = Provider()
        def tracks(vids, force=False):
            p.calls.append((list(vids), force))
            if not force:
                entered.set()
                if not finish.wait(3): raise RuntimeError("test release missing")
            return {v: [option(v + ("fresh" if force else "old"))] for v in vids}
        p.get_video_tracks = tracks
        c, results = MediaSource(p), []
        reader = threading.Thread(target=lambda: results.append(c.track("1")))
        reader.start(); self.assertTrue(entered.wait(1)); c.invalidate("1"); finish.set(); reader.join(3)
        self.assertEqual(results[0]["url"], "https://example.invalid/1fresh")
        self.assertEqual(p.calls, [(["1"], False), (["1"], True)])

    def test_ttl_capacity_and_copy_do_not_leak_mutation(self):
        p, clock = Provider(), [1]
        with patch("media_source.time.monotonic", side_effect=lambda: clock[0]):
            c = MediaSource(p, ttl=10, capacity=2)
            c.track("1")["url"] = "bad"
            self.assertNotEqual(c.track("1")["url"], "bad")
            clock[0] = 12; c.track("1")
            self.assertEqual(len(p.calls), 2)
            c.track("2"); c.track("3")
            self.assertEqual(len(c.cache), 2)
            self.assertFalse(c.flights)

    def test_batch_limit_and_call_wrapper(self):
        p, wrappers = Provider(), []
        def call(fn):
            wrappers.append(True)
            return fn()
        c = MediaSource(p, call=call)
        c.prefetch([str(v) for v in range(10)])
        self.assertEqual(len(p.calls[0][0]), 5)
        self.assertEqual(len(wrappers), 1)


if __name__ == "__main__":
    unittest.main()
