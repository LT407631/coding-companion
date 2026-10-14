"""Current Hongguo single-video API with legacy descriptors and CDN mirror fallback."""
import base64
import hashlib
import json
import os
import random
import threading
import time
from urllib.parse import urlencode
from urllib.parse import urlparse

class HongguoSourceError(RuntimeError):
    pass


def download_with_fallback(urls, path, request, timeout=(3, 20)):
    """Download one media variant, moving to its mirrors on transport failure."""
    urls = list(dict.fromkeys(value for value in urls if value))
    if not urls:
        raise HongguoSourceError("播放源未提供下载地址")
    temporary = path + ".part"
    last = None
    for url in urls:
        response = None
        try:
            response = request("GET", url, stream=True, timeout=timeout)
            response.raise_for_status()
            with open(temporary, "wb") as target:
                for chunk in response.iter_content(262144):
                    if chunk:
                        target.write(chunk)
            if os.path.getsize(temporary) <= 0:
                raise HongguoSourceError("播放源返回空文件")
            os.replace(temporary, path)
            return
        except Exception as exc:
            last = exc
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        finally:
            if response is not None:
                response.close()
    raise HongguoSourceError("所有播放地址下载失败") from last


class HongguoTrackProvider:
    BASE_URL = "https://api5-normal-sinfonlineb.fqnovel.com"
    USER_AGENT = ("com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; "
                  "Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 "
                  "2026-01-23 QuicVersion:c67e9834 2025-09-08)")
    SIGN_KEY = bytes((0x44, 0xb9, 0xb9, 0xd9, 0xa4, 0xae, 0xf9, 0xfc, 0xa4, 0x93,
                      0xaa, 0x75, 0x7c, 0xa3, 0xc2, 0xc4, 0xa4, 0x96, 0x93, 0x8f))

    def __init__(self, legacy, session=None, min_interval=.25):
        self.legacy = legacy
        if session is None:
            import requests
            session = requests.Session()
        self.session = session
        self.device_id = str(random.SystemRandom().randrange(10**18, 9 * 10**18))
        self.install_id = str(random.SystemRandom().randrange(10**18, 9 * 10**18))
        self.min_interval = max(0, float(min_interval))
        self._request_lock = threading.Lock()
        self._last_request = 0.0

    def __getattr__(self, name):
        return getattr(self.legacy, name)

    @staticmethod
    def _reverse8(value):
        value = ((value & 0x55) << 1) | ((value >> 1) & 0x55)
        value = ((value & 0x33) << 2) | ((value >> 2) & 0x33)
        return ((value << 4) | (value >> 4)) & 0xff

    @classmethod
    def _signature(cls, raw_query, body, timestamp):
        payload = bytearray(20)
        payload[:4] = hashlib.md5(raw_query.encode()).digest()[:4]
        payload[4:8] = hashlib.md5(body).digest()[:4]
        payload[12:16] = bytes((0, 6, 11, 28))
        payload[16:20] = int(timestamp).to_bytes(4, "big")
        for index in range(20):
            payload[index] ^= cls.SIGN_KEY[index]
        for index in range(20):
            rotated = ((payload[index] << 4) | (payload[index] >> 4)) & 0xff
            payload[index] = cls._reverse8(rotated ^ payload[(index + 1) % 20]) ^ 0xff ^ 20
        return (bytes((0x84, 0x04, 0x40, 0x1c, 0, 0)) + payload).hex()

    def _query(self, now):
        return urlencode({
            "aid": "8662", "app_name": "novelread", "version_code": "73532",
            "version_name": "7.3.5.32", "manifest_version_code": "73532",
            "update_version_code": "73532", "channel": "update_64",
            "device_platform": "android", "os": "android", "ssmix": "a",
            "device_type": "25053RT47C", "device_brand": "Redmi", "language": "zh",
            "os_api": "36", "os_version": "16", "resolution": "1280*2772",
            "dpi": "520", "ac": "wifi", "device_id": self.device_id,
            "iid": self.install_id, "_rticket": str(int(now * 1000)),
        })

    @staticmethod
    def _media_urls(track):
        def candidates(value):
            if isinstance(value, str):
                yield value.strip()
            elif isinstance(value, list):
                for item in value:
                    yield from candidates(item)
        output = []
        for name in ("main_url", "backup_url", "backup_url_1", "backup_url_2",
                     "backup_urls", "url_list"):
            for value in candidates(track.get(name)):
                if len(value) > 8192:
                    continue
                if urlparse(value).scheme not in ("http", "https"):
                    try:
                        value = base64.b64decode(value + "=" * (-len(value) % 4)).decode().strip()
                    except (ValueError, UnicodeDecodeError):
                        continue
                parsed = urlparse(value)
                if (parsed.scheme in ("http", "https") and parsed.netloc and
                        value not in output):
                    output.append(value)
        return output

    def _tracks(self, video_id):
        body = json.dumps({"video_id": video_id, "content_type": 1, "biz_param": {
            "need_all_video_definition": True, "video_platform": 3,
        }}, ensure_ascii=False, separators=(",", ":")).encode()
        with self._request_lock:
            delay = self.min_interval - (time.monotonic() - self._last_request)
            if delay > 0:
                time.sleep(delay)
            now = time.time()
            query = self._query(now)
            headers = {
                "User-Agent": self.USER_AGENT, "Accept": "application/json",
                "X-XS-From-Web": "0", "Sdk-Version": "2",
                "Content-Type": "application/json; charset=utf-8",
                "X-SS-STUB": hashlib.md5(body).hexdigest().upper(),
                "X-Khronos": str(int(now)), "X-Gorgon": self._signature(query, body, now),
                "X-SS-Req-Ticket": str(int(now * 1000)),
            }
            response = None
            try:
                response = self.session.post(
                    self.BASE_URL + "/novel/player/video_model/v1/?" + query,
                    data=body, headers=headers, timeout=(3, 12))
                response.raise_for_status()
                result = response.json()
            except Exception as exc:
                raise HongguoSourceError("新版播放源响应失败") from exc
            finally:
                if response is not None:
                    response.close()
                self._last_request = time.monotonic()
        code = result.get("Code", result.get("code"))
        if code not in (None, 0, "0"):
            raise HongguoSourceError(f"新版播放源暂时不可用（{str(code)[:20]}）")
        data = result.get("data") or {}
        model = data.get("video_model") or {}
        if isinstance(model, str):
            try:
                model = json.loads(model)
            except ValueError as exc:
                raise HongguoSourceError("新版播放源数据格式异常") from exc
        tracks = model.get("video_list") or []
        if isinstance(tracks, dict):
            tracks = [tracks[key] for key in sorted(tracks)]
        normalized = []
        for track in tracks if isinstance(tracks, list) else []:
            if not isinstance(track, dict):
                continue
            addresses = self._media_urls(track)
            if addresses:
                normalized.append({**track, "main_url": addresses[0],
                                   "coding_urls": addresses})
        return normalized

    def get_video_tracks(self, vids, force=False):
        output, failures = {}, {}
        for value in dict.fromkeys(str(item) for item in vids):
            try:
                tracks = self._tracks(value)
                if tracks:
                    output[value] = tracks
                else:
                    failures[value] = HongguoSourceError("新版播放源未返回视频轨道")
            except Exception as exc:
                failures[value] = exc
        if failures:
            try:
                output.update(self.legacy.get_video_tracks(list(failures), force=force) or {})
            except Exception:
                pass
        unresolved = [value for value in failures if not output.get(value)]
        if unresolved and len(vids) == 1:
            raise failures[unresolved[0]]
        return output
