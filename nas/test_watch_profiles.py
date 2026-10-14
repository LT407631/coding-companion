import json
import hashlib
import sqlite3
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor

from test_site_auth import AuthTests
from test_watch_state import op
from watch_state import WatchState, install_watch_state
from watch_updates import install_watch_updates
from watch_profiles import WatchProfiles, install_watch_profiles


class ProfilesTests(AuthTests):
    def setUp(self):
        super().setUp()
        self.state = WatchState(self.root / 'watch.db')
        self.legacy = self.state.apply([op()])[0]
        self.legacy_digest = hashlib.sha256(self.state.path.read_bytes()).hexdigest()
        self.profiles = WatchProfiles(self.root / 'profiles.db', self.state, lambda sid: 81)
        install_watch_profiles(self.app, self.profiles)
        install_watch_state(self.app, self.state, resolve=self.profiles.state)
        install_watch_updates(self.app, None, resolve=self.profiles.updates)

    def tearDown(self):
        self.profiles.close()
        super().tearDown()

    def create(self, cookie, name='小明'):
        status, _, body = self.request('/watch-profiles', 'POST', {'name': name}, cookie)
        self.assertEqual(status, 201)
        return json.loads(body)

    def snapshot(self, cookie, identity=None):
        status, _, body = self.request('/watch-state', cookie=cookie, headers={'x-watch-profile': identity} if identity else {})
        self.assertEqual(status, 200)
        return json.loads(body)

    def test_legacy_default_is_retained_and_new_member_is_empty(self):
        cookie, _ = self.login()
        self.assertEqual(hashlib.sha256(self.state.path.read_bytes()).hexdigest(), self.legacy_digest)
        member = self.create(cookie)
        default = self.snapshot(cookie)
        self.assertEqual(default['rows'][0]['value']['ep'], 43)
        child = self.snapshot(cookie, member['id'])
        self.assertEqual(child['rows'], [])
        self.assertNotEqual(child['server'], default['server'])
        self.assertEqual(hashlib.sha256(self.state.path.read_bytes()).hexdigest(), self.legacy_digest)

    def test_independent_records_same_profile_cross_device_and_wrong_server_rejected(self):
        a, _ = self.login(); b, _ = self.login()
        member = self.create(a)
        identity = member['id']; headers = {'x-watch-profile': identity}
        child = self.snapshot(a, identity)
        operations = [op(value={**op()['value'], 'ep': 2}), op(kind='favorite'), op(kind='hidden', value={'reason': 'dislike'})]
        status, _, _ = self.request('/watch-state', 'POST', {'server': child['server'], 'operations': operations}, a, headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(len(self.snapshot(b, identity)['rows']), 3)
        default = self.snapshot(a)
        self.assertEqual(default['rows'][0]['value']['ep'], 43)
        # A late write cannot move A's snapshot into B even if it uses B's header.
        status, _, _ = self.request('/watch-state', 'POST', {'server': default['server'], 'operations': [op()]}, a, headers=headers)
        self.assertEqual(status, 409)
        # Deliberate rewind/delete in one member leaves the other untouched.
        rows = self.snapshot(b, identity)['rows']
        hist = next(row for row in rows if row['kind'] == 'history')
        delete = {**op(base=hist['rev']), 'value': None}
        self.assertEqual(self.request('/watch-state', 'POST', {'server': child['server'], 'operations': [delete]}, b, headers=headers)[0], 200)
        self.assertEqual(self.snapshot(a)['rows'][0]['value']['ep'], 43)

    def test_follow_counts_are_scoped_and_persist_after_restart(self):
        cookie, _ = self.login(); member = self.create(cookie)
        child_request = SimpleNamespace(headers={'x-watch-profile': member['id']})
        default_request = SimpleNamespace(headers={})
        child = self.profiles.state(child_request)
        child.apply([op(kind='favorite')]); checks = self.profiles.updates(child_request)
        checks._run()
        self.assertIn('1', checks.snapshot()['items'])
        self.assertEqual(self.profiles.updates(default_request).snapshot()['items'], {})
        other = WatchProfiles(self.profiles.path, WatchState(self.state.path), lambda sid: 81)
        try:
            self.assertEqual(other.listing(), self.profiles.listing())
            self.assertEqual(other.state(child_request).snapshot(), child.snapshot())
        finally:
            other.close()

    def test_auth_origin_body_and_unknown_identity_are_not_bypassed(self):
        for path in ['/watch-profiles', '/watch-state', '/watch-updates']:
            self.assertEqual(self.request(path, headers={'x-watch-profile': 'default'})[0], 401)
        self.assertEqual(self.request('/watch-profiles', 'POST', {'name': '小明'})[0], 401)
        cookie, _ = self.login()
        self.assertEqual(self.request('/watch-profiles', 'POST', {'name': '小明'}, cookie, origin='https://evil.test')[0], 403)
        self.assertEqual(self.request('/watch-profiles', 'POST', {}, cookie, raw=b' ' * 5000)[0], 413)
        self.assertEqual(self.request('/watch-profiles', 'POST', {'name': '小明'}, cookie, headers={'content-type': 'text/plain'})[0], 415)
        for identity in ['../watch.db', 'missing', '00000000-0000-0000-0000-000000000000', '']:
            for endpoint in ['/watch-state', '/watch-updates']:
                self.assertEqual(self.request(endpoint, cookie=cookie, headers={'x-watch-profile': identity})[0], 404)

    def test_duplicate_names_and_creation_limit_are_atomic(self):
        cookie, _ = self.login()
        self.create(cookie, ' Alice ')
        self.assertEqual(self.request('/watch-profiles', 'POST', {'name': 'alice'}, cookie)[0], 409)
        for name in ['', '  ', 'x' * 21, '\n', 42]:
            self.assertEqual(self.request('/watch-profiles', 'POST', {'name': name}, cookie)[0], 400)
        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda i: self._create_direct('成员' + str(i)), range(8)))
        self.assertEqual(sum(results), 6)
        self.assertEqual(len(self.profiles.listing()), 8)
        with sqlite3.connect(self.profiles.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(DISTINCT name_key) FROM profiles').fetchone()[0], 8)

    def _create_direct(self, name):
        from fastapi import HTTPException
        try:
            self.profiles.create(name); return True
        except HTTPException as error:
            self.assertEqual(error.status_code, 400); return False
