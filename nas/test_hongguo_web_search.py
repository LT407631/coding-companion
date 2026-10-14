import unittest

from hongguo_web_search import HongguoWebSearch


class Response:
    def __init__(self, payload):
        self.payload = payload
        self.content = b"{}"

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class Session:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, url, **options):
        self.calls.append((url, options))
        return Response(self.payload)


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
        ]})
        rows = HongguoWebSearch(session).search("尸帝")
        self.assertEqual([row["series_id"] for row in rows], ["6906763079292292104", "7695370827507698713"])
        self.assertEqual(rows[1]["title"], "正名")
        self.assertEqual(rows[1]["episode_cnt"], 155)
        self.assertEqual(rows[1]["category"], "末世")
        self.assertEqual(session.calls[0][1]["params"]["query"], "尸帝")
        self.assertEqual(session.calls[0][1]["params"]["count"], "50")


if __name__ == "__main__":
    unittest.main()
