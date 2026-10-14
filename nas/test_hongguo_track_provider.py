import json
import base64
import tempfile
from pathlib import Path
import unittest

from hongguo_track_provider import download_with_fallback, HongguoSourceError, HongguoTrackProvider


class Response:
    def __init__(self, body, chunks=None, error=None):
        self.body = body
        self.chunks = chunks or []
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise self.error
        return None

    def json(self):
        return self.body

    def close(self):
        return None

    def iter_content(self, _size):
        yield from self.chunks


class Session:
    def __init__(self, bodies):
        self.bodies = iter(bodies)
        self.calls = []

    def post(self, url, **options):
        self.calls.append((url, options))
        return Response(next(self.bodies))


class Legacy:
    def __init__(self, tracks=None):
        self.tracks = tracks or {}
        self.calls = []

    def get_video_tracks(self, vids, force=False):
        self.calls.append((vids, force))
        return {vid: self.tracks[vid] for vid in vids if vid in self.tracks}

    def get_episodes(self, series_id):
        return {"series_id": series_id}, []


class ProviderTests(unittest.TestCase):
    def provider(self, bodies, legacy=None):
        return HongguoTrackProvider(legacy or Legacy(), Session(bodies), min_interval=0)

    def test_returns_tracks_from_current_single_video_api(self):
        tracks = [{"main_url": "https://media.test/a", "video_meta": {"size": 3}}]
        provider = self.provider([{"Code": 0, "data": {"video_model": json.dumps({"video_list": tracks})}}])
        result = provider.get_video_tracks(["123"])
        self.assertEqual(result["123"][0]["main_url"], tracks[0]["main_url"])
        self.assertEqual(result["123"][0]["video_meta"], tracks[0]["video_meta"])
        url, options = provider.session.calls[0]
        self.assertIn("api5-normal-sinfonlineb.fqnovel.com/novel/player/video_model/v1/", url)
        self.assertIn("version_code=73532", url)
        self.assertEqual(json.loads(options["data"])["video_id"], "123")
        self.assertTrue(options["headers"]["X-Gorgon"].startswith("8404401c0000"))

    def test_falls_back_to_legacy_cached_track(self):
        old = [{"main_url": "https://media.test/old"}]
        legacy = Legacy({"123": old})
        provider = self.provider([{"Code": 101000, "Message": "服务异常"}], legacy)
        self.assertEqual(provider.get_video_tracks(["123"], force=True), {"123": old})
        self.assertEqual(legacy.calls, [(["123"], True)])

    def test_non_track_calls_delegate_to_existing_provider(self):
        provider = self.provider([], Legacy())
        self.assertEqual(provider.get_episodes("456"), ({"series_id": "456"}, []))

    def test_accepts_encoded_or_backup_media_address(self):
        address = "https://media.test/encoded"
        tracks = [{"main_url": base64.b64encode(address.encode()).decode()},
                  {"backup_url": "https://media.test/backup"}]
        provider = self.provider([{"Code": 0, "data": {"video_model": {"video_list": tracks}}}])
        result = provider.get_video_tracks(["123"])["123"]
        self.assertEqual([item["main_url"] for item in result],
                         [address, "https://media.test/backup"])
        self.assertEqual(result[1]["coding_urls"], ["https://media.test/backup"])

    def test_surfaces_real_upstream_code_when_both_sources_fail(self):
        provider = self.provider([{"Code": 101000, "Message": "服务异常"}])
        with self.assertRaisesRegex(HongguoSourceError, "101000"):
            provider.get_video_tracks(["123"])

    def test_download_uses_next_mirror_and_removes_partial_file(self):
        responses = iter([Response({}, chunks=[b"bad"], error=RuntimeError("down")),
                          Response({}, chunks=[b"good", b" media"])])
        calls = []
        def request(_method, url, **_options):
            calls.append(url)
            return next(responses)
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "video.mp4")
            download_with_fallback(["https://one.test/a", "https://two.test/a"], target, request)
            self.assertEqual(Path(target).read_bytes(), b"good media")
            self.assertFalse(Path(target + ".part").exists())
        self.assertEqual(calls, ["https://one.test/a", "https://two.test/a"])
        self.assertTrue(Path(directory).exists() is False)


if __name__ == "__main__":
    unittest.main()
