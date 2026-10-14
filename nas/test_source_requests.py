from concurrent.futures import ThreadPoolExecutor
import threading
import time
from types import SimpleNamespace
import unittest
import requests

from source_requests import SourceRequests, SourceTimeout


class Reply:
    def __init__(self, data=None):
        self.data = data or {'X-Argus': 'signature'}
        self.closed = False
    def raise_for_status(self):
        pass
    def json(self):
        return self.data
    def close(self):
        self.closed = True


class Provider:
    CFG = {'api_host': 'source.test', 'base_query': {'aid': 1, 'device_id': 'private'},
           'session_headers': {'cookie': 'private'}}
    SIGN_SERVERS = ['http://sign:9099']
    def __init__(self):
        self.posts = []
        self.http_calls = []
        self.legacy_calls = 0
        self.old_sign = 0
        self.waits = 0
        self.SG = SimpleNamespace(throttle=SimpleNamespace(wait=self.wait))
    def wait(self):
        self.waits += 1
    def _next_sign_server(self):
        return self.SIGN_SERVERS[0]
    def _sign_session(self):
        return self
    def post(self, url, **options):
        self.posts.append(options)
        return Reply()
    def sign(self, url, headers):
        self.old_sign += 1
        return {'X-Argus': 'old'}
    def http_request(self, method, url, **options):
        self.http_calls.append(options)
        return Reply({'data': 'result'})
    def _api_once(self, method, path, body, extra_query, signed=True):
        headers = dict(self.CFG['session_headers'])
        if signed:
            headers.update(self.sign(path, headers))
        self.SG.throttle.wait()
        return self.http_request(method, path, timeout=30, headers=headers).json()
    def api(self, method, path, **options):
        self.legacy_calls += 1
        return self._api_once(method, path, options.get('body'), options.get('extra_query'),
                              signed=options.get('signed', True))


class SourceRequestsTests(unittest.TestCase):
    def setUp(self):
        self.h = Provider()
        self.source = SourceRequests(self.h)

    def test_bounded_calls_reuse_construction_but_not_legacy_retries(self):
        self.assertEqual(self.source.api('GET', '/search'), {'data': 'result'})
        self.assertEqual(self.h.legacy_calls, 0)
        self.assertEqual(len(self.h.posts), 1)
        timeout = self.h.http_calls[0]['timeout']
        self.assertLessEqual(timeout[0], 3)
        self.assertLessEqual(timeout[1], 12)
        self.assertEqual(self.h.http_calls[0]['headers']['cookie'], 'private')

    def test_legacy_and_season_requests_retain_original_timeouts(self):
        self.source.api('GET', '/search')
        self.h.api('GET', '/season')
        self.assertEqual(self.h.legacy_calls, 1)
        self.assertEqual(self.h.old_sign, 1)
        self.assertEqual(self.h.http_calls[-1]['timeout'], 30)

    def test_scope_never_changes_other_threads(self):
        entered, release = threading.Event(), threading.Event()
        def scoped():
            def operation():
                entered.set()
                self.assertTrue(release.wait(2))
                return self.h.api('GET', '/tracks')
            return self.source.run(operation, budget=2)
        with ThreadPoolExecutor(2) as pool:
            future = pool.submit(scoped)
            self.assertTrue(entered.wait(1))
            self.h.api('GET', '/season')
            release.set()
            future.result(3)
        self.assertEqual(self.h.http_calls[0]['timeout'], 30)
        self.assertIsInstance(self.h.http_calls[1]['timeout'], tuple)

    def test_expired_scope_does_not_send_and_is_restored(self):
        with self.assertRaises(SourceTimeout):
            self.source.run(lambda: time.sleep(.12), budget=.1)
        self.assertEqual(self.h.posts, [])
        self.h.api('GET', '/season')
        self.assertEqual(self.h.http_calls[-1]['timeout'], 30)

    def test_nested_budget_cannot_extend_parent(self):
        with self.source.hooks.scope(.1):
            first = self.source.hooks.local.deadline
            with self.source.hooks.scope(20):
                self.assertEqual(first, self.source.hooks.local.deadline)

    def test_source_work_is_bounded_and_nested_run_does_not_deadlock(self):
        release = threading.Event()
        entered = threading.Event()
        guard = threading.Lock()
        active = 0
        peak = 0
        def operation():
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
                if active == 2:
                    entered.set()
            self.assertTrue(release.wait(2))
            self.source.run(lambda: None)
            with guard:
                active -= 1
        with ThreadPoolExecutor(4) as pool:
            futures = [pool.submit(self.source.run, operation, 3) for _ in range(4)]
            self.assertTrue(entered.wait(1))
            with guard:
                self.assertEqual(active, 2)
            release.set()
            for future in futures:
                future.result(4)
        self.assertEqual(peak, 2)

    def test_no_signup_grab_or_credentials_in_diagnostics(self):
        self.source.api('GET', '/search')
        self.assertNotIn('private', self.source.namespace)
        self.assertNotIn('private', repr(self.source.timings.snapshot()))
        self.h.CFG = {**self.h.CFG, 'base_query': {'aid': 1, 'device_id': 'different'}}
        other = SourceRequests(self.h)
        self.assertEqual(self.source.namespace, other.namespace)

    def test_public_version_refresh_changes_namespace_without_reinstalling_hooks(self):
        before = self.source.namespace
        self.h.CFG = {**self.h.CFG, 'base_query': {'aid': 1, 'version_code': 'updated'}}
        self.assertNotEqual(before, self.source.namespace)
        self.assertIs(SourceRequests(self.h).hooks, self.source.hooks)

    def test_invalid_signing_response_does_not_send_upstream(self):
        self.h.post = lambda *args, **kwargs: Reply({'error': 'internal detail'})
        with self.assertRaisesRegex(RuntimeError, '签名暂时不可用'):
            self.source.api('GET', '/search')
        self.assertEqual(self.h.http_calls, [])

    def test_missing_or_malformed_signature_does_not_send_upstream(self):
        for value in ({}, {'metadata': 'ok'}, {'X-Argus': 123}, {'X-Argus': ''}):
            reply = Reply()
            reply.data = value
            self.h.post = lambda *args, **kwargs: reply
            with self.assertRaisesRegex(RuntimeError, '签名暂时不可用'):
                self.source.api('GET', '/search')
            self.assertEqual(self.h.http_calls, [])
            self.assertTrue(reply.closed)

    def test_network_timeout_is_typed_only_in_scoped_operations(self):
        def fail(*args, **kwargs):
            raise requests.exceptions.ReadTimeout('fixture')
        self.source.hooks.original_http = fail
        with self.assertRaises(SourceTimeout):
            self.source.api('GET', '/search')
        with self.assertRaises(requests.exceptions.ReadTimeout):
            self.h.api('GET', '/season')
