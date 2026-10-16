"""Bounded playback preparation queue and atomic, validated media cache."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import re
from media_source import PermanentSourceError
from source_requests import SourceUnavailable

DEFAULTS = {"mode": "ahead", "ahead": 5, "smart_after": 3, "cleanup": True, "cleanup_previous": False, "limit_gb": 20}
MODES = {"off", "ahead", "full", "smart"}
CACHE_ID = re.compile(r"^\d{1,24}(?:q(?:1080|720|540|480|360))?$")


def validate_media(path):
    try:
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, timeout=30)
        data = json.loads(probe.stdout)
        streams = data.get("streams", [])
        if probe.returncode or float(data.get("format", {}).get("duration", 0)) <= 0:
            return False
        if not any(s.get("codec_type") == "video" and s.get("codec_name") in {"hevc", "h264", "av1"} for s in streams):
            return False
        if any(s.get("codec_tag_string") in {"encv", "enca"} for s in streams):
            return False
        check = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-t", "2", "-f", "null", "-"], capture_output=True, timeout=40)
        return check.returncode == 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


class CacheCancelled(RuntimeError):
    pass


class PlaybackCache:
    def __init__(self, root, build, validate=validate_media, start=True, reserve=2 * 1024**3,
                 prepare_tracks=None, foreground_worker=False):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.build = build
        self.validate = validate
        self.reserve = reserve
        self.prepare_tracks = prepare_tracks
        self.build_slots = threading.BoundedSemaphore(2 if foreground_worker else 1)
        self.guard = threading.Condition(threading.RLock())
        self.locks = {}
        self.valid = {}
        self.jobs = {}
        self.results = {}
        self.sessions = {}
        self.closed = {}
        self.leases = {}
        self.pending_cleanup = set()
        self.inflight = {}
        self.writers = set()
        self.reservations = {}
        self.pending_vids = set()
        self.generation = 0
        self.serial = 0
        self.state_path = self.root.parent / ".playback_cache.json"
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            state = {}
        self.settings = {**DEFAULTS, **state.get("settings", {})}
        self.series = state.get("series", {})
        self.pending_vids = {str(v) for v in state.get("pending_vids", []) if CACHE_ID.fullmatch(str(v))}
        self.pending_cleanup = set(state.get("pending_cleanup", []))
        # Only our unfinished staging files are disposable after a restart.
        for p in self.root.glob("*.work*"):
            p.unlink(missing_ok=True)
        if start:
            threading.Thread(target=self._worker, daemon=True, name="playback-cache").start()
            if foreground_worker:
                threading.Thread(target=self._worker, args=(True,), daemon=True, name="playback-current").start()

    def _persist(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"settings": self.settings, "series": self.series, "pending_vids": sorted(self.pending_vids), "pending_cleanup": sorted(self.pending_cleanup)}, ensure_ascii=False))
        os.chmod(tmp, 0o600)
        tmp.replace(self.state_path)

    def configure(self, values):
        if values.get("mode") not in MODES:
            raise ValueError("缓存方式无效")
        result = {"mode": values["mode"], "ahead": int(values.get("ahead", 5)), "smart_after": int(values.get("smart_after", 3)), "cleanup": bool(values.get("cleanup", True)), "cleanup_previous": bool(values.get("cleanup_previous", False)), "limit_gb": int(values.get("limit_gb", 20))}
        if not 1 <= result["ahead"] <= 10 or not 2 <= result["smart_after"] <= 10 or not 1 <= result["limit_gb"] <= 50:
            raise ValueError("集数或容量超出允许范围")
        with self.guard:
            self.settings = result
            # The next heartbeat rebuilds the desired queue with the new settings.
            self.jobs.clear()
            self.results = {k: v for k, v in self.results.items() if v["state"] not in {"queued", "error"}}
            self._persist()
            return dict(result)

    def path(self, vid):
        if not CACHE_ID.fullmatch(str(vid)):
            raise ValueError("视频编号无效")
        return self.root / (str(vid) + "_best.mp4")

    def _ready(self, path):
        if not path.exists():
            return False
        try:
            stat = path.stat()
        except FileNotFoundError:
            return False
        fingerprint = (stat.st_size, stat.st_mtime_ns)
        return stat.st_size > 0 and self.valid.get(str(path)) == fingerprint

    def _active(self):
        now = time.monotonic()
        self.sessions = {k: v for k, v in self.sessions.items() if v["until"] > now}
        return self.sessions.values()

    def _protected(self):
        vids = set(self.leases)
        for session in self._active():
            for ep, vid in self.series.get(session["sid"], {}).items():
                if int(ep) in session["wanted"]:
                    vids.add(vid)
        return {self.path(v) for v in vids}

    def _room(self, need, foreground, vid=None):
        with self.guard:
            protected = self._protected()
            if foreground:
                # A viewer's current episode takes precedence over old ahead-cache files.
                protected = {self.path(v) for v in self.leases}
                for s in self._active():
                    current_vid = self.series.get(s["sid"], {}).get(str(s["ep"]))
                    if current_vid:
                        protected.add(self.path(current_vid))
            protected.update(self.path(v) for v in self.writers)
            files = list(self.root.glob("*_best.mp4"))
            used = sum(p.stat().st_size for p in files)
            reserved = sum(n for v, n in self.reservations.items() if v != vid)
            quota = self.settings["limit_gb"] * 1024**3
            for p in sorted(files, key=lambda x: x.stat().st_mtime):
                free = shutil.disk_usage(self.root).free
                if used + reserved + need <= quota and free - reserved - need >= self.reserve:
                    if vid is not None:
                        self.reservations[vid] = need
                    return
                if p not in protected:
                    used -= p.stat().st_size
                    p.unlink(missing_ok=True)
                    self.valid.pop(str(p), None)
            if used + reserved + need > quota or shutil.disk_usage(self.root).free - reserved - need < self.reserve:
                raise RuntimeError("缓存容量不足：请增大设置中的上限，或等待已观看缓存释放")
            if vid is not None:
                self.reservations[vid] = need

    def ensure(self, vid, foreground=True, generation=None):
        path = self.path(vid)
        with self.guard:
            lock = self.locks.setdefault(str(vid), threading.Lock())
        # No cache read occurs before the same-video writer has finished.
        with lock:
            with self.build_slots:
                with self.guard:
                    self.writers.add(str(vid))
                try:
                    return self._ensure(str(vid), path, foreground, generation)
                finally:
                    with self.guard:
                        self.writers.discard(str(vid))
                        self.reservations.pop(str(vid), None)
                        self._cleanup()

    def _ensure(self, vid, path, foreground, generation):
        # Same-video lock, a bounded build slot and writer protection are held.
        with self.guard:
            if generation is None:
                generation = self.generation
        if not self._ready(path) and path.exists():
            if self.validate(path):
                st = path.stat()
                self.valid[str(path)] = (st.st_size, st.st_mtime_ns)
            else:
                path.unlink(missing_ok=True)
        if self._ready(path):
            os.utime(path, None)
            st = path.stat()
            self.valid[str(path)] = (st.st_size, st.st_mtime_ns)
            return path
        stage = self.root / (vid + ".work.mp4")
        for attempt in range(3):
            try:
                # Reserve space for both workers even if source size is absent.
                self._room(64 * 1024**2, foreground, vid)
                self.build(vid, stage)
                if not stage.exists() or not self.validate(stage):
                    raise RuntimeError("视频未完整解密或无法解码")
                self._room(stage.stat().st_size, foreground, vid)
                with self.guard:
                    if generation != self.generation and path not in self._protected():
                        raise CacheCancelled("缓存任务已取消")
                    stage.replace(path)
                    self.reservations.pop(vid, None)
                    st = path.stat()
                    self.valid[str(path)] = (st.st_size, st.st_mtime_ns)
                    return path
            except (CacheCancelled, PermanentSourceError, SourceUnavailable):
                raise
            except Exception as exc:
                if "容量不足" in str(exc):
                    raise
                if attempt == 2:
                    raise RuntimeError("下载或解密失败，已自动重试 3 次；请稍后重试") from exc
                time.sleep(1 + attempt)
            finally:
                for p in self.root.glob(vid + ".work*"):
                    p.unlink(missing_ok=True)

    def prepare(self, client, sid, eps, ep, completed=0, retry=False, preview=False, background=False):
        with self.guard:
            background = bool(background and preview)
            self.closed = {k: t for k, t in self.closed.items() if t > time.monotonic()}
            if client in self.closed:
                return self.status(sid, ep)
            self.pending_cleanup.discard(sid)
            by_ep = {int(e["index"]): str(e["vid"]) for e in eps if e.get("vid")}
            if ep not in by_ep:
                raise ValueError("集数不存在")
            old = self.series.get(sid)
            self.series[sid] = {str(i): v for i, v in by_ep.items()}
            if old != self.series[sid]:
                self._persist()
            mode = self.settings["mode"]
            full = mode == "full" or (mode == "smart" and completed >= self.settings["smart_after"])
            count = 0 if preview else (len(by_ep) if full else (0 if mode == "off" else self.settings["ahead"]))
            previous = self.sessions.get(client, {})
            same = previous.get("sid") == sid and previous.get("ep") == ep
            paused = same and previous.get("cache_paused", False) and not retry
            ended = same and previous.get("ended", False) and not retry
            wanted = {n for n in by_ep if ep <= n <= ep + (0 if paused else count) and not (ended and n == ep)}
            self.sessions[client] = {"sid": sid, "ep": ep, "wanted": wanted,
                                     "until": time.monotonic() + (600 if background else 60),
                                     "cache_paused": paused, "ended": ended, "preview": bool(preview),
                                     "background": background}
            active = list(self._active())
            # Discard obsolete waiting jobs; an in-progress preparation can finish safely.
            self.jobs = {k: v for k, v in self.jobs.items() if any(s["sid"] == k[0] and k[1] in s["wanted"] for s in active)}
            for n in sorted(wanted):
                key = (sid, n)
                if retry and n == ep and self.results.get(key, {}).get("state") != "working":
                    self.results.pop(key, None)
                if self._ready(self.path(by_ep[n])):
                    self.results[key] = {"state": "ready"}
                    continue
                previous_result = self.results.get(key, {})
                state = previous_result.get("state")
                if not background and n == ep and state == "error" and previous_result.get("background"):
                    self.results.pop(key, None)
                    state = None
                if state == "working" or (state == "error" and not (retry and n == ep)):
                    continue
                priority = 2 if background else (0 if n == ep else (2 if full else 1))
                self.serial += 1
                job = (priority, self.serial, by_ep[n])
                if key not in self.jobs or priority < self.jobs[key][0]:
                    self.jobs[key] = job
                self.results[key] = {"state": "queued", "background": background}
            self.guard.notify_all()
            return self.status(sid, ep)

    def _worker(self, foreground_only=False):
        while True:
            with self.guard:
                self._cleanup()
                active = list(self._active())
                self.jobs = {k: v for k, v in self.jobs.items() if any(s["sid"] == k[0] and k[1] in s["wanted"] for s in active)}
                eligible = [k for k, job in self.jobs.items() if not foreground_only or job[0] == 0]
                if not eligible:
                    self.guard.wait(5)
                    continue
                key = min(eligible, key=lambda k: self.jobs[k][:2])
                priority, _, vid = self.jobs.pop(key)
                self.inflight[key] = vid
                generation = self.generation
                background = bool(self.results.get(key, {}).get("background"))
                self.results[key] = {"state": "working", "background": background}
                following = sorted((k for k in self.jobs if k[0] == key[0] and k[1] > key[1]), key=lambda k: k[1])
                batch = [vid] + [self.jobs[k][2] for k in following[:4]]
            try:
                if self.prepare_tracks:
                    try:
                        self.prepare_tracks(batch)
                    except (PermanentSourceError, SourceUnavailable):
                        raise
                    except Exception:
                        pass  # Direct build still resolves current track on demand.
                self.ensure(vid, foreground=priority == 0, generation=generation)
                result = {"state": "ready", "background": background}
            except Exception as exc:
                result = {"state": "error", "message": str(exc), "background": background}
            with self.guard:
                if generation == self.generation or key in self.jobs:
                    self.results[key] = result
                self.inflight.pop(key, None)
                self._cleanup()
                self.guard.notify_all()

    def acquire(self, vid):
        with self.guard:
            self.leases[str(vid)] = self.leases.get(str(vid), 0) + 1

    def release(self, vid):
        with self.guard:
            self.leases[str(vid)] -= 1
            if not self.leases[str(vid)]:
                del self.leases[str(vid)]
            self._cleanup()

    def close(self, client, finished=False):
        with self.guard:
            self.closed[client] = time.monotonic() + 90
            s = self.sessions.pop(client, None)
            if s and finished and (self.settings["cleanup"] or self.settings["cleanup_previous"]):
                self.pending_cleanup.add(s["sid"])
                self._persist()
            self._cleanup()
            self.guard.notify_all()

    def complete(self, client, ep):
        with self.guard:
            session = self.sessions.get(client)
            if not session or session["ep"] != ep:
                raise ValueError("播放会话已切换")
            if self.settings["cleanup_previous"]:
                session["ended"] = True
                session["wanted"] = {n for n in session["wanted"] if n > ep}
                self.pending_vids.update(vid for n, vid in self.series.get(session["sid"], {}).items() if int(n) <= ep)
                active = list(self._active())
                self.jobs = {k: v for k, v in self.jobs.items() if any(s["sid"] == k[0] and k[1] in s["wanted"] for s in active)}
                self._cleanup()
                self._persist()
                self.guard.notify_all()
            return {"ok": True, "cleanup_pending": len(self.pending_vids)}

    def clear_all(self):
        with self.guard:
            self.generation += 1
            self.jobs.clear()
            self.results.clear()
            for session in self._active():
                session["wanted"] = set() if session.get("ended") else {session["ep"]}
                session["cache_paused"] = True
            self.pending_vids.update(p.stem.removesuffix("_best") for p in self.root.glob("*_best.mp4")
                                     if CACHE_ID.fullmatch(p.stem.removesuffix("_best")))
            self.pending_vids.update(self.inflight.values())
            self.pending_vids.update(self.writers)
            self._cleanup()
            self._persist()
            self.guard.notify_all()
            return {"ok": True, "deferred_videos": len(self.pending_vids)}

    def _cleanup(self):
        before = set(self.pending_vids)
        protected = self._protected()
        for vid in list(self.pending_vids):
            if self.path(vid) in protected or vid in self.inflight.values() or vid in self.writers:
                continue
            path = self.path(vid)
            path.unlink(missing_ok=True)
            self.valid.pop(str(path), None)
            self.results = {k: v for k, v in self.results.items() if self.series.get(k[0], {}).get(str(k[1])) != vid}
            self.pending_vids.remove(vid)
        if self.pending_vids != before:
            self._persist()
        active = {s["sid"] for s in self._active()}
        for sid in list(self.pending_cleanup):
            if sid in active or any(k[0] == sid for k in self.inflight):
                continue
            vids = set(self.series.get(sid, {}).values())
            if vids.intersection(self.leases) or vids.intersection(self.writers):
                continue
            other = {v for s, episodes in self.series.items() if s != sid for v in episodes.values()}
            for vid in vids - other:
                path = self.path(vid)
                path.unlink(missing_ok=True)
                self.valid.pop(str(path), None)
            self.jobs = {k: v for k, v in self.jobs.items() if k[0] != sid}
            self.results = {k: v for k, v in self.results.items() if k[0] != sid}
            self.series.pop(sid, None)
            self.pending_cleanup.remove(sid)
            self._persist()

    def status(self, sid=None, ep=None):
        with self.guard:
            self._cleanup()
            episodes = {}
            for n, vid in self.series.get(sid, {}).items():
                episodes[n] = {"state": "ready"} if self._ready(self.path(vid)) else self.results.get((sid, int(n)), {"state": "idle"})
                if episodes[n]["state"] == "ready" and not self._ready(self.path(vid)):
                    episodes[n] = {"state": "idle"}
            files = list(self.root.glob("*_best.mp4"))
            return {"settings": dict(self.settings), "episodes": episodes, "current": episodes.get(str(ep), {"state": "idle"}), "ready": sum(v["state"] == "ready" for v in episodes.values()), "queued": sum(v["state"] in {"queued", "working"} for v in episodes.values()), "errors": sum(v["state"] == "error" for v in episodes.values()), "used_bytes": sum(p.stat().st_size for p in files), "free_bytes": shutil.disk_usage(self.root).free, "cleanup_pending": len(self.pending_vids)}
