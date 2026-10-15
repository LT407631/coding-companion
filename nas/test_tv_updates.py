import hashlib
import json
import unittest

from tv_updates import install_tv_updates
from test_site_auth import AuthTests


class TvUpdateTests(unittest.TestCase):
    setUp = AuthTests.setUp
    tearDown = AuthTests.tearDown
    request = AuthTests.request
    login = AuthTests.login

    def release(self):
        install_tv_updates(self.app, self.root / 'releases')
        self.directory = self.root / 'releases'
        self.directory.mkdir()
        self.apk = b'fixture-apk-bytes'
        self.digest = hashlib.sha256(self.apk).hexdigest()
        self.manifest = {'package': 'net.codingcompanion.tv', 'version_code': 6, 'version_name': '1.0.5',
                         'size': len(self.apk), 'sha256': self.digest, 'min_sdk': 21, 'notes': '测试更新'}
        self.path = '/updates/android-tv/' + self.digest + '.apk'
        (self.directory / (self.digest + '.apk')).write_bytes(self.apk)
        self.write_manifest()
        self.token, _ = self.login()

    def test_public_feed_is_separate_and_business_stays_private(self):
        self.release()
        status, _, body = self.request('/updates/android-tv-public/latest')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'available': False})
        public = self.directory.parent / 'tv-updates-public'
        public.mkdir()
        (public / 'latest.json').write_text(json.dumps(self.manifest))
        (public / (self.digest + '.apk')).write_bytes(self.apk)
        status, _, body = self.request('/updates/android-tv-public/latest')
        self.assertEqual(status, 200)
        path = json.loads(body)['url']
        self.assertEqual(path, '/updates/android-tv-public/' + self.digest + '.apk')
        self.assertEqual(self.request(path)[2], self.apk)
        status, _, body = self.request(path, headers={'range': 'bytes=0-3'})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.apk[:4])
        for denied in ['/watch-state', '/search', '/updates/android-tv/latest', self.path,
                       '/updates/android-tv-public/latest.json', '/updates/android-tv-public/../latest']:
            self.assertEqual(self.request(denied)[0], 401, denied)
        self.assertEqual(self.request(path, method='POST')[0], 401)

    def write_manifest(self):
        (self.directory / 'latest.json').write_text(json.dumps(self.manifest))

    def test_anonymous_manifest_and_apk_denied_then_revoked_session_denied(self):
        self.release()
        for path in ('/updates/android-tv/latest', self.path):
            self.assertEqual(self.request(path)[0], 401)
        self.auth.logout(self.token)
        self.assertEqual(self.request(self.path, cookie=self.token)[0], 401)

    def test_authenticated_metadata_and_exact_download_private_uncached(self):
        self.release()
        status, headers, body = self.request('/updates/android-tv/latest', cookie=self.token)
        self.assertEqual(status, 200)
        metadata = json.loads(body)
        self.assertEqual(metadata['url'], self.path)
        self.assertEqual(metadata['version_code'], 6)
        self.assertTrue(metadata['available'])
        status, headers, body = self.request(self.path, cookie=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body, self.apk)
        self.assertEqual(headers['cache-control'], 'private, no-store')
        self.assertEqual(headers['content-type'], 'application/vnd.android.package-archive')

    def test_no_release_and_missing_file_do_not_offer_install(self):
        self.release()
        (self.directory / 'latest.json').unlink()
        status, _, body = self.request('/updates/android-tv/latest', cookie=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'available': False})
        self.write_manifest()
        (self.directory / (self.digest + '.apk')).unlink()
        self.assertEqual(self.request('/updates/android-tv/latest', cookie=self.token)[0], 503)

    def test_corrupt_bytes_wrong_package_or_bad_metadata_rejected(self):
        self.release()
        for key, value in [('package', 'evil.package'), ('sha256', '../secret'), ('size', True),
                           ('version_code', -1), ('notes', ['invalid'])]:
            with self.subTest(key=key):
                original = self.manifest[key]
                self.manifest[key] = value
                self.write_manifest()
                self.assertEqual(self.request('/updates/android-tv/latest', cookie=self.token)[0], 503)
                self.manifest[key] = original
        self.write_manifest()
        (self.directory / (self.digest + '.apk')).write_bytes(b'x' * len(self.apk))
        self.assertEqual(self.request(self.path, cookie=self.token)[0], 503)

    def test_unlisted_files_and_symlinks_are_not_downloaded(self):
        self.release()
        for filename in ('latest.json', 'secret.apk', '0' * 64 + '.apk'):
            self.assertEqual(self.request('/updates/android-tv/' + filename, cookie=self.token)[0], 404)
        apk = self.directory / (self.digest + '.apk')
        apk.unlink()
        (self.root / 'outside.apk').write_bytes(self.apk)
        apk.symlink_to(self.root / 'outside.apk')
        self.assertEqual(self.request(self.path, cookie=self.token)[0], 503)


if __name__ == '__main__':
    unittest.main()
