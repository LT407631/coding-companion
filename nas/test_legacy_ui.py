"""Regression contract for Android 5 / WebView 37 UI startup."""
import ast
import hashlib
import re
from pathlib import Path
import unittest


ROOT = Path(__file__).parent
WEB = ROOT / "web"


class LegacyUiTest(unittest.TestCase):
    def test_tv_shell_always_requests_the_compatibility_page(self):
        main = ROOT.parent.joinpath(
            "android-tv", "src", "net", "codingcompanion", "tv", "MainActivity.java"
        ).read_text()
        self.assertIn('site+"/ui?compat=1"', main)
        self.assertNotIn("also check the NAS address", main)

    def test_generated_legacy_page_is_current_and_es5_shaped(self):
        page = (WEB / "app-legacy.html").read_text()
        sources = [WEB / "app.html"]
        sources += [WEB / "assets" / name for name in (
            "profiles.js", "watch-state.js", "watch-ui.js", "library-store.js",
            "library-scroll.js", "library-grid.js", "random-play.js", "library.js", "device-media.js",
            "seasons.js", "settings.js", "page-requests.js", "search.js",
            "playback-status.js", "device-crypto.js", "device-worker.js",
            "library.css", "watch-ui.css",
        )]
        digest = hashlib.sha256()
        for source in sorted(sources, key=lambda path: str(path.relative_to(ROOT.parent))):
            name = str(source.relative_to(ROOT.parent))
            digest.update(name.encode() + b"\0" + hashlib.sha256(source.read_bytes()).hexdigest().encode() + b"\n")
        marker = re.search(r'<meta name="legacy-source-sha256" content="([0-9a-f]{64})">', page)
        self.assertIsNotNone(marker)
        self.assertEqual(marker.group(1), digest.hexdigest())
        self.assertIn('/ui/assets/legacy-polyfills.js', page)
        self.assertIn('/ui/assets/legacy-app.js', page)
        self.assertNotIn('/ui/assets/profiles.js', page)
        script = (WEB / "assets" / "legacy-app.js").read_text()
        for unsupported in ("=>", "?.", "??", "async function", "const ", "let "):
            self.assertNotIn(unsupported, script)
        self.assertIn("window.CodingLibrary", script)
        self.assertRegex(script, r"var W\s*=")

    def test_compatibility_assets_are_bounded(self):
        for name in ("app-legacy.html",):
            self.assertLess((WEB / name).stat().st_size, 900_000)
        for name in ("legacy-polyfills.js", "legacy-app.js", "legacy-worker.js", "legacy.css"):
            path = WEB / "assets" / name
            self.assertTrue(path.is_file(), name)
            self.assertLess(path.stat().st_size, 900_000, name)

    def test_server_selects_legacy_page_only_when_requested(self):
        source = ROOT / "nas_server.py"
        tree = ast.parse(source.read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "browser_ui")
        handler.decorator_list = []
        context = {
            "__file__": str(source),
            "Path": Path,
            "FileResponse": lambda path, headers: (path, headers),
        }
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(source), "exec"), context)
        modern, _ = context["browser_ui"](False)
        legacy, _ = context["browser_ui"](True)
        self.assertEqual(modern.name, "app.html")
        self.assertEqual(legacy.name, "app-legacy.html")


if __name__ == "__main__":
    unittest.main()
