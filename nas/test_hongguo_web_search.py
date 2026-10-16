import json
import threading
import time
import unittest
from urllib.parse import unquote

from hongguo_web_search import HongguoWebSearch


class Response:
    def __init__(self, payload=None, content=None):
        self.payload = payload
        self.content = content if content is not None else b"{}"

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class Session:
    def __init__(self, payload, details=None, pages=None, totals=None):
        self.payload, self.details, self.pages = payload, details or {}, pages or {}
        self.totals = totals or {}
        self.calls = []

    def get(self, url, **options):
        self.calls.append((url, options))
        if url.endswith("/detail"):
            series_id = options["params"]["series_id"]
            detail = self.details.get(series_id)
            if isinstance(detail, Exception):
                raise detail
            loader = {"loaderData": {"detail_page": {"seriesDetail": detail}}}
            return Response(content=("<script>window._ROUTER_DATA=" + json.dumps(loader) + "</script>").encode())
        if "/search/" in url:
            query = unquote(url.rsplit("/", 1)[-1])
            page = {"isSuccess": True, "query": query, "searchList": self.pages.get(query, [])}
            if query in self.totals:
                page["totalCount"] = str(self.totals[query])
            loader = {"loaderData": {"search_(keyword)/page": page}}
            return Response(content=("<script>window._ROUTER_DATA=" + json.dumps(loader) + "</script>").encode())
        payload = self.payload
        if isinstance(payload, dict) and "suggest_list" not in payload:
            payload = payload.get(options["params"]["query"], {"suggest_list": []})
        if isinstance(payload, Exception):
            raise payload
        return Response(payload)


class HongguoWebSearchTests(unittest.TestCase):
    def test_maps_full_and_title_only_suggestions(self):
        session = Session({"suggest_list": [
            {"keyword": "6906763079292292104", "name": "尸帝", "word_type": "title", "video_data": {}},
            {"keyword": "7695370827507698713", "name": "别名占位", "video_data": {}},
            {"keyword": "7695370827507698713", "name": "别名", "video_data": {
                "series_id": 7695370827507698713, "series_title": "正名", "episode_cnt": 155,
                "series_cover": "https://example/cover", "category_list": [{"name": "末世"}],
                "hot_score_data": {"score": 53128662, "text": "5312万热度"}}},
            {"keyword": "not-a-series", "name": "忽略", "video_data": {}},
        ]}, {"6906763079292292104": {"series_id": "6906763079292292104", "series_name": "尸帝",
                                     "series_cover": "https://example/shidi", "episode_cnt": 410,
                                     "tags": ["玄幻", "穿越"]}})
        rows = HongguoWebSearch(session).search("尸帝")
        self.assertEqual([row["series_id"] for row in rows], ["6906763079292292104", "7695370827507698713"])
        self.assertEqual(rows[1]["title"], "正名")
        self.assertEqual(rows[1]["episode_cnt"], 155)
        self.assertEqual(rows[1]["category"], "末世")
        self.assertEqual(rows[0]["cover"], "https://example/shidi")
        self.assertEqual(rows[0]["episode_cnt"], 410)
        self.assertEqual(rows[0]["category"], "玄幻 · 穿越")
        suggestion = next(call for call in session.calls if call[0].endswith("/suggestion"))
        self.assertEqual(suggestion[1]["params"]["query"], "尸帝")
        self.assertEqual(suggestion[1]["params"]["count"], "20")

    def test_second_season_builds_one_deduplicated_website_snapshot(self):
        def item(series_id, title):
            return {"keyword": series_id, "name": title, "word_type": "short_play_name",
                    "video_data": {"series_id": series_id, "series_title": title,
                                   "series_cover": "https://example/" + series_id}}

        session = Session({"suggest_list": [
            item("1", "原始剧第二季"),
            {"keyword": "common", "name": "第二季上新", "word_type": "common_query", "video_data": {}},
        ]}, pages={
            "第二季": [item("2", "网页剧第二季"), item("9", "无关第一季")],
            "第2季": [item("3", "数字剧第2季"), item("2", "网页剧第二季")],
            "第二季上新": [item("4", "上新剧第二季")],
        })
        rows = HongguoWebSearch(session).search("第二季")
        self.assertEqual([row["series_id"] for row in rows], ["1", "2", "3", "4"])
        self.assertTrue(all("第二季" in row["title"] or "第2季" in row["title"] for row in rows))
        queries = [call[1]["params"]["query"] for call in session.calls
                   if call[0].endswith("/suggestion")]
        self.assertEqual(set(queries), {"第二季", "第2季", "第二季上新"})

    def test_walks_official_related_queries_until_declared_total(self):
        def item(series_id, title):
            return {"keyword": series_id, "name": title, "word_type": "short_play_name",
                    "video_data": {"series_id": series_id, "series_title": title,
                                   "series_cover": "https://example/" + series_id}}

        suggestions = {
            "第二季": {"suggest_list": [
                item("1", "甲第二季"),
                {"keyword": "q1", "name": "第二季新剧", "word_type": "common_query"}]},
            "第2季": {"suggest_list": [item("2", "乙第2季")]},
            "第二季新剧": {"suggest_list": [
                item("3", "丙第二季"),
                {"keyword": "q2", "name": "好看的第二季", "word_type": "common_query"}]},
            "好看的第二季": {"suggest_list": [item("4", "丁第二季"), item("5", "戊第二季")]},
        }
        session = Session(suggestions, totals={"第二季": 5})
        rows = HongguoWebSearch(session).search("第二季")
        self.assertEqual([row["series_id"] for row in rows], ["1", "2", "3", "4", "5"])
        self.assertEqual(len({row["series_id"] for row in rows}), 5)
        queried = [call[1]["params"]["query"] for call in session.calls
                   if call[0].endswith("/suggestion")]
        self.assertIn("好看的第二季", queried)

    def test_declared_total_stops_related_graph_without_overfetching(self):
        def item(series_id):
            return {"keyword": series_id, "name": "剧" + series_id + "第二季",
                    "word_type": "short_play_name", "video_data": {
                        "series_id": series_id, "series_title": "剧" + series_id + "第二季",
                        "series_cover": "https://example/" + series_id}}

        session = Session({"第二季": {"suggest_list": [item("1"), item("2"),
                          {"keyword": "later", "name": "稍后第二季", "word_type": "common_query"}]}},
                          totals={"第二季": 2})
        rows = HongguoWebSearch(session).search("第二季")
        self.assertEqual([row["series_id"] for row in rows], ["1", "2"])
        queried = [call[1]["params"]["query"] for call in session.calls
                   if call[0].endswith("/suggestion")]
        self.assertNotIn("稍后第二季", queried)

    def test_unresolved_suggestion_token_is_not_returned_as_a_series(self):
        session = Session({"suggest_list": [{"keyword": "123", "name": "保留", "video_data": {}}]},
                          {"123": RuntimeError("detail unavailable")})
        self.assertEqual(HongguoWebSearch(session).search("保留"), [])

    def test_website_page_remains_single_source_fallback_when_suggestion_fails(self):
        page_item = {"keyword": "123", "name": "官网页面剧", "video_data": {
            "series_id": "123", "series_title": "官网页面剧",
            "series_cover": "https://example/page"}}
        session = Session(RuntimeError("suggestion unavailable"), pages={"官网页面剧": [page_item]})
        rows = HongguoWebSearch(session).search("官网页面剧")
        self.assertEqual([row["series_id"] for row in rows], ["123"])

    def test_source_detail_fills_cover_when_public_detail_is_incomplete(self):
        session = Session({"suggest_list": [{"keyword": "123", "name": "第二季", "video_data": {}}]},
                          {"123": RuntimeError("detail unavailable")})
        rows = HongguoWebSearch(session, resolve=lambda sid: {
            "series_id": sid, "title": "第二季", "cover": "https://example/second",
            "category": ["末世", "科幻"], "episode_cnt": 120}).search("第二季")
        self.assertEqual(rows[0]["cover"], "https://example/second")
        self.assertEqual(rows[0]["category"], "末世 · 科幻")
        self.assertEqual(rows[0]["episode_cnt"], 120)

    def test_slow_detail_requests_cannot_hold_the_search_past_its_budget(self):
        release = threading.Event()

        class SlowSession(Session):
            def get(self, url, **options):
                if url.endswith("/detail"):
                    release.wait(0.3)
                return super().get(url, **options)

        session = SlowSession({"suggest_list": [{"keyword": "99", "name": "可用剧集", "video_data": {
            "series_id": "99", "series_title": "可用剧集", "series_cover": "https://example/99"
        }}] + [
            {"keyword": str(index), "name": "慢剧" + str(index), "video_data": {}}
            for index in range(1, 13)
        ]})
        started = time.monotonic()
        try:
            rows = HongguoWebSearch(session, total_budget=0.05,
                                    detail_budget=0.04).search("慢搜索")
        finally:
            release.set()
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertEqual([row["series_id"] for row in rows], ["99"])

    def test_source_detail_enrichment_is_concurrent_and_bounded(self):
        started, release = [], threading.Event()
        guard = threading.Lock()

        def resolve(series_id):
            with guard:
                started.append(series_id)
                if len(started) >= 2:
                    release.set()
            self.assertTrue(release.wait(0.5))
            return {"series_id": series_id, "title": "剧集" + series_id,
                    "cover": "https://example/" + series_id}

        session = Session({"suggest_list": [
            {"keyword": str(index), "name": "剧集" + str(index), "video_data": {}}
            for index in range(1, 5)
        ]}, {str(index): RuntimeError("detail unavailable") for index in range(1, 5)})
        rows = HongguoWebSearch(session, resolve=resolve, total_budget=1).search("并发")
        self.assertEqual(len(started), 4)
        self.assertTrue(all(row["cover"] for row in rows))


if __name__ == "__main__":
    unittest.main()
