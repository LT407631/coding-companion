import ast
import asyncio
import concurrent.futures
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
import unittest
from types import SimpleNamespace

from tv_compat import TvCompatibilityCache, probe


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        work = Path(os.environ["CODING_TEST_TEMP_ROOT"]) if "CODING_TEST_TEMP_ROOT" in os.environ else Path(__file__).resolve().parents[3] / "临时/TCL流畅度/缓存测试"
        work.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=work)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "original.mp4"
        self.source.write_bytes(b"original-video-audio")
        self.calls = []

    def inspect(self, path):
        return {"codec_name": "hevc", "level": 150 if path.suffix == ".part" else 186,
                "width": 1920, "height": 1080, "profile": "Main"}

    def remux(self, source, target):
        self.calls.append(source)
        shutil.copyfile(source, target)

    def cache(self, **kwargs):
        return TvCompatibilityCache(self.root / "compat", self.inspect, self.remux, **kwargs)

    def test_original_and_parallel_reuse(self):
        cache = self.cache()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(cache.acquire, [self.source] * 4))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(self.source.read_bytes(), b"original-video-audio")
        self.assertEqual(cache.leases[results[0]], 4)
        for path in results:
            cache.release(path)
        self.assertEqual(cache.leases, {})

    def test_playback_lru_touch_reuses_same_active_copy(self):
        cache = self.cache()
        first = cache.acquire(self.source)
        stat = self.source.stat()
        for n in range(1, 5):
            os.utime(self.source, ns=(stat.st_atime_ns, stat.st_mtime_ns + n * 1000000))
            self.assertEqual(cache.acquire(self.source), first)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(cache.leases[first], 5)
        self.assertEqual(len(list(cache.root.glob("*.mp4"))), 1)

    def test_lru_touch_during_copy_is_not_content_mutation(self):
        cache = self.cache()
        def touch(source, target):
            shutil.copyfile(source, target)
            stat = source.stat()
            os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
        cache.remux = touch
        adjusted = cache.acquire(self.source)
        self.assertEqual(adjusted.read_bytes(), self.source.read_bytes())

    def test_same_size_and_restored_mtime_content_change_is_not_reused(self):
        cache = self.cache()
        first = cache.acquire(self.source)
        stat = self.source.stat()
        self.source.write_bytes(b"x" * stat.st_size)
        os.utime(self.source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        second = cache.acquire(self.source)
        self.assertNotEqual(first, second)
        self.assertEqual(second.read_bytes(), b"x" * stat.st_size)

    def test_same_size_mutation_during_copy_is_rejected(self):
        cache = self.cache()
        def mutate(source, target):
            stat = source.stat()
            shutil.copyfile(source, target)
            source.write_bytes(b"x" * stat.st_size)
            os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        cache.remux = mutate
        with self.assertRaisesRegex(RuntimeError, "发生变化"):
            cache.acquire(self.source)
        self.assertEqual(list(cache.root.iterdir()), [])

    def test_passthrough_for_valid_hevc_and_h264(self):
        for codec in ("h264", "hevc"):
            cache = self.cache()
            cache.inspect = lambda p: {"codec_name": codec, "level": 150}
            self.assertEqual(cache.acquire(self.source), self.source)
            self.assertFalse(cache.root.exists())
            self.assertEqual(self.calls, [])

    def test_capacity_does_not_remove_active_streams(self):
        cache = self.cache()
        paths = []
        for i in range(2):
            source = self.root / f"{i}.mp4"
            source.write_bytes(bytes([i]) * 64)
            paths.append(cache.acquire(source))
        with self.assertRaisesRegex(RuntimeError, "正在使用"):
            cache.acquire(self.source)
        self.assertTrue(all(p.exists() for p in paths))
        cache.release(paths[0])
        next_path = cache.acquire(self.source)
        self.assertTrue(next_path.exists())
        self.assertFalse(paths[0].exists())
        self.assertTrue(paths[1].exists())
        self.assertEqual(len(list(cache.root.glob("*.mp4"))), 2)

    def test_invalid_output_and_timeout_leave_no_partial(self):
        cache = self.cache()
        cache.inspect = lambda p: {**self.inspect(p), "level": 186}
        with self.assertRaisesRegex(RuntimeError, "无法自动兼容"):
            cache.acquire(self.source)
        self.assertEqual(list(cache.root.iterdir()), [])
        def timeout(source, target):
            target.write_bytes(b"partial")
            raise subprocess.TimeoutExpired("ffmpeg", 45)
        cache.remux = timeout
        with self.assertRaises(subprocess.TimeoutExpired):
            cache.acquire(self.source)
        self.assertEqual(list(cache.root.iterdir()), [])
        self.assertEqual(self.source.read_bytes(), b"original-video-audio")

    def test_replaced_source_uses_new_cache_identity(self):
        cache = self.cache()
        first = cache.acquire(self.source)
        cache.release(first)
        self.source.write_bytes(b"different-content")
        second = cache.acquire(self.source)
        self.assertNotEqual(first, second)
        self.assertEqual(len(self.calls), 2)

    def test_source_mutation_during_copy_is_rejected(self):
        cache = self.cache()
        def mutate(source, target):
            shutil.copyfile(source, target)
            source.write_bytes(b"new-media")
        cache.remux = mutate
        with self.assertRaisesRegex(RuntimeError, "发生变化"):
            cache.acquire(self.source)
        self.assertEqual(list(cache.root.iterdir()), [])

    def test_asgi_disconnect_releases_both_leases(self):
        tree = ast.parse(Path(__file__).with_name("nas_server.py").read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "LeasedFileResponse")
        released = []
        class Parent:
            def __init__(self, path, **kwargs):
                pass
            async def __call__(self, *args):
                raise RuntimeError("disconnected")
        class Leases:
            def __init__(self, kind):
                self.kind = kind
            def release(self, value):
                released.append((self.kind, value))
        namespace = {"FileResponse": Parent, "playback": Leases("normal"), "tv_compat": Leases("compat")}
        exec(compile(ast.Module(body=[cls], type_ignores=[]), "actual-response", "exec"), namespace)
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            asyncio.run(namespace["LeasedFileResponse"]("file", "42", "compat-file")({}, None, None))
        self.assertEqual(released, [("normal", "42"), ("compat", "compat-file")])

    def test_actual_stream_auth_range_and_profile_validation(self):
        try:
            from fastapi import HTTPException, Query
            from fastapi.responses import FileResponse
            from test_site_auth import AuthTests
        except ImportError:
            self.skipTest("NAS FastAPI environment is required")
        fixture = AuthTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        fixture.app.router.routes[:] = [r for r in fixture.app.router.routes if r.path != "/stream"]
        self.source.write_bytes(b"original-video-audio")
        cache = self.cache()
        leases = []
        class Playback:
            def acquire(inner, vid):
                leases.append(vid)
            def ensure(inner, vid):
                return self.source
            def release(inner, vid):
                leases.remove(vid)
        tree = ast.parse(Path(__file__).with_name("nas_server.py").read_text())
        nodes = [n for n in tree.body if getattr(n, "name", "") in ("LeasedFileResponse", "stream")]
        namespace = {"app": fixture.app, "FileResponse": FileResponse, "Query": Query,
                     "HTTPException": HTTPException, "playback": Playback(), "tv_compat": cache,
                     "server": SimpleNamespace(H=None),
                     "timings": __import__('timings').Timings()}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "actual-stream", "exec"), namespace)
        self.assertEqual(fixture.request("/stream?vid=42&tv_profile=tcl-hevc")[0], 401)
        self.assertEqual(self.calls, [])
        token, _ = fixture.login()
        self.assertEqual(fixture.request("/stream?vid=42&tv_profile=unknown", cookie=token)[0], 422)
        for query, calls in (("", 0), ("&tv_profile=tcl-hevc", 1), ("&tv_profile=hevc-meta", 1), ("&tv_profile=tcl-hevc", 1)):
            status, headers, body = fixture.request("/stream?vid=42" + query, cookie=token,
                                                   headers={"range": "bytes=0-7"})
            self.assertEqual((status, body), (206, b"original"))
            self.assertIn("private", headers["cache-control"])
            self.assertEqual(len(self.calls), calls)
            self.assertEqual(leases, [])
            self.assertEqual(cache.leases, {})

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_real_hevc_copy_keeps_picture_and_audio_packets(self):
        source = self.root / "sample.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=10",
                        "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=48000", "-t", "1",
                        "-c:v", "libx265", "-x265-params", "level-idc=6.2:pools=1:frame-threads=1:log-level=error",
                        "-c:a", "aac", "-tag:v", "hvc1", str(source)], capture_output=True, check=True)
        before = source.read_bytes()
        self.assertEqual(probe(source)["level"], 186)
        cache = TvCompatibilityCache(self.root / "real")
        adjusted = cache.acquire(source)
        self.assertLessEqual(probe(adjusted)["level"], 153)
        self.assertEqual(source.read_bytes(), before)
        def picture(path):
            return subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f", "framemd5", "-"])
        def audio(path):
            return subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-c", "copy", "-f", "data", "-"])
        self.assertEqual(picture(source), picture(adjusted))
        self.assertEqual(audio(source), audio(adjusted))


if __name__ == "__main__":
    unittest.main()
