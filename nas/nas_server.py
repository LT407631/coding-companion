"""NAS entry point: serve the existing UI and check the local signer."""
import os
import shutil
import inspect
from functools import wraps
from urllib.parse import urlparse
import time
from pathlib import Path

import requests
import uvicorn
from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse, RedirectResponse, Response

import server
from seasons import SeasonCache
from playback_cache import PlaybackCache, validate_media
from catalog_cache import CatalogCache, Payload, json_bytes, request_key, response_headers, not_modified
from site_auth import SiteAuth, install_auth
from device_media import descriptors
from phone_input import install_phone_input
from tv_updates import install_tv_updates
from library import install_library
from cover_cache import encode_cover
from tv_compat import TvCompatibilityCache
from watch_state import WatchState, install_watch_state
from watch_updates import install_watch_updates
from watch_profiles import WatchProfiles, install_watch_profiles
from search_pages import install_search
from source_requests import SourceRequests
from media_source import MediaSource
from hongguo_track_provider import HongguoTrackProvider, download_with_fallback
from timings import Timings, TimingMiddleware

app = server.app
timings = Timings()
source = SourceRequests(server.H, timings)
app.add_middleware(TimingMiddleware, timings=timings)
app.router.routes = [route for route in app.router.routes if getattr(route, "path", None) not in {"/", "/stream", "/prefetch", "/img"}]
site_auth = SiteAuth(Path(server.H.OUT_DIR) / ".site_auth.sqlite3")
install_auth(app, site_auth, Path(__file__).parent / "web" / "login.html")
install_phone_input(app, Path(__file__).parent / "web")
install_tv_updates(app, os.environ.get('CODING_TV_UPDATE_DIR', str(Path(server.H.OUT_DIR) / 'tv-updates')))
season_cache = SeasonCache(Path(server.H.OUT_DIR) / ".season_cache.json")
tv_compat = TvCompatibilityCache(Path(server.H.OUT_DIR) / ".tv_compat")


catalog = CatalogCache(Path(server.H.OUT_DIR) / ".catalog_cache")
search_pages = install_search(app, source, catalog)
install_library(app, server.H, catalog)
watch_state = WatchState(Path(server.H.OUT_DIR) / '.watch_state.sqlite3')
def follow_count(sid):
    key = request_key('/episodes', {'series_id': sid})
    def load(previous):
        if previous is not None:
            server.H.SG.cache_set(server.H.SG.cache_key('episodes', sid), None, ttl=0)
        meta, episodes = server.H.get_episodes(sid)
        return Payload(json_bytes({'meta': meta, 'episodes': episodes}))
    entry, cache_state = catalog.get(key, load, 21600)
    if cache_state == 'STALE':
        raise RuntimeError('剧集缓存正在刷新，稍后检查追更')
    import json
    return len(json.loads(entry.body)['episodes'])
watch_profiles = WatchProfiles(Path(server.H.OUT_DIR) / '.watch_profiles.sqlite3', watch_state, follow_count)
install_watch_profiles(app, watch_profiles)
install_watch_state(app, watch_state, resolve=watch_profiles.state)
install_watch_updates(app, None, resolve=watch_profiles.updates)
TTL = {"/filters": 86400, "/rank": 1800, "/latest": 900, "/browse": 900, "/episodes": 21600}


def cached_endpoint(path, original):
    @wraps(original)
    def cached(**values):
        request = values.pop("_request")
        key = request_key(path, values)
        refresh = request.query_params.get("refresh", "").lower() in {"true", "1"} or bool(values.get("no_cache"))
        def load(previous):
            # The upstream rank/episodes helper also has a memory cache; expire only
            # this exact cache entry when our persistent snapshot is due for a check.
            if previous is not None:
                h = server.H
                if path in {"/rank", "/episodes"}:
                    parts = ("rank", values["board"], values["limit"]) if path == "/rank" else ("episodes", str(values["series_id"]))
                    h.SG.cache_set(h.SG.cache_key(*parts), None, ttl=0)
            return Payload(json_bytes(original(**values)))
        try:
            entry, state = catalog.get(key, load, TTL[path], refresh)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, "暂时无法获取片单，请稍后重试") from exc
        headers = response_headers(entry, state)
        if not_modified(request.headers.get("if-none-match"), entry.etag):
            return Response(status_code=304, headers=headers)
        return Response(entry.body, media_type=entry.media_type, headers=headers)
    params = list(inspect.signature(original).parameters.values())
    params.append(inspect.Parameter("_request", inspect.Parameter.KEYWORD_ONLY, annotation=Request))
    cached.__signature__ = inspect.signature(original).replace(parameters=params)
    return cached


# Preserve each existing endpoint's query validation and response format.
for path in TTL:
    original_route = next(r for r in app.router.routes if getattr(r, "path", None) == path)
    app.router.routes.remove(original_route)
    app.add_api_route(path, cached_endpoint(path, original_route.endpoint), methods=["GET"])


@app.get("/img")
def cached_cover(request: Request, url: str, w: int = Query(0, ge=0, le=480)):
    if w not in (0, 320, 480):
        raise HTTPException(400, "封面尺寸无效")
    raw = url.strip()
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not any(host == h or host.endswith("." + h) for h in server._IMG_HOSTS):
        raise HTTPException(400, "图片域名不允许")
    def load(previous):
        # Reuse legacy NAS covers when generating a new size, without downloading again.
        original = catalog.read('/img:' + raw) if w else None
        if original and time.time() - original.checked < 7 * 86400:
            return Payload(encode_cover(original.body, w), 'image/jpeg')
        conditional = {"User-Agent": "Mozilla/5.0"}
        if previous:
            if previous.source_etag:
                conditional["If-None-Match"] = previous.source_etag
            if previous.source_modified:
                conditional["If-Modified-Since"] = previous.source_modified
        with timings.measure('cover'):
            response = requests.get(raw, timeout=20, verify=False, headers=conditional)
        try:
            if response.status_code == 304 and previous:
                return None
            response.raise_for_status()
            data = response.content
            if len(data) > 20 * 1024**2:
                raise ValueError("封面过大")
            if not server._IMG_OK:
                raise RuntimeError("图片解码服务未就绪")
            return Payload(encode_cover(data, w), "image/jpeg", response.headers.get("ETag", ""), response.headers.get("Last-Modified", ""))
        finally:
            response.close()
    try:
        key = ("/img:" if not w else "/img:w" + str(w) + ":") + raw
        entry, state = catalog.get(key, load, 7 * 86400)
    except Exception as exc:
        raise HTTPException(404, "封面暂时无法读取") from exc
    headers = response_headers(entry, state, max_age=86400)
    if not_modified(request.headers.get("if-none-match"), entry.etag):
        return Response(status_code=304, headers=headers)
    return Response(entry.body, media_type=entry.media_type, headers=headers)


def track_request(operation):
    with timings.measure('tracks'):
        return source.run(operation, budget=20)


track_provider = HongguoTrackProvider(server.H)
media_source = MediaSource(track_provider, call=track_request)


def build_media(vid, stage):
    try:
        track = media_source.track(vid)
        target = str(stage) + '.enc' if track['encrypt'] else str(stage)
        with timings.measure('download'):
            # A single CDN hostname can stall while another URL for the same track works.
            download_with_fallback(track.get('urls') or [track['url']], target,
                                   server.H.http_request)
        if track['encrypt']:
            with timings.measure('decrypt'):
                result = server.OD.offline_decrypt(track['spade_a'], target, str(stage))
            if result != str(stage):
                raise RuntimeError('重封装失败，未生成浏览器可播放文件')
    except Exception:
        # Only a failed descriptor is refreshed; valid upcoming tracks remain reusable.
        media_source.invalidate(vid)
        raise


def checked_media(path):
    with timings.measure('validate'):
        return validate_media(path)


playback = PlaybackCache(server.STREAM_CACHE, build_media, validate=checked_media,
                         prepare_tracks=media_source.prefetch, foreground_worker=True)


@app.get("/ui/assets/{name}", include_in_schema=False)
def browser_asset(name: str):
    if name not in {"device-media.js", "device-worker.js", "device-crypto.js", "coding-companion.svg", "library.js", "library-grid.js", "library-store.js", "library-scroll.js", "library.css", "settings.js", "page-requests.js", "watch-state.js", "watch-ui.js", "watch-ui.css", "profiles.js", "seasons.js", "search.js", "playback-status.js"}:
        raise HTTPException(404)
    return FileResponse(Path(__file__).parent / "web" / "assets" / name, headers={"Cache-Control": "private, max-age=0, must-revalidate"})


@app.get("/device/manifest")
def device_manifest(series_id: str = Query(..., pattern=r"^\d{1,24}$"), ep: int = Query(1, ge=1, le=10000),
                    count: int = Query(4, ge=1, le=5), force: bool = False):
    try:
        return JSONResponse(descriptors(track_provider, series_id, ep, count, force=force), headers={"Cache-Control": "no-store"})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, "暂时无法获取设备直连地址，请重试") from exc


class PrepareRequest(BaseModel):
    client: str = Field(pattern=r"^[a-zA-Z0-9-]{8,80}$")
    series_id: str = Field(pattern=r"^\d{1,24}$")
    ep: int = Field(ge=1, le=10000)
    completed: int = Field(default=0, ge=0, le=10000)
    retry: bool = False


class CloseRequest(BaseModel):
    client: str = Field(pattern=r"^[a-zA-Z0-9-]{8,80}$")
    finished: bool = False


class CompleteRequest(BaseModel):
    client: str = Field(pattern=r"^[a-zA-Z0-9-]{8,80}$")
    ep: int = Field(ge=1, le=10000)


class CacheSettings(BaseModel):
    mode: str
    ahead: int = Field(default=5, ge=1, le=10)
    smart_after: int = Field(default=3, ge=2, le=10)
    cleanup: bool = True
    cleanup_previous: bool = False
    limit_gb: int = Field(default=20, ge=1, le=50)


@app.get("/playback/settings")
def cache_settings():
    return playback.status()


@app.get('/performance')
def performance():
    return JSONResponse({'phases': timings.snapshot()}, headers={'Cache-Control': 'no-store'})


@app.post("/playback/settings")
def save_cache_settings(settings: CacheSettings):
    try:
        return playback.configure(settings.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/playback/prepare")
def prepare(body: PrepareRequest):
    try:
        _, eps = server.H.get_episodes(body.series_id)
        return playback.prepare(body.client, body.series_id, eps, body.ep, body.completed, body.retry)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, "暂时无法取得选集列表，请重试") from exc


@app.get("/playback/status")
def playback_status(series_id: str = Query(..., pattern=r"^\d{1,24}$"), ep: int = Query(1, ge=1)):
    return playback.status(series_id, ep)


@app.post("/playback/close")
def playback_close(body: CloseRequest):
    playback.close(body.client, body.finished)
    return {"ok": True}


@app.post("/playback/complete")
def playback_complete(body: CompleteRequest):
    try:
        return playback.complete(body.client, body.ep)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/cache/clear")
def clear_all_cache():
    result = playback.clear_all()
    result["catalog_entries"] = catalog.clear()
    season_cache.clear()
    return result


class LeasedFileResponse(FileResponse):
    def __init__(self, path, vid, compatibility_path=None):
        super().__init__(path, media_type="video/mp4")
        self.vid = vid
        self.compatibility_path = compatibility_path

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # A disconnected browser must not leave a permanent cleanup lease.
            playback.release(self.vid)
            if self.compatibility_path is not None:
                tv_compat.release(self.compatibility_path)


@app.get("/stream")
def stream(series_id: str = Query(None, pattern=r"^\d{1,24}$"), ep: int = Query(1, ge=1), vid: str = Query(None, pattern=r"^\d{1,24}$"), tv_profile: str = Query("", pattern=r"^(|tcl-hevc)$")):
    if not vid:
        if not series_id:
            raise HTTPException(400, "缺少剧集编号")
        _, eps = server.H.get_episodes(series_id)
        target = next((e for e in eps if int(e["index"]) == ep), None)
        if not target:
            raise HTTPException(404, "集数不存在")
        vid = str(target["vid"])
    playback.acquire(vid)
    compatibility_path = None
    try:
        with timings.measure('stream'):
            path = playback.ensure(vid)
        if tv_profile == "tcl-hevc":
            path = compatibility_path = tv_compat.acquire(path)
        return LeasedFileResponse(path, vid, compatibility_path)
    except Exception as exc:
        playback.release(vid)
        if compatibility_path is not None:
            tv_compat.release(compatibility_path)
        raise HTTPException(502, str(exc)) from exc


@app.get("/")
def home():
    return RedirectResponse("/ui")


@app.get("/seasons")
def seasons(series_id: str = Query(..., pattern=r"^\d{1,24}$"), refresh: bool = False,
            search_hint: str = Query("", max_length=100)):
    try:
        return season_cache.get(server.H, series_id, refresh=refresh, search_hint=search_hint)
    except Exception as exc:
        raise HTTPException(502, "暂时无法获取全部季，请重试") from exc


@app.get("/healthz")
def health():
    ready = False
    try:
        base = server.H.SIGN_SERVERS[0].rstrip("/")
        url = server.H.build_url("/novel/player/multi_video_model/v1/")
        response = requests.post(base + "/sign", json={"url": url, "headers": server.H.CFG["session_headers"]}, timeout=15)
        response.raise_for_status()
        headers = response.json()
        ready = "error" not in headers and any(key.lower() == "x-argus" for key in headers)
    except (IndexError, ValueError, requests.RequestException):
        pass
    ffmpeg = bool(shutil.which("ffmpeg"))
    return JSONResponse({"api": True, "sign": ready, "ffmpeg": ffmpeg}, status_code=200 if ready and ffmpeg else 503)


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("BIND_HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8000")), proxy_headers=False)
