import json
import unittest
from test_site_auth import AuthTests


class MediaTicketTests(unittest.TestCase):
    setUp = AuthTests.setUp
    tearDown = AuthTests.tearDown
    request = AuthTests.request
    login = AuthTests.login

    def issue(self, sid='123', ep=2):
        token, _ = self.login()
        status, headers, body = self.request('/auth/media-ticket', 'POST',
                                              {'series_id': sid, 'ep': ep}, cookie=token)
        self.assertEqual(status, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        data = json.loads(body)
        self.assertNotIn(token, body.decode())
        self.assertEqual(data['expires_at'], self.now + 900)
        return token, data['token']

    def test_cookie_free_native_range_and_head_for_exact_episode(self):
        _, ticket = self.issue()
        headers = {'x-coding-media': ticket, 'range': 'bytes=0-3'}
        status, _, body = self.request('/stream?series_id=123&ep=2&tv_profile=hevc-meta', headers=headers)
        self.assertEqual((status, body), (206, b'test'))
        self.assertEqual(self.request('/stream?series_id=123&ep=2', 'HEAD', headers=headers)[0], 206)
        self.assertEqual(self.request('/stream?series_id=123&ep=2')[0], 401)

    def test_ticket_is_not_a_site_session(self):
        _, ticket = self.issue()
        headers = {'x-coding-media': ticket}
        for path in ['/watch-state', '/auth/session', '/auth/media-ticket', '/search', '/img', '/admin',
                     '/stream?series_id=123&ep=3', '/stream?series_id=999&ep=2', '/stream?vid=42',
                     '/stream?series_id=123&ep=2&vid=42', '/stream?series_id=123&series_id=999&ep=2',
                     '/stream?series_id=123&ep=2&ep=3']:
            self.assertEqual(self.request(path, headers=headers)[0], 401, path)
        self.assertEqual(self.request('/auth/logout', 'POST', headers=headers)[0], 401)
        self.assertEqual(self.request('/stream?series_id=123&ep=2', 'POST', headers=headers)[0], 401)
        self.assertEqual(self.request('/stream?series_id=123&ep=2', cookie=ticket)[0], 401)

    def test_expiry_logout_password_change_and_tampering(self):
        token, ticket = self.issue()
        headers = {'x-coding-media': ticket}
        self.assertEqual(self.request('/auth/logout', 'POST', cookie=token)[0], 200)
        self.assertEqual(self.request('/stream?series_id=123&ep=2', headers=headers)[0], 401)
        token, ticket = self.issue()
        self.assertTrue(self.auth.change('fixture-password', 'new-fixture-password'))
        self.assertFalse(self.auth.valid_media_ticket(ticket, '123', '2'))
        token, _ = self.login('new-fixture-password')
        ticket = self.auth.media_ticket(token, '123', 2)['token']
        self.assertTrue(self.auth.valid_media_ticket(ticket, '123', '2'))
        for bad in [ticket[:-2] + 'ZZ', 'x.y', 'A' * 1025, ticket + '=']:
            self.assertFalse(self.auth.valid_media_ticket(bad, '123', '2'))
        self.now += 900
        self.assertFalse(self.auth.valid_media_ticket(ticket, '123', '2'))

    def test_mint_requires_authenticated_same_origin_and_valid_episode(self):
        self.assertEqual(self.request('/auth/media-ticket', 'POST', {'series_id':'123','ep':2})[0], 401)
        token, _ = self.login()
        self.assertEqual(self.request('/auth/media-ticket', 'POST', {'series_id':'123','ep':2}, cookie=token, origin='https://foreign.test')[0], 403)
        for data in [{'series_id':'../secret','ep':2}, {'series_id':'123','ep':0}, {'series_id':'123','ep':True}, {'series_id':'123','ep':'2'}]:
            self.assertEqual(self.request('/auth/media-ticket', 'POST', data, cookie=token)[0], 422)
