import unittest
from device_media import descriptors


class Provider:
    def get_episodes(self, sid):
        return {}, [{"index": n, "vid": str(100 + n)} for n in range(1, 8)]

    def get_video_tracks(self, vids, force=False):
        self.last = (vids, force)
        return {v: [{"main_url": "https://v26.qznovelvod.com/video?expires=123",
                     "video_meta": {"definition": q, "codec_type": "h264", "size": 1000},
                     "encrypt_info": {"encrypt": True, "spade_a": "example"}}
                    for q in ("480p", "720p", "1080p")] for v in vids}


class DescriptorTests(unittest.TestCase):
    def test_batch_and_size_selection_no_media_download(self):
        p = Provider()
        d = descriptors(p, "1", 2, count=4, force=True)
        self.assertEqual(p.last, (["102", "103", "104", "105"], True))
        self.assertEqual([e["ep"] for e in d["episodes"]], [2, 3, 4, 5])
        self.assertTrue(all(e["quality"] == "720p" for e in d["episodes"]))

    def test_nonexistent_episode(self):
        with self.assertRaises(ValueError):
            descriptors(Provider(), "1", 8)

    def test_proprietary_codec_never_selected(self):
        p = Provider()
        p.get_video_tracks = lambda *args, **kw: {"101": [
            {"main_url": "https://v.qznovelvod.com/bvc", "video_meta": {"definition": "720p", "codec_type": "bytevc2"}},
            {"main_url": "https://v.qznovelvod.com/hevc", "video_meta": {"definition": "720p", "codec_type": "bytevc1"}},
        ]}
        self.assertEqual(descriptors(p, "1", 1)["episodes"][0]["codec"], "bytevc1")
        p.get_video_tracks = lambda *args, **kw: {"101": [{"main_url": "https://v.qznovelvod.com/bvc", "video_meta": {"codec_type": "bytevc2"}}]}
        with self.assertRaises(ValueError):
            descriptors(p, "1", 1)

    def test_disallowed_or_plain_http_url(self):
        for url in ("http://v.qznovelvod.com/file", "https://qznovelvod.com.evil.test/file", "http://127.0.0.1/file"):
            p = Provider()
            p.get_video_tracks = lambda *args, **kw: {"101": [{"main_url": url, "video_meta": {"codec_type": "h264"}}]}
            with self.assertRaises(ValueError):
                descriptors(p, "1", 1)


if __name__ == "__main__":
    unittest.main()
