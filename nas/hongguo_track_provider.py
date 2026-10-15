"""One fixed HD video API; failed legacy APIs are never retried as fallbacks."""
import base64
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlparse
from source_requests import SourceUnavailable

class HongguoSourceError(SourceUnavailable):
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
    MODEL_URL = BASE_URL + '/novel/player/multi_video_model/v1/'

    def __init__(self, legacy, session=None, min_interval=.25, signer=None):
        self.legacy = legacy
        if session is None:
            import requests
            session = requests.Session()
        self.session = session
        self.signer = signer or self._sign_request
        self.min_interval = max(0, float(min_interval))
        self._request_lock = threading.Lock()
        self._last_request = 0.0

    def __getattr__(self, name):
        return getattr(self.legacy, name)

    @staticmethod
    def _sign_request(video_id):
        tool = Path(__file__).parent / 'vendor/hongguo-sign/sign.cjs'
        try:
            process = subprocess.run(['/usr/local/bin/hongguo-node', '--max-old-space-size=64', str(tool)],
                                     input=json.dumps({'video_id': video_id}), capture_output=True,
                                     text=True, timeout=3, env={'LANG': 'C.UTF-8'})
            if process.returncode or len(process.stdout) > 65536:
                raise ValueError('invalid signer result')
            signed = json.loads(process.stdout)
            parsed = urlparse(signed['url'])
            if parsed.scheme != 'https' or parsed.netloc != 'api5-normal-sinfonlineb.fqnovel.com' or parsed.path != '/novel/player/multi_video_model/v1/':
                raise ValueError('invalid signing target')
            return signed
        except Exception as exc:
            raise HongguoSourceError('本地高清签名暂不可用；未切换旧接口或低清源') from exc

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
        with self._request_lock:
            delay = self.min_interval - (time.monotonic() - self._last_request)
            if delay > 0:
                time.sleep(delay)
            signed = self.signer(video_id)
            response = None
            try:
                response = self.session.post(
                    signed['url'], data=signed['body'].encode(),
                    headers=signed['headers'], timeout=(3, 12))
                response.raise_for_status()
                if not response.content:
                    raise HongguoSourceError('高清取流接口返回空响应；未回退旧接口或低清源，请稍后重试')
                result = response.json()
                if not isinstance(result, dict):
                    raise ValueError('invalid model response')
            except HongguoSourceError:
                raise
            except Exception as exc:
                raise HongguoSourceError("高清取流接口响应失败；未回退旧接口或低清源，请稍后重试") from exc
            finally:
                if response is not None:
                    response.close()
                self._last_request = time.monotonic()
        code = result.get("Code", result.get("code"))
        if code not in (None, 0, "0"):
            raise HongguoSourceError(f"新版播放源暂时不可用（{str(code)[:20]}）")
        data = result.get("data") or {}
        entry = data.get(video_id) if isinstance(data, dict) else None
        model = entry.get("video_model") if isinstance(entry, dict) else None
        if isinstance(model, str):
            try:
                model = json.loads(model)
            except ValueError as exc:
                raise HongguoSourceError("新版播放源数据格式异常") from exc
        if not isinstance(model, dict):
            raise HongguoSourceError("固定播放源未提供有效的视频模型")
        tracks = model.get("video_list") or []
        if isinstance(tracks, dict):
            tracks = [tracks[key] for key in sorted(tracks)]
        normalized = []
        for track in tracks if isinstance(tracks, list) else []:
            if not isinstance(track, dict):
                continue
            meta = track.get("video_meta") or track
            if str(meta.get("definition", "")).lower() not in ("720p", "1080p"):
                continue
            if str(meta.get('codec_type', '')).lower() not in ('h264', 'avc', 'avc1', 'h265', 'hevc', 'hvc1', 'hev1', 'bytevc1'):
                continue
            try:
                dimensions = [int(meta.get(name) or 0) for name in ("vwidth", "vheight")]
            except (ValueError, TypeError):
                continue
            if not all(dimensions) or min(dimensions) < 720:
                continue
            definition = '1080p' if min(dimensions) >= 1080 else '720p'
            addresses = self._media_urls(track)
            if addresses:
                normalized.append({**track, "main_url": addresses[0],
                                   "coding_urls": addresses,
                                   "video_meta": {**{name: meta.get(name) for name in
                                                  ("size", "codec_type", "vwidth", "vheight")},
                                                  "definition": definition},
                                   "encrypt_info": track.get("encrypt_info") or {
                                       "encrypt": bool(track.get("encrypt")), "spade_a": track.get("spade_a")}})
        if not normalized:
            raise HongguoSourceError("当前固定播放源没有可用的720p/1080p轨道；未切换旧接口或低清源")
        best = max(int(t['video_meta']['definition'][:-1]) for t in normalized)
        return [t for t in normalized if int(t['video_meta']['definition'][:-1]) == best]

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
        unresolved = [value for value in failures if not output.get(value)]
        if unresolved and len(vids) == 1:
            raise failures[unresolved[0]]
        return output
