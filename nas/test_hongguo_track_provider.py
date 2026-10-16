import json
import base64
import tempfile
from pathlib import Path
import unittest

from hongguo_track_provider import download_with_fallback, HongguoSourceError, HongguoTrackProvider


class Response:
    def __init__(self, body, chunks=None, error=None):
        self.body = body
        self.content = json.dumps(body).encode() if body is not None else b''
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
        def signer(vid):
            return {'url': HongguoTrackProvider.MODEL_URL + '?version_code=71332',
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({'mixed_video_id_map': {'1004': [vid]}})}
        return HongguoTrackProvider(legacy or Legacy(), Session(bodies), min_interval=0, signer=signer)

    def test_returns_hd_tracks_from_fixed_signed_api(self):
        tracks = [{"main_url": "https://media.test/a", "video_meta": {"size": 3, "definition": "720p", "codec_type": "hevc", "vwidth": 1280, "vheight": 720}}]
        provider = self.provider([{"Code": 0, "data": {"123": {"video_model": json.dumps({"video_list": tracks})}}}])
        result = provider.get_video_tracks(["123"])
        self.assertEqual(result["123"][0]["main_url"], tracks[0]["main_url"])
        self.assertEqual(result["123"][0]["video_meta"]["definition"], "720p")
        url, options = provider.session.calls[0]
        self.assertIn("api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/", url)
        self.assertIn("version_code=71332", url)
        self.assertEqual(json.loads(options["data"])["mixed_video_id_map"], {"1004": ["123"]})
        self.assertEqual(len(provider.session.calls), 1)
        self.assertEqual(provider.legacy.calls, [])

    def test_never_returns_to_failed_legacy_api_even_with_old_tracks(self):
        old = [{"main_url": "https://media.test/old"}]
        legacy = Legacy({"123": old})
        provider = self.provider([{"Code": 101000, "Message": "服务异常"}], legacy)
        with self.assertRaisesRegex(HongguoSourceError, '101000'):
            provider.get_video_tracks(["123"], force=True)
        self.assertEqual(legacy.calls, [])

    def test_empty_hd_response_stops_without_old_api_or_low_quality(self):
        from source_requests import SourceUnavailable
        legacy = Legacy({'123': [{'main_url': 'https://media.test/old'}]})
        provider = self.provider([None], legacy)
        with self.assertRaisesRegex(SourceUnavailable, '空响应'):
            provider.get_video_tracks(['123'])
        self.assertEqual(legacy.calls, [])

    def test_returns_all_actual_quality_steps_in_descending_order(self):
        tracks = [
            {'main_url': 'https://media.test/720', 'video_meta': {'definition': '720p', 'codec_type': 'hevc', 'size': 900, 'vwidth': 1280, 'vheight': 720}},
            {'main_url': 'https://media.test/1080', 'video_meta': {'definition': '1080p', 'codec_type': 'hevc', 'size': 500, 'vwidth': 1920, 'vheight': 1080}},
            {'main_url': 'https://media.test/proprietary', 'video_meta': {'definition': '1080p', 'codec_type': 'bytevc2', 'size': 999, 'vwidth': 1920, 'vheight': 1080}},
        ]
        provider = self.provider([{'code': 0, 'data': {'123': {'video_model': {'video_list': tracks}}}}])
        result = provider.get_video_tracks(['123'])['123']
        self.assertEqual([t['main_url'] for t in result],
                         ['https://media.test/1080', 'https://media.test/720'])

    def test_mislabeled_1080_is_reported_as_actual_720(self):
        track = {'main_url': 'https://media.test/native', 'video_meta': {
            'definition': '1080p', 'codec_type': 'hevc', 'vwidth': 1280, 'vheight': 720}}
        provider = self.provider([{'code': 0, 'data': {'123': {'video_model': {'video_list': [track]}}}}])
        self.assertEqual(provider.get_video_tracks(['123'])['123'][0]['video_meta']['definition'], '720p')

    def test_unknown_dimensions_cannot_be_treated_as_hd(self):
        track = {'main_url': 'https://media.test/unknown', 'definition': '1080p', 'codec_type': 'hevc'}
        provider = self.provider([{'code': 0, 'data': {'123': {'video_model': {'video_list': [track]}}}}])
        with self.assertRaises(HongguoSourceError):
            provider.get_video_tracks(['123'])

    def test_non_track_calls_delegate_to_existing_provider(self):
        provider = self.provider([], Legacy())
        self.assertEqual(provider.get_episodes("456"), ({"series_id": "456"}, []))

    def test_preload_flat_encryption_metadata_survives_and_fallback_is_retained(self):
        hd = {"definition": "720p", "codec_type": "hevc", "vwidth": 1280, "vheight": 720,
              "size": 500, "main_url": "https://media.test/720", "encrypt": 1,
              "spade_a": "fixture-key", "backup_url_1": "https://mirror.test/720"}
        low = {**hd, "definition": "360p", "size": 900, "vwidth": 640, "vheight": 360}
        mislabeled = {**low, "definition": "1080p", "codec_type": "hevc"}
        provider = self.provider([{"code": 0, "data": {"123": {"video_model":
            json.dumps({"video_list": {"video_1": low, "video_2": hd, "video_3": mislabeled}})}}}])
        tracks = provider.get_video_tracks(["123"])["123"]
        self.assertEqual([t['video_meta']['definition'] for t in tracks], ['720p', '360p', '360p'])
        from media_source import MediaSource
        selected = MediaSource._best(tracks)
        self.assertEqual(selected["definition"], "720p")
        self.assertEqual([t['definition'] for t in selected['fallbacks']], ['360p'])
        self.assertTrue(selected["encrypt"])
        self.assertEqual(selected["spade_a"], "fixture-key")
        self.assertEqual(selected["urls"], [hd["main_url"], hd["backup_url_1"]])

    def test_low_quality_is_used_without_switching_source(self):
        provider = self.provider([{"code": 0, "data": {"123": {"video_model": {
            "video_list": [{"definition": "1080p", "codec_type": "hevc", "vwidth": 910,
                            "vheight": 512, "main_url": "https://media.test/low"}]}}}}])
        tracks = provider.get_video_tracks(["123"])["123"]
        self.assertEqual(tracks[0]['video_meta']['definition'], '480p')
        self.assertEqual(len(provider.session.calls), 1)
        self.assertEqual(provider.legacy.calls, [])

    def test_accepts_encoded_or_backup_media_address(self):
        address = "https://media.test/encoded"
        tracks = [{"main_url": base64.b64encode(address.encode()).decode(), "definition": "720p", "codec_type": "hevc", "vwidth": 1280, "vheight": 720},
                  {"backup_url": "https://media.test/backup", "definition": "720p", "codec_type": "hevc", "vwidth": 1280, "vheight": 720}]
        provider = self.provider([{"Code": 0, "data": {"123": {"video_model": {"video_list": tracks}}}}])
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
