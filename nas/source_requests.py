"""Reuse the upstream client's request construction with scoped phase budgets.

Only explicit search/track operations get shorter timeouts and single attempts.
Legacy seasonal lookup and all other callers retain their original behavior.
"""
from contextlib import contextmanager
import hashlib
import json
import threading
import time
import requests

from timings import Timings


class SourceUnavailable(RuntimeError):
    pass


class SourceTimeout(SourceUnavailable):
    pass


class SourceRequests:
    def __init__(self, provider, timings=None):
        self.provider = provider
        self.timings = timings or Timings()
        # The upstream module uses global functions from _api_once/get_video_tracks.
        # Install once; thread-local scopes prevent cross-request timeout changes.
        hooks = getattr(provider, '_coding_source_hooks', None)
        if hooks is None and hasattr(provider, '_api_once'):
            hooks = _Hooks(provider, self.timings)
            provider._coding_source_hooks = hooks
        self.hooks = hooks

    @property
    def namespace(self):
        # The original session refresh can update app/version fields in place.
        cfg = getattr(self.provider, 'CFG', {})
        query = cfg.get('base_query', {})
        public = {name: query.get(name, '') for name in
                  ('aid', 'app_name', 'version_code', 'version_name', 'update_version_code')}
        return hashlib.sha256(json.dumps(
            [cfg.get('api_host', ''), public], sort_keys=True).encode()).hexdigest()

    def __getattr__(self, name):
        return getattr(self.provider, name)

    def run(self, operation, budget=12):
        if self.hooks is None:
            return operation()
        nested = getattr(self.hooks.local, 'deadline', None) is not None
        with self.hooks.scope(budget):
            acquired = nested or self.hooks.slots.acquire(timeout=self.hooks.remaining())
            if not acquired:
                raise SourceTimeout('内容源请求繁忙，请稍后重试')
            try:
                result = operation()
                self.hooks.remaining()
                return result
            finally:
                if not nested:
                    self.hooks.slots.release()

    def api(self, method, path, body=None, extra_query=None, signed=True, budget=12):
        if self.hooks is None:
            return self.provider.api(method, path, body=body,
                                     extra_query=extra_query, signed=signed)
        return self.run(lambda: self.provider._api_once(
            method, path, body, extra_query, signed=signed), budget)


class _Hooks:
    def __init__(self, provider, timings):
        self.provider, self.timings = provider, timings
        self.local = threading.local()
        # Bound new search/track work before it enters the single-thread signer.
        self.slots = threading.BoundedSemaphore(2)
        self.original_sign = provider.sign
        self.original_http = provider.http_request
        self.original_api = provider.api
        provider.sign = self.sign
        provider.http_request = self.http
        provider.api = self.api
        throttle = getattr(getattr(provider, 'SG', None), 'throttle', None)
        if throttle is not None:
            self.original_wait = throttle.wait
            throttle.wait = self.wait

    @contextmanager
    def scope(self, budget):
        previous = getattr(self.local, 'deadline', None)
        deadline = time.monotonic() + max(.1, min(float(budget), 30))
        self.local.deadline = min(previous, deadline) if previous else deadline
        try:
            yield
        finally:
            self.local.deadline = previous

    def remaining(self):
        deadline = getattr(self.local, 'deadline', None)
        if deadline is None:
            return None
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise SourceTimeout('内容源响应超时，请稍后重试')
        return seconds

    def api(self, method, path, body=None, extra_query=None, **options):
        if self.remaining() is None:
            return self.original_api(method, path, body=body,
                                     extra_query=extra_query, **options)
        # A failed URL/schema/signature is not repaired by retrying identical input.
        # Playback's outer retry refreshes the descriptors on its next attempt.
        return self.provider._api_once(method, path, body, extra_query,
                                      signed=options.get('signed', True))

    def wait(self):
        self.remaining()
        with self.timings.measure('throttle'):
            self.original_wait()
        self.remaining()

    def sign(self, url, headers):
        remaining = self.remaining()
        with self.timings.measure('sign'):
            if remaining is None:
                return self.original_sign(url, headers)
            servers = getattr(self.provider, 'SIGN_SERVERS', [])
            if not servers:
                raise SourceUnavailable('内容源签名服务未配置')
            last = None
            for _ in servers:
                remaining = self.remaining()
                base = self.provider._next_sign_server()
                try:
                    response = self.provider._sign_session().post(
                        base.rstrip('/') + '/sign', json={'url': url, 'headers': headers},
                        timeout=(min(3, remaining), remaining))
                    try:
                        response.raise_for_status()
                        data = response.json()
                        if (not isinstance(data, dict) or 'error' in data or
                                not any(str(key).lower() == 'x-argus' and
                                        isinstance(value, str) and value.strip()
                                        for key, value in data.items()) or
                                not all(isinstance(value, str) for value in data.values())):
                            raise RuntimeError('内容源签名暂时不可用')
                        self.remaining()
                        return data
                    finally:
                        response.close()
                except SourceTimeout:
                    raise
                except Exception as error:
                    last = error
            raise SourceUnavailable('内容源签名暂时不可用') from last

    def http(self, method, url, **options):
        remaining = self.remaining()
        if remaining is not None:
            original = options.get('timeout', 30)
            original = original if isinstance(original, tuple) else (original, original)
            options['timeout'] = (min(original[0] or remaining, 3, remaining),
                                  min(original[1] or remaining, remaining))
        with self.timings.measure('upstream'):
            try:
                response = self.original_http(method, url, **options)
            except requests.exceptions.Timeout as error:
                if remaining is not None:
                    raise SourceTimeout('内容源响应超时，请稍后重试') from error
                raise
            try:
                self.remaining()
            except SourceTimeout:
                response.close()
                raise
            return response
