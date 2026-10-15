import unittest
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from seasons import get_seasons, SeasonCache


class FakePlatform:
    def __init__(self, videos, pages):
        self.videos, self.pages, self.calls = videos, pages, []
        self.cache = {}
        self.SG = SimpleNamespace(cache_key=lambda *args: args,
                                  cache_get=self.cache.get,
                                  cache_set=lambda key, value, ttl: self.cache.__setitem__(key, value))

    def _episodes_body(self, ids):
        return ids

    def _parse_search_cell(self, cell):
        return cell

    def api(self, method, path, body=None, extra_query=None):
        self.calls.append((method, body, extra_query))
        if method == "POST":
            return {"data": {sid: {"video_data": self.videos[sid]}
                             for sid in body.split(",") if sid in self.videos}}
        return {"search_tabs": [self.pages[int(extra_query["offset"])]]}


def video(title, season, album="original"):
    return {"series_title": title, "season_index": season, "related_album_id": album,
            "episode_cnt": 20}


def row(sid, title):
    return {"series_id": sid, "title": title}


class SeasonsTests(unittest.TestCase):
    def test_empty_legacy_body_uses_fallback_and_verifies_album(self):
        h = FakePlatform({'1': video('黑蛋第一季', 1),
                          '2': video('黑蛋第二季', 2),
                          '3': video('黑蛋第二季', 2, 'another')}, {})
        original = h.api
        def api(method, *args, **kwargs):
            if method == 'GET':
                raise ValueError('Expecting value: empty response')
            return original(method, *args, **kwargs)
        h.api = api
        fallback = SimpleNamespace(search=lambda query: [row('2', '黑蛋第二季'), row('3', '黑蛋第二季')])
        result = get_seasons(h, '1', fallback=fallback)
        self.assertEqual([item['series_id'] for item in result['items']], ['1', '2'])
        self.assertTrue(result['partial'], 'Suggestion results cannot prove all seasons were found')

    def test_empty_or_invalid_legacy_page_uses_fallback(self):
        for payload in ({'search_tabs': []}, {'code': 110001}, {'search_tabs': [{'data': None}]}):
            with self.subTest(payload=payload):
                h = FakePlatform({'1': video('故事第一季', 1), '2': video('故事第二季', 2)}, {})
                api = h.api
                h.api = lambda method, *args, **kw: payload if method == 'GET' else api(method, *args, **kw)
                calls = []
                def search(query):
                    calls.append(query)
                    return [row('2', '故事第二季')]
                result = get_seasons(h, '1', search_hint='原著', fallback=SimpleNamespace(search=search))
                self.assertEqual([item['season'] for item in result['items']], [1, 2])
                self.assertEqual(calls, ['原著'])

    def test_later_page_failure_keeps_verified_candidates_and_uses_fallback(self):
        h = FakePlatform({'1': video('故事第一季', 1), '2': video('故事第二季', 2),
                          '3': video('故事第三季', 3)},
                         {0: {'data': [row('2', '故事第二季')], 'has_more': True, 'next_offset': 1}})
        fallback = SimpleNamespace(search=lambda query: [row('3', '故事第三季')])
        result = get_seasons(h, '1', fallback=fallback)
        self.assertEqual([item['season'] for item in result['items']], [1, 2, 3])
        self.assertTrue(result['partial'])

    def test_plain_title_search_accepts_punctuation_variants(self):
        h = FakePlatform({"1": video("长生狱主，一念镇九幽", 1),
                          "2": video("长生狱主一念镇九幽第二季", 2)},
                         {0: {"data": [row("2", "长生狱主一念镇九幽第二季")], "has_more": False}})
        result = get_seasons(h, "1")
        self.assertEqual([x["season"] for x in result["items"]], [1, 2])
        self.assertEqual(next(c[2]["query"] for c in h.calls if c[0] == "GET"), "长生狱主，一念镇九幽")

    def test_search_context_discovers_same_album_without_hardcoded_alias(self):
        h = FakePlatform({"1": video("长生狱主，一念镇九幽", 1),
                          "8": video("长生狱主，一念镇九幽第八季", 8),
                          "other": video("长生狱主一念镇九幽", 1, "unrelated")},
                         {0: {"data": [row("8", "长生狱主，一念镇九幽第八季"),
                                       row("other", "长生狱主一念镇九幽")], "has_more": False}})
        result = get_seasons(h, "1", search_hint="镇狱天书")
        self.assertEqual([x["season"] for x in result["items"]], [1, 8])
        self.assertEqual(next(c[2]["query"] for c in h.calls if c[0] == "GET"), "镇狱天书")

    def test_alias_hint_does_not_reuse_plain_title_search_miss(self):
        h = FakePlatform({"1": video("长生狱主，一念镇九幽", 1),
                          "2": video("长生狱主一念镇九幽第二季", 2)},
                         {0: {"data": [], "has_more": False}})
        self.assertEqual(len(get_seasons(h, "1")["items"]), 1)
        h.pages[0]["data"] = [row("2", "长生狱主一念镇九幽第二季")]
        self.assertEqual(len(get_seasons(h, "1", search_hint="镇狱天书")["items"]), 2)

    def test_numeric_seasons_with_different_subtitles_share_search_root(self):
        h = FakePlatform({"1": video("云渺1：我修仙多年强亿点怎么了", 1),
                          "5": video("云渺5：天道终局", 5),
                          "other": video("云渺第一季", 1, "adaptation")},
                         {0: {"data": [row("5", "云渺5：天道终局"), row("other", "云渺第一季")], "has_more": False}})
        result = get_seasons(h, "1")
        self.assertEqual([x["season"] for x in result["items"]], [1, 5])
        self.assertEqual(next(c[2]["query"] for c in h.calls if c[0] == "GET"), "云渺")

    def test_explicit_season_continuation_uses_the_series_root(self):
        h = FakePlatform({"10": video("大明军火库第一季续集十", 10),
                          "1": video("大明军火库第一季", 1)},
                         {0: {"data": [row("1", "大明军火库第一季")], "has_more": False}})
        result = get_seasons(h, "10")
        self.assertEqual([x["season"] for x in result["items"]], [1, 10])
        self.assertEqual(next(c[2]["query"] for c in h.calls if c[0] == "GET"), "大明军火库")

    def test_different_season_titles_are_grouped_only_by_platform_album(self):
        h = FakePlatform({"1": video("故事开篇第一季", 1), "2": video("江湖归途", 2),
                          "other": video("故事开篇第二季", 2, "different")},
                         {0: {"data": [row("2", "江湖归途"), row("other", "故事开篇第二季")], "has_more": False}})
        result = get_seasons(h, "1", search_hint="同一原著")
        self.assertEqual([x["series_id"] for x in result["items"]], ["1", "2"])

    def test_year_and_explicit_title_digits_are_not_removed(self):
        from seasons import _root
        self.assertEqual(_root("城市2021", 1), "城市2021")
        self.assertEqual(_root("代号101第一季", 1), "代号101")

    def test_candidate_metadata_budget_marks_incomplete_and_keeps_current(self):
        candidates = [row(str(i+10), "其他候选") for i in range(200)]
        h = FakePlatform({"1": video("测试第一季", 1)},
                         {0: {"data": candidates, "has_more": True, "next_offset": 1}})
        result = get_seasons(h, "1")
        self.assertTrue(result["partial"])
        ids = [c[1].split(',') for c in h.calls if c[0] == 'POST']
        self.assertLessEqual(sum(len(x) for x in ids), 120)
        self.assertEqual(result["items"][0]["series_id"], "1")

    def test_derived_novel_title_is_a_generic_search_context(self):
        videos = {"1": {**video("剧名甲", 1), "_related_book_title": "平台返回的原著名"},
                  "2": video("副标题完全不同", 2)}
        h = FakePlatform(videos, {0: {"data": [row("2", "副标题完全不同")], "has_more": False}})
        # Fake raw detail, like the platform, supplies novel context beside video_data.
        api = h.api
        def wrapped(method, path, body=None, extra_query=None):
            result = api(method, path, body, extra_query)
            if method == "POST" and "1" in result['data']:
                result['data']['1']['video_relate_book'] = {'book_info': {'book_name': '平台返回的原著名'}}
            return result
        h.api = wrapped
        result = get_seasons(h, "1")
        self.assertEqual([x['series_id'] for x in result['items']], ['1', '2'])
        self.assertEqual(next(c[2]['query'] for c in h.calls if c[0] == 'GET'), '平台返回的原著名')
        self.assertEqual(next(c[2]['count'] for c in h.calls if c[0] == 'GET'), '0')

    def test_metadata_does_not_retain_episode_lists_or_stream_fields(self):
        from seasons import _detail
        h = FakePlatform({'1': {**video('测试第一季', 1), 'video_list': [{'title': 'long'}] * 10000,
                                'stream_info': 'unused'}}, {})
        row = _detail(h, ['1'])['1']
        self.assertNotIn('video_list', row)
        self.assertNotIn('stream_info', row)
        self.assertEqual(row['season_index'], 1)

    def test_later_season_only_is_incomplete(self):
        h = FakePlatform({"8": video("长生狱主，一念镇九幽第八季", 8)},
                         {0: {"data": [], "has_more": False}})
        self.assertTrue(get_seasons(h, "8")["partial"])

    def test_other_series_with_season_before_subtitle_uses_shared_root(self):
        h = FakePlatform({"71": video("锈渊拾遗第一季：重铸星核女儿", 1, "album-7"),
                          "72": video("锈渊拾遗第二季：归途", 2, "album-7")},
                         {0: {"data": [row("71", "锈渊拾遗第一季：重铸星核女儿"),
                                       row("72", "锈渊拾遗第二季：归途")], "has_more": False}})
        result = get_seasons(h, "71")
        self.assertEqual([x["season"] for x in result["items"]], [1, 2])
        self.assertEqual(next(c[2]["query"] for c in h.calls if c[0] == "GET"), "锈渊拾遗")

    def test_platform_group_excludes_same_title_other_adaptation_and_sorts(self):
        h = FakePlatform({"1": video("万妖图录传第一季", 1),
                          "2": video("万妖图录传第二季", 2),
                          "13": video("万妖图录传第十三季", 13),
                          "other": video("万妖图录传", 1, "other")},
                         {0: {"data": [row("other", "万妖图录传"), row("2", "万妖图录传第二季")],
                              "has_more": True, "next_offset": 1},
                          1: {"data": [row("1", "万妖图录传第一季"), row("13", "万妖图录传第十三季")],
                              "has_more": False}})
        result = get_seasons(h, "13")
        self.assertEqual([x["season"] for x in result["items"]], [1, 2, 13])
        self.assertFalse(result["partial"])
        searches = sum(call[0] == "GET" for call in h.calls)
        self.assertEqual(get_seasons(h, "2"), result)
        self.assertEqual(sum(call[0] == "GET" for call in h.calls), searches)

    def test_no_album_does_not_guess_related_titles(self):
        h = FakePlatform({"1": video("单季剧", 0, None)}, {})
        result = get_seasons(h, "1")
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(len(h.calls), 1)

    def test_repeated_cursor_terminates_and_reports_partial(self):
        h = FakePlatform({"1": video("万妖图录传第一季", 1)},
                         {0: {"data": [row("1", "万妖图录传第一季")], "has_more": True}})
        result = get_seasons(h, "1")
        self.assertTrue(result["partial"])
        self.assertEqual(sum(c[0] == "GET" for c in h.calls), 1)

    def test_missing_metadata_is_not_invented_as_an_available_season(self):
        h = FakePlatform({"1": video("万妖图录传第一季", 1)},
                         {0: {"data": [row("2", "万妖图录传第二季")], "has_more": False}})
        result = get_seasons(h, "1")
        self.assertTrue(result["partial"])
        self.assertEqual([x["series_id"] for x in result["items"]], ["1"])

    def test_new_current_season_refreshes_cached_album(self):
        h = FakePlatform({"1": video("万妖图录传第一季", 1), "2": video("万妖图录传第二季", 2)},
                         {0: {"data": [row("1", "万妖图录传第一季"), row("2", "万妖图录传第二季")],
                              "has_more": False}})
        h.cache[("nas-seasons-v3", "original")] = {"items": [{"series_id": "1"}], "partial": False}
        result = get_seasons(h, "2")
        self.assertEqual([x["season"] for x in result["items"]], [1, 2])

    def test_retry_bypasses_cached_result(self):
        h = FakePlatform({"1": video("万妖图录传第一季", 1)},
                         {0: {"data": [row("1", "万妖图录传第一季")], "has_more": False}})
        get_seasons(h, "1")
        get_seasons(h, "1", refresh=True)
        self.assertEqual(sum(c[0] == "GET" for c in h.calls), 2)


class DiskCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path = Path(self.temp.name) / "cache.json"
        self.data = {"items": [{"series_id": "1", "title": "第一季", "season": 1},
                               {"series_id": "2", "title": "第二季", "season": 2}],
                     "partial": False, "album_id": "original"}

    def tearDown(self):
        self.temp.cleanup()

    def test_slow_cold_series_does_not_block_another_series(self):
        cache = SeasonCache(self.path)
        started, release, other_done = threading.Event(), threading.Event(), threading.Event()
        results = []
        def lookup(h, sid, **kwargs):
            if sid == '1':
                started.set()
                release.wait(2)
                return self.data
            return {'items': [{'series_id': sid, 'season': 1}], 'album_id': sid}
        with patch('seasons.get_seasons', side_effect=lookup) as fetch:
            first = threading.Thread(target=lambda: results.append(cache.get(None, '1')))
            duplicate = threading.Thread(target=lambda: results.append(cache.get(None, '1')))
            def other():
                results.append(cache.get(None, '71'))
                other_done.set()
            second = threading.Thread(target=other)
            try:
                first.start(); self.assertTrue(started.wait(1))
                duplicate.start(); second.start()
                self.assertTrue(other_done.wait(.5), 'A different cold series is stuck behind the old lookup')
            finally:
                release.set()
                for worker in (first, duplicate, second):
                    if worker.ident is not None: worker.join(3)
            self.assertEqual(fetch.call_count, 2, 'Same-series requests must still share one lookup')
        self.assertEqual(len(results), 3)

    def test_cleared_cold_lookup_cannot_restore_old_cache(self):
        cache = SeasonCache(self.path)
        def lookup(*args, **kwargs):
            cache.clear()
            return self.data
        with patch('seasons.get_seasons', side_effect=lookup):
            self.assertEqual(cache.get(None, '1')['items'], self.data['items'])
        self.assertFalse(self.path.exists())
        self.assertFalse(cache._miss_jobs)
        self.assertFalse(cache._groups)

    def test_fallback_result_is_persisted_and_reused_across_seasons(self):
        h = FakePlatform({'1': video('故事第一季', 1), '2': video('故事第二季', 2)}, {})
        original = h.api
        def api(method, *args, **kwargs):
            if method == 'GET': raise ValueError('empty body')
            return original(method, *args, **kwargs)
        h.api = api
        fallback = SimpleNamespace(search=lambda query: [row('2', '故事第二季')])
        first = SeasonCache(self.path, fallback=fallback).get(h, '1')
        self.assertTrue(first['partial'])
        self.assertFalse(first['cached'])
        with patch('seasons.get_seasons', side_effect=AssertionError('Must reuse persisted album')):
            second = SeasonCache(self.path, fallback=fallback).get(h, '2')
        self.assertEqual(second['items'], first['items'])
        self.assertTrue(second['cached'])

    def test_failed_cold_lookup_releases_dedup_entry_for_retry(self):
        cache = SeasonCache(self.path)
        with patch('seasons.get_seasons', side_effect=ValueError('both sources unavailable')):
            with self.assertRaises(ValueError): cache.get(None, '1')
        self.assertFalse(cache._miss_jobs)
        with patch('seasons.get_seasons', return_value=self.data):
            self.assertEqual(cache.get(None, '1')['items'], self.data['items'])


    def test_old_dangling_member_does_not_show_another_current_season(self):
        cache = SeasonCache(self.path)
        cache.put("1", self.data)
        cache._groups["album:original"]["data"] = {**self.data, "items": [self.data["items"][1]]}
        with patch("seasons.get_seasons", return_value=self.data) as fetch:
            result = cache.get(None, "1")
            fetch.assert_called_once()
        self.assertEqual([x["series_id"] for x in result["items"]], ["1", "2"])

    def test_narrow_refresh_preserves_known_members_and_marks_partial(self):
        cache = SeasonCache(self.path)
        cache.put("1", self.data)
        cache.put("2", {**self.data, "items": [self.data["items"][1]]})
        result = SeasonCache(self.path).get(None, "1")
        self.assertEqual([x["series_id"] for x in result["items"]], ["1", "2"])
        self.assertTrue(result["partial"])

    def test_same_search_hint_does_not_loop_single_season_refresh(self):
        cache = SeasonCache(self.path)
        single = {**self.data, "items": [self.data["items"][0]]}
        cache.put("1", single)
        with patch("seasons.get_seasons", return_value=single) as fetch:
            cache.get(None, "1", search_hint="别名")
            for _ in range(200):
                if not cache._jobs: break
                time.sleep(0.005)
            fetch.assert_called_once_with(None, "1", refresh=True, search_hint="别名")
            cache.get(None, "1", search_hint="别名")
            fetch.assert_called_once()

    def test_background_refresh_reuses_successful_search_context(self):
        cache = SeasonCache(self.path, ttl=0)
        cache.put("1", self.data, search_hint="原著别名")
        with patch("seasons.get_seasons", return_value=self.data) as fetch:
            cache.get(None, "2")
            for _ in range(200):
                if not cache._jobs: break
                time.sleep(0.005)
            fetch.assert_called_once_with(None, "2", refresh=True, search_hint="原著别名")

    def test_partial_search_is_not_repeated_within_ten_minutes(self):
        cache = SeasonCache(self.path)
        cache.put('1', {**self.data, 'partial': True})
        cache._groups['album:original']['updated_at'] -= 120
        with patch('seasons.get_seasons', side_effect=AssertionError('Repeated expensive search')):
            result = cache.get(None, '1')
            self.assertFalse(result['refreshing'])

    def test_old_algorithm_result_is_refreshed_once_without_clearing_disk(self):
        cache = SeasonCache(self.path)
        cache.put("1", self.data)
        cache._groups["album:original"].pop("scan_version", None)
        with patch("seasons.get_seasons", return_value=self.data) as fetch:
            result = cache.get(None, "1")
            for _ in range(200):
                if not cache._jobs: break
                time.sleep(0.005)
            fetch.assert_called_once()
            self.assertEqual(cache.get(None, "1")["items"], self.data["items"])
            fetch.assert_called_once()
        self.assertTrue(result["cached"])
        self.assertTrue(self.path.exists())

    def test_restart_and_season_switch_read_disk_without_platform_requests(self):
        SeasonCache(self.path).put("1", self.data)
        restarted = SeasonCache(self.path)
        with patch("seasons.get_seasons", side_effect=AssertionError("Unexpected platform request")):
            result = restarted.get(None, "2")
        self.assertTrue(result["cached"])
        self.assertEqual(result["items"], self.data["items"])
        self.assertFalse(result["refreshing"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_new_unseeded_series_is_cached_independently_and_survives_restart(self):
        cache = SeasonCache(self.path)
        cache.put("1", self.data)
        other = {"items": [{"series_id": "71", "title": "其他剧第一季", "season": 1},
                            {"series_id": "72", "title": "其他剧第二季", "season": 2}],
                 "partial": False, "album_id": "another-album"}
        with patch("seasons.get_seasons", return_value=other) as fetch:
            self.assertFalse(cache.get(None, "71")["cached"])
            fetch.assert_called_once()
        with patch("seasons.get_seasons", side_effect=AssertionError("Unexpected lookup")):
            restarted = SeasonCache(self.path)
            self.assertEqual(restarted.get(None, "72")["items"], other["items"])
            self.assertEqual(restarted.get(None, "2")["items"], self.data["items"])

    def test_expired_cache_returns_old_list_and_deduplicates_background_refresh(self):
        cache = SeasonCache(self.path, ttl=0)
        cache.put("1", self.data)
        started, release = threading.Event(), threading.Event()
        calls = []
        def slow(*args, **kwargs):
            calls.append(args)
            started.set()
            release.wait(2)
            return self.data
        with patch("seasons.get_seasons", side_effect=slow):
            try:
                result = cache.get(None, "1")
                self.assertTrue(result["refreshing"])
                self.assertEqual(result["items"], self.data["items"])
                self.assertTrue(started.wait(1))
                cache.get(None, "2")
                self.assertEqual(len(calls), 1)
            finally:
                release.set()
                for _ in range(200):
                    if not cache._jobs:
                        break
                    time.sleep(0.005)
                self.assertFalse(cache._jobs)

    def test_failed_background_update_keeps_the_persisted_list(self):
        cache = SeasonCache(self.path)
        cache.put("1", self.data)
        with patch("seasons.get_seasons", side_effect=RuntimeError("Offline")):
            cache.get(None, "1", refresh=True)
            for _ in range(200):
                if not cache._jobs:
                    break
                time.sleep(0.005)
        self.assertEqual(SeasonCache(self.path).get(None, "2")["items"], self.data["items"])
        self.assertTrue(cache.get(None, "1")["refresh_error"])

    def test_failed_atomic_write_preserves_previous_memory_and_disk(self):
        cache = SeasonCache(self.path)
        cache.put("1", self.data)
        with patch("seasons.os.replace", side_effect=OSError("Disk unavailable")):
            with self.assertRaises(OSError):
                cache.put("3", {"items": [{"series_id": "3"}], "album_id": "original"})
        self.assertEqual(cache.get(None, "1")["items"], self.data["items"])
        self.assertEqual(SeasonCache(self.path).get(None, "1")["items"], self.data["items"])
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
