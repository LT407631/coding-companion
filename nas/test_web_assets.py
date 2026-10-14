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
        for name in ['seasons.js', 'watch-state.js', 'watch-ui.js', 'watch-ui.css', 'settings.js', 'page-requests.js', 'library.js', 'library-store.js', 'library-scroll.js', 'device-media.js', 'search.js', 'playback-status.js']:
            path, headers = context['browser_asset'](name)
            self.assertTrue(path.is_file())
            self.assertIn('private', headers['Cache-Control'])
            self.assertIn('must-revalidate', headers['Cache-Control'])
        for name in ['../nas_server.py', '.env', 'other.js', 'app.html']:
            with self.assertRaises(NotFound):
                context['browser_asset'](name)


if __name__ == '__main__':
    unittest.main()
