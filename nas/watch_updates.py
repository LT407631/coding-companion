"""Bounded, lazy favourite episode checks; no perpetual TV or NAS polling job."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fastapi.responses import JSONResponse
from fastapi import Request


class WatchUpdates:
    def __init__(self, state, loader, clock=time.time):
        self.state, self.loader, self.clock = state, loader, clock
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='watch-updates')
        self.lock, self.running = threading.Lock(), False
        with state.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS follows (sid TEXT PRIMARY KEY, baseline INTEGER, available INTEGER, checked REAL)')

    def refresh(self):
        with self.lock:
            if self.running:
                return
            self.running = True
        self.pool.submit(self._run)

    def _run(self):
        try:
            favorites = self.state.values('favorite')
            now = self.clock()
            with self.state.connect() as db:
                saved = {row[0]: row[1:] for row in db.execute('SELECT sid,baseline,available,checked FROM follows')}
                ids = {item['sid'] for item in favorites}
                for sid in set(saved) - ids:
                    db.execute('DELETE FROM follows WHERE sid=?', (sid,))
            due = [item for item in favorites if now - saved.get(item['sid'], (0, 0, 0))[2] >= 21600]
            due.sort(key=lambda item: saved.get(item['sid'], (0, 0, 0))[2])
            for item in due[:12]:
                sid = item['sid']; previous = saved.get(sid)
                try:
                    count = self.loader(sid)
                    if type(count) is not int or not 0 < count <= 10000:
                        raise ValueError('invalid available episode count')
                    baseline = previous[0] if previous and previous[1] else count
                    available = max(previous[1], count) if previous else count
                    with self.state.connect() as db:
                        db.execute('INSERT OR REPLACE INTO follows VALUES (?,?,?,?)', (sid, baseline, available, now))
                except Exception:
                    # Short backoff on failure, preserving the last successful count.
                    with self.state.connect() as db:
                        db.execute('INSERT OR REPLACE INTO follows VALUES (?,?,?,?)', (sid, previous[0] if previous else 0, previous[1] if previous else 0, now - 21600 + 600))
        finally:
            with self.lock:
                self.running = False

    def snapshot(self):
        favorite_ids = {v['sid'] for v in self.state.values('favorite')}
        history = {v['sid']: v for v in self.state.values('history')}
        with self.state.connect() as db:
            rows = db.execute('SELECT sid,baseline,available,checked FROM follows').fetchall()
        result = {}
        for sid, baseline, available, checked in rows:
            if sid not in favorite_ids or not available:
                continue
            rec = history.get(sid, {})
            seen = max(baseline, rec.get('ep', 0) - (0 if rec.get('finished') else 1))
            result[sid] = {'available': available, 'new': max(0, available - seen),
                           'next': min(available, rec.get('ep', 1) + (1 if rec.get('finished') and rec.get('ep', 1) < available else 0))}
        return {'items': result, 'checking': self.running}

    def close(self):
        self.pool.shutdown(wait=True)


def install_watch_updates(app, updates, resolve=None):
    @app.get('/watch-updates')
    def read_watch_updates(request: Request):
        current = resolve(request) if resolve else updates
        current.refresh()
        return JSONResponse(current.snapshot(), headers={'Cache-Control': 'private, no-store'})

    if resolve is None:
        app.router.add_event_handler('shutdown', updates.close)
