import json
import unittest
from urllib.parse import parse_qs, urlparse
from fastapi import HTTPException
from phone_input import Pairings, install_phone_input
from test_site_auth import AuthTests


class PairTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.pairs = Pairings(clock=lambda: self.now)
        self.pair = self.pairs.create('tv-a', 'http://site.test')['pair']
        self.key = parse_qs(urlparse(self.pairs.url(self.pair, 'tv-a')).fragment)['key'][0]

    def test_only_owner_can_read_qr_poll_or_cancel(self):
        for operation in (self.pairs.url, self.pairs.poll, self.pairs.close):
            with self.assertRaises(HTTPException) as exc:
                operation(self.pair, 'tv-b')
            self.assertEqual(exc.exception.status_code, 404)

    def test_search_delivery_sequence_and_other_tv_isolation(self):
        other = self.pairs.create('tv-b', 'http://site.test')['pair']
        self.pairs.submit(self.pair, self.key, '  万妖图录传  ')
        self.assertEqual(self.pairs.poll(self.pair, 'tv-a')['query'], '万妖图录传')
        self.assertEqual(self.pairs.poll(self.pair, 'tv-a')['version'], 1)
        self.assertEqual(self.pairs.poll(other, 'tv-b')['query'], '')
        self.now += 2
        self.pairs.submit(self.pair, self.key, '<script>alert(1)</script>')
        self.assertEqual(self.pairs.poll(self.pair, 'tv-a')['version'], 2)

    def test_expired_cancelled_and_replaced_pair_rejected(self):
        self.pairs.create('tv-a', 'http://site.test')
        with self.assertRaises(HTTPException): self.pairs.submit(self.pair, self.key, '旧二维码')
        new = self.pairs.create('tv-b', 'http://site.test')['pair']
        self.pairs.close(new, 'tv-b')
        with self.assertRaises(HTTPException): self.pairs.poll(new, 'tv-b')
        self.now += 901
        self.assertEqual(len(self.pairs.pairs) > 0, True)
        self.pairs.prune()
        self.assertEqual(self.pairs.pairs, {})

    def test_public_address_routes_to_same_pair_without_changing_tv_origin(self):
        pair = self.pairs.create('tv-remote', 'http://nas.test:8010', 'https://fixture-public.example:8888')['pair']
        url = self.pairs.url(pair, 'tv-remote')
        self.assertTrue(url.startswith('https://fixture-public.example:8888/phone-input#'))
        key = parse_qs(urlparse(url).fragment)['key'][0]
        self.pairs.submit(pair, key, '跨网络搜索')
        self.assertEqual(self.pairs.poll(pair, 'tv-remote')['query'], '跨网络搜索')
        for address in ('javascript:alert(1)', 'https://user:password@evil.test', 'https://example.test/path', 'https://example.test:99999', 'https://example.test/?secret=1'):
            with self.assertRaises(HTTPException): self.pairs.create('tv-remote', 'http://local', address)

    def test_bad_key_blank_controls_and_rate_limit(self):
        with self.assertRaises(HTTPException): self.pairs.submit(self.pair, 'wrong', 'test')
        for text in (' ', 'a\x00b', 'x'*81):
            with self.assertRaises(HTTPException): self.pairs.submit(self.pair, self.key, text)
        self.pairs.submit(self.pair, self.key, 'a')
        with self.assertRaises(HTTPException) as exc: self.pairs.submit(self.pair, self.key, 'b')
        self.assertEqual(exc.exception.status_code, 429)


class PhoneApiTests(unittest.TestCase):
    setUp = AuthTests.setUp
    tearDown = AuthTests.tearDown
    request = AuthTests.request
    login = AuthTests.login

    def install(self):
        self.pairs = install_phone_input(self.app, __import__('pathlib').Path(__file__).parent / 'web')
        self.tv, _ = self.login()
        self.mobile, _ = self.login()
        code, _, data = self.request('/phone-input/pairs', 'POST', cookie=self.tv)
        self.assertEqual(code, 200)
        self.pair = json.loads(data)['pair']
        self.key = parse_qs(urlparse(self.pairs.url(self.pair, self.tv)).fragment)['key'][0]

    def test_phone_page_login_redirect_and_no_anonymous_api_access(self):
        self.install()
        code, headers, _ = self.request('/phone-input')
        self.assertEqual(code, 303)
        self.assertEqual(headers['location'], '/login?next=%2Fphone-input')
        for path in ('/phone-input/client.js', '/phone-input/pairs/'+self.pair, '/phone-input/pairs/'+self.pair+'/qr'):
            self.assertEqual(self.request(path)[0], 401)
        self.assertEqual(self.request('/phone-input/search', 'POST', {'pair':self.pair,'key':self.key,'query':'x'})[0], 401)
        self.assertEqual(self.request('/phone-input', cookie=self.mobile)[0], 200)

    def test_real_qr_authenticated_search_poll_and_cancel(self):
        self.install()
        code, headers, image = self.request('/phone-input/pairs/'+self.pair+'/qr', cookie=self.tv)
        self.assertEqual(code, 200)
        self.assertTrue(image.startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(self.request('/phone-input/pairs/'+self.pair+'/qr', cookie=self.mobile)[0], 404)
        body = {'pair':self.pair,'key':self.key,'query':'万妖图录传'}
        self.assertEqual(self.request('/phone-input/search', 'POST', body, cookie=self.mobile)[0], 200)
        code, headers, data = self.request('/phone-input/pairs/'+self.pair, cookie=self.tv)
        self.assertEqual(json.loads(data)['query'], '万妖图录传')
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(self.request('/phone-input/pairs/'+self.pair, 'DELETE', cookie=self.tv, headers={'origin':'http://site.test'})[0], 200)
        self.assertEqual(self.request('/phone-input/search', 'POST', body, cookie=self.mobile)[0], 404)

    def test_cross_site_mutations_wrong_owner_and_validation_blocked(self):
        self.install()
        body = {'pair':self.pair,'key':self.key,'query':'x'}
        self.assertEqual(self.request('/phone-input/pairs', 'POST', cookie=self.tv, origin='http://evil.test')[0], 403)
        self.assertEqual(self.request('/phone-input/search', 'POST', body, cookie=self.mobile, origin='http://evil.test')[0], 403)
        self.assertEqual(self.request('/phone-input/pairs/'+self.pair, cookie=self.mobile)[0], 404)
        body['query'] = 'x'*81
        self.assertEqual(self.request('/phone-input/search', 'POST', body, cookie=self.mobile)[0], 422)
        self.auth.logout(self.tv)
        self.assertEqual(self.request('/phone-input/pairs/'+self.pair, cookie=self.tv)[0], 401)


if __name__ == '__main__': unittest.main()
