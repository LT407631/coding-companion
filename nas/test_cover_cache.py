import ast
import io
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from urllib.parse import urlparse
from unittest.mock import Mock
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from cover_cache import encode_cover
from catalog_cache import CatalogCache, Payload, response_headers, not_modified
from timings import Timings


class HttpError(Exception):
    def __init__(self, status, message):
        self.status_code = status


class Covers(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[3] / '临时/海报与滚动优化'
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.cache = CatalogCache(self.temp.name)
        data = io.BytesIO()
        Image.new('RGB', (1400, 2000), 'red').save(data, format='JPEG')
        self.original = data.getvalue()
        response = types.SimpleNamespace(status_code=200, content=self.original, headers={'ETag':'source-v1'}, close=lambda:None, raise_for_status=lambda:None)
        self.http = types.SimpleNamespace(get=Mock(return_value=response))
        tree = ast.parse(Path(__file__).with_name('nas_server.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'cached_cover')
        node.decorator_list = []
        self.env = dict(Request=object, Query=lambda value, **kw:value, HTTPException=HttpError, urlparse=urlparse, time=time,
                        catalog=self.cache, Payload=Payload, encode_cover=encode_cover, requests=self.http,
                        timings=Timings(),
                        server=types.SimpleNamespace(_IMG_HOSTS=['example.test'], _IMG_OK=True),
                        response_headers=response_headers, not_modified=not_modified,
                        Response=lambda body=None, **kw:types.SimpleNamespace(body=body, **kw))
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'nas_server.py', 'exec'), self.env)
        self.request = types.SimpleNamespace(headers={})
        self.url = 'https://example.test/poster.jpg'

    def tearDown(self):
        self.cache.close()
        self.temp.cleanup()

    def call(self, width=320):
        return self.env['cached_cover'](self.request, self.url, width)

    def test_small_persistent_variant_and_conditional_browser_reuse(self):
        result = self.call()
        self.assertEqual(Image.open(io.BytesIO(result.body)).size, (320, 457))
        self.assertLess(len(result.body), len(self.original))
        self.assertEqual(self.call().body, result.body)
        self.cache.close()
        self.cache = self.env['catalog'] = CatalogCache(self.temp.name)
        self.assertEqual(self.call().body, result.body)
        self.request.headers['if-none-match'] = result.headers['ETag']
        self.assertEqual(self.call().status_code, 304)
        self.assertEqual(self.http.get.call_count, 1)

    def test_existing_original_is_reused_without_download(self):
        self.cache.put('/img:' + self.url, Payload(self.original, 'image/jpeg'))
        self.assertEqual(Image.open(io.BytesIO(self.call().body)).width, 320)
        self.assertEqual(Image.open(io.BytesIO(self.call(480).body)).width, 480)
        self.http.get.assert_not_called()

    def test_original_compatibility_and_invalid_size_or_host(self):
        self.assertEqual(Image.open(io.BytesIO(self.call(0).body)).width, 1400)
        with self.assertRaises(HttpError): self.call(321)
        self.url = 'https://untrusted.test/poster.jpg'
        with self.assertRaises(HttpError): self.call()
        self.assertEqual(self.http.get.call_count, 1)

    def test_no_upscale_and_orientation(self):
        out = io.BytesIO(); image = Image.new('RGB', (50, 100))
        exif = image.getexif(); exif[274] = 6
        image.save(out, format='JPEG', exif=exif)
        self.assertEqual(Image.open(io.BytesIO(encode_cover(out.getvalue(), 320))).size, (100, 50))


if __name__ == '__main__': unittest.main()
