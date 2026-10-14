"""Bounded, process-local phase timings without URLs, queries or credentials."""
from contextlib import contextmanager
import threading
import time


class Timings:
    NAMES = frozenset({'search', 'sign', 'upstream', 'throttle', 'tracks',
                       'download', 'decrypt', 'validate', 'cover', 'stream',
                       'homepage', 'filters', 'episodes'})

    def __init__(self, clock=time.perf_counter):
        self.clock = clock
        self.guard = threading.Lock()
        self.values = {}

    @contextmanager
    def measure(self, name):
        if name not in self.NAMES:
            raise ValueError('Unknown timing phase')
        start = self.clock()
        failed = False
        try:
            yield
        except BaseException:
            failed = True
            raise
        finally:
            elapsed = max(0, (self.clock() - start) * 1000)
            with self.guard:
                item = self.values.setdefault(name, {'count': 0, 'errors': 0,
                                                     'total_ms': 0, 'max_ms': 0})
                item['count'] += 1
                item['errors'] += int(failed)
                item['last_ms'] = elapsed
                item['total_ms'] += elapsed
                item['max_ms'] = max(item['max_ms'], elapsed)

    def snapshot(self):
        with self.guard:
            return {name: {'count': value['count'], 'errors': value['errors'],
                           'last_ms': round(value['last_ms'], 2),
                           'average_ms': round(value['total_ms'] / value['count'], 2),
                           'max_ms': round(value['max_ms'], 2)}
                    for name, value in self.values.items()}


class TimingMiddleware:
    ROUTES = {'/search/page': 'search', '/library': 'homepage',
              '/filters': 'filters', '/episodes': 'episodes'}

    def __init__(self, app, timings):
        self.app, self.timings = app, timings

    async def __call__(self, scope, receive, send):
        phase = self.ROUTES.get(scope.get('path')) if scope['type'] == 'http' else None
        if phase is None:
            return await self.app(scope, receive, send)
        start = self.timings.clock()
        async def timed_send(message):
            if message['type'] == 'http.response.start':
                duration = max(0, (self.timings.clock() - start) * 1000)
                message = dict(message)
                message['headers'] = list(message.get('headers', [])) + [
                    (b'server-timing', f'{phase};dur={duration:.2f}'.encode())]
            await send(message)
        with self.timings.measure(phase):
            await self.app(scope, receive, timed_send)
