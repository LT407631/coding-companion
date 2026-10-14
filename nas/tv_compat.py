"""Opt-in HEVC metadata copies; never overwrite the normal playback cache."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading


def probe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "stream=codec_name,profile,width,height,level",
                             "-of", "json", str(path)], capture_output=True, timeout=15, check=True)
    streams = json.loads(result.stdout).get("streams", [])
    if len(streams) != 1:
        raise RuntimeError("兼容视频缺少视频轨道")
    return streams[0]


def convert(source, target):
    # Stream copy changes parameter sets, not encoded pictures or audio samples.
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
                    "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
                    "-bsf:v", "hevc_metadata=level=auto", "-tag:v", "hvc1",
                    "-movflags", "+faststart", "-f", "mp4", str(target)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=45, check=True)


def content_digest(source, size):
    # PlaybackCache touches mtime on each Range read. Hash content in bounded
    # chunks instead; inode alone would miss an in-place replacement.
    digest = hashlib.sha256()
    total = 0
    with source.open("rb") as reader:
        initial = os.fstat(reader.fileno())
        if initial.st_size != size:
            raise RuntimeError("原视频发生变化，请重试本集")
        while block := reader.read(64 * 1024):
            total += len(block)
            if total > size:
                raise RuntimeError("原视频发生变化，请重试本集")
            digest.update(block)
        final = source.stat()
    if total != size or (final.st_dev, final.st_ino, final.st_size) != (initial.st_dev, initial.st_ino, size):
        raise RuntimeError("原视频发生变化，请重试本集")
    return digest.hexdigest()


class TvCompatibilityCache:
    def __init__(self, root, inspect=probe, remux=convert, max_bytes=128 * 1024**2, max_files=2):
        self.root = Path(root)
        self.inspect, self.remux = inspect, remux
        self.max_bytes, self.max_files = max_bytes, max_files
        self.guard = threading.Lock()
        self.leases = {}

    def _trim(self, incoming=0, new_file=False):
        files = sorted(self.root.glob("*.mp4"), key=lambda p: p.stat().st_mtime_ns)
        size, count = sum(p.stat().st_size for p in files), len(files)
        for path in files:
            if size + incoming <= self.max_bytes and count + int(new_file) <= self.max_files:
                break
            if self.leases.get(path, 0):
                continue
            size -= path.stat().st_size
            count -= 1
            path.unlink()
        if size + incoming > self.max_bytes or count + int(new_file) > self.max_files:
            raise RuntimeError("TCL兼容缓存正在使用，请稍后重试")

    def acquire(self, source):
        source = Path(source)
        if not self.guard.acquire(timeout=25):
            raise RuntimeError("TCL兼容视频正在准备，请稍后重试")
        try:
            stat = source.stat()
            info = self.inspect(source)
            if info.get("codec_name") != "hevc" or 0 < info.get("level", 0) <= 153:
                return source
            # Bound one stream-copy process and reserve space before starting it.
            reserve = stat.st_size + 1024**2
            if reserve > self.max_bytes // 2:
                raise RuntimeError("本集超出TCL兼容缓存容量")
            digest = content_digest(source, stat.st_size)
            fingerprint = f"content-v2:{source.name}:{stat.st_size}:{digest}"
            key = hashlib.sha256(fingerprint.encode()).hexdigest()[:24]
            target = self.root / (key + ".mp4")
            if target.is_file():
                self.leases[target] = self.leases.get(target, 0) + 1
                return target
            self.root.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self.root).free < reserve + 2 * 1024**3:
                raise RuntimeError("NAS可用空间不足，无法准备TCL兼容视频")
            self._trim(reserve, True)
            temporary = target.with_suffix(".part")
            try:
                self.remux(source, temporary)
                adjusted = self.inspect(temporary)
                if (adjusted.get("codec_name") != "hevc"
                        or not 0 < adjusted.get("level", 0) <= 153
                        or any(adjusted.get(k) != info.get(k) for k in ("width", "height", "profile"))):
                    raise RuntimeError("本集参数无法自动兼容TCL，原视频已保留")
                if temporary.stat().st_size > reserve:
                    raise RuntimeError("TCL兼容视频超出预留容量")
                if content_digest(source, stat.st_size) != digest:
                    raise RuntimeError("原视频发生变化，请重试本集")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
            self.leases[target] = 1
            return target
        finally:
            self.guard.release()

    def release(self, path):
        path = Path(path)
        with self.guard:
            count = self.leases.get(path, 0)
            if count <= 1:
                self.leases.pop(path, None)
            else:
                self.leases[path] = count - 1
