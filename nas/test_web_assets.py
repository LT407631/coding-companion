"""Exercise the maintained static handler without starting NAS/Frida services."""
import ast
from pathlib import Path
import unittest


class NotFound(Exception):
    pass


class WebAssetsTest(unittest.TestCase):
    def test_exact_static_routes(self):
        source = Path(__file__).with_name('nas_server.py')
        tree = ast.parse(source.read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'browser_asset')
        handler.decorator_list = []
        context = {'__file__': str(source), 'Path': Path, 'HTTPException': NotFound,
                   'FileResponse': lambda path, headers: (path, headers)}
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(source), 'exec'), context)
        for name in ['seasons.js', 'watch-state.js', 'watch-ui.js', 'watch-ui.css', 'settings.js', 'page-requests.js', 'random-play.js', 'library.js', 'library-store.js', 'library-scroll.js', 'device-media.js', 'search.js', 'playback-status.js', 'legacy-polyfills.js', 'legacy-app.js', 'legacy-worker.js', 'legacy.css']:
            path, headers = context['browser_asset'](name)
            self.assertTrue(path.is_file())
            self.assertIn('private', headers['Cache-Control'])
            self.assertIn('must-revalidate', headers['Cache-Control'])
        for name in ['../nas_server.py', '.env', 'other.js', 'app.html']:
            with self.assertRaises(NotFound):
                context['browser_asset'](name)

    def test_settings_use_one_playback_and_cache_card(self):
        settings = Path(__file__).with_name('web').joinpath('assets', 'settings.js').read_text()
        self.assertEqual(settings.count('<div class="setbox"><h3>播放方式与两类缓存</h3>'), 1)
        self.assertNotIn('<h3>播放模式与设备缓存</h3>', settings)
        self.assertNotIn('<h3>连续播放与缓存</h3>', settings)
        for heading in ('播放线路', '当前设备缓存（仅此浏览器）', 'NAS 视频缓存（家庭共享）'):
            self.assertIn(f'<h4 class="settings-subtitle">{heading}</h4>', settings)
        self.assertIn('保存播放与缓存设置', settings)

    def test_login_has_old_webview_form_and_color_fallbacks(self):
        login = Path(__file__).with_name('web').joinpath('login.html').read_text()
        self.assertIn('<form id="login-form" method="post" action="/auth/login-form">', login)
        self.assertIn('name="password"', login)
        self.assertIn("if (!setupToken) return;", login)
        self.assertIn('background:#f5f6f8;background:var(--bg)', login)
        self.assertIn('color:#1f2129;color:var(--text)', login)

    def test_playback_quality_selector_defaults_high_and_reports_actual_dimensions(self):
        web = Path(__file__).with_name('web')
        page = web.joinpath('app.html').read_text()
        controls = web.joinpath('assets', 'playback-status.js').read_text()
        server = Path(__file__).with_name('nas_server.py').read_text()
        self.assertIn("['auto', '1080p', '720p', '540p', '480p', '360p']", page)
        self.assertIn('自动（默认最高）', page)
        self.assertIn("quality: 'auto'", page)
        self.assertNotIn('coding_playback_quality_v1', page)
        self.assertIn('actualPlaybackQuality', page)
        self.assertIn('video.videoWidth', page)
        self.assertIn('video.videoHeight', page)
        self.assertIn('&quality=${encodeURIComponent(W.quality)}', page)
        self.assertIn("value === 'auto' ? '自动（默认最高）'", controls)
        self.assertIn('w.actualQualityLabel', controls)
        self.assertLess(page.index('W.setQuality ='), page.index('CodingWebTransition.create(W'))
        self.assertIn('quality: str = Query("auto"', server)
        self.assertIn('vid + "q" + quality.removesuffix("p")', server)

    def test_random_preview_has_sidebar_entry_pool_and_no_history(self):
        web = Path(__file__).with_name('web')
        page = web.joinpath('app.html').read_text()
        library = web.joinpath('assets', 'library.js').read_text()
        random_play = web.joinpath('assets', 'random-play.js').read_text()
        self.assertNotIn('随机看一部', library)
        self.assertIn('随便看看', page)
        self.assertLess(page.index('data-nav="random"'), page.index('data-nav="rank"'))
        self.assertIn('CodingRandomPlay.startCurrent(this)', page)
        self.assertIn('var POOL_SIZE = 10', random_play)
        self.assertIn('count: Math.max(1, Math.min(POOL_SIZE', random_play)
        self.assertIn('background: true', random_play)
        self.assertIn('poolActive < 2', random_play)
        self.assertIn("state.trail.slice(state.index + 1, state.index + POOL_SIZE)", random_play)
        self.assertIn('foregroundReady: foregroundReady', random_play)
        self.assertIn('CodingRandomPlay.foregroundReady(W.sid)', page)
        self.assertLess(page.index("post('/playback/prepare', body)"), page.index('CodingRandomPlay.foregroundReady(W.sid)'))
        self.assertIn('await ensureReady(selected)', random_play)
        self.assertIn('background: false', random_play)
        self.assertLess(random_play.index('await ensureReady(selected)'), random_play.index('show(selected, true)'))
        self.assertIn("json('/episodes?series_id='", random_play)
        self.assertIn('prepared.set(sid, result.data)', random_play)
        self.assertIn('CodingRandomPlay.takePrepared(sid)', page)
        self.assertIn('CodingRandomPlay.frame()', page)
        self.assertIn('randomFrame ? `<div class="watch"><div class="stage">${randomFrame}</div></div>` : loadingHTML', page)
        self.assertIn('CodingRandomPlay.clearFrame()', page)
        self.assertIn('.random-transition-frame', web.joinpath('assets', 'library.css').read_text())
        self.assertIn("navigator.sendBeacon('/playback/close'", random_play)
        self.assertIn("preview: !!W.random", page)
        self.assertIn("if (W.random) { CodingRandomPlay.ended(W); return; }", page)
        self.assertIn("if (W.random || !v", page)
        self.assertIn("rest[2] === 'random'", page)
        self.assertIn("document.addEventListener('keydown', key, true)", random_play)
        self.assertIn("event.key === 'ArrowUp' ? -1 : 1", random_play)
        self.assertIn("event.key === 'Enter') accept", random_play)
        self.assertIn("stage.addEventListener('wheel'", random_play)
        self.assertIn("{passive: false}", random_play)
        self.assertIn("shift(vertical < 0 ? -1 : 1)", random_play)
        self.assertIn("Date.now() - wheelAt < 700", random_play)
        self.assertIn("stage.addEventListener('touchend'", random_play)
        self.assertEqual(random_play.count('CodingWatchState.hist.put('), 1)
        self.assertIn("if (!w || !w.random || !w.sid) return", random_play)
        self.assertIn('↑ 上一部', random_play)
        self.assertIn('喜欢，继续看', random_play)
        self.assertIn('↓ 换一部', random_play)
        self.assertNotIn('随机试看 · 不记历史', random_play)
        self.assertNotIn('电视按↑↓换剧', random_play)
        self.assertNotIn('random-drawer-note', page)
        css = web.joinpath('assets', 'library.css').read_text()
        self.assertIn('.coding-tv .random-preview,.legacy-webview .random-preview { display:none !important; }', css)


if __name__ == '__main__':
    unittest.main()
