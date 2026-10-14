"""Durable catalogue/cover cache: serve stale content and refresh in the background."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


@dataclass
class Payload:
    body: bytes
    media_type: str = 'application/json'
    source_etag: str = ''
    source_modified: str = ''


@dataclass
class Entry:
    body: bytes
    media_type: str
    etag: str
    checked: float
    updated: float
    source_etag: str = ''
    source_modified: str = ''


class CatalogCache:
    def __init__(self, root, max_bytes=512 * 1024**2, workers=2, max_pending=48):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.guard = threading.RLock()
        self.db = sqlite3.connect(self.root / 'cache.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, body BLOB NOT NULL, media TEXT NOT NULL, etag TEXT NOT NULL, checked REAL NOT NULL, updated REAL NOT NULL, source_etag TEXT, source_modified TEXT)')
        self.db.commit()
        self.max_bytes = max_bytes
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='catalog-refresh')
        self.max_pending = max_pending
        self.pending = {}
        self.generation = 0
        self.locks = {}
        self.retry_after = {}

    def read(self, key):
        with self.guard:
            row = self.db.execute('SELECT body,media,etag,checked,updated,source_etag,source_modified FROM entries WHERE key=?', (key,)).fetchone()
            return Entry(*row) if row else None

    def put(self, key, payload, previous=None, generation=None):
        now = time.time()
        # None means a conditional source response was 304 Not Modified.
        if payload is None:
            if previous is None:
                raise ValueError('304 response without a cached body')
            with self.guard:
                if generation is not None and generation != self.generation:
                    return previous
                self.db.execute('UPDATE entries SET checked=? WHERE key=?', (now, key))
                self.db.commit()
            return self.read(key)
        if not payload.body or len(payload.body) > min(self.max_bytes, 20 * 1024**2):
            raise ValueError('Empty or oversized response is not cacheable')
        etag = '"' + hashlib.sha256(payload.body).hexdigest() + '"'
        updated = previous.updated if previous and previous.etag == etag else now
        with self.guard:
            if generation is not None and generation != self.generation:
                return Entry(payload.body, payload.media_type, etag, now, now, payload.source_etag, payload.source_modified)
            if previous and previous.etag == etag:
                self.db.execute('UPDATE entries SET checked=?,source_etag=?,source_modified=? WHERE key=?', (now, payload.source_etag, payload.source_modified, key))
            else:
                self.db.execute('INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?,?)', (key, payload.body, payload.media_type, etag, now, updated, payload.source_etag, payload.source_modified))
            total = self.db.execute('SELECT COALESCE(SUM(LENGTH(body)),0) FROM entries').fetchone()[0]
            count = self.db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
            for old_key, size in self.db.execute('SELECT key,LENGTH(body) FROM entries WHERE key<>? ORDER BY checked', (key,)).fetchall():
                if total <= self.max_bytes and count <= 3000:
                    break
                self.db.execute('DELETE FROM entries WHERE key=?', (old_key,))
                total -= size
                count -= 1
            self.db.commit()
            self.retry_after.pop(key, None)
        return self.read(key)

    def _lock(self, key):
        with self.guard:
            return self.locks.setdefault(key, threading.Lock())

    def _refresh(self, key, loader, generation):
        try:
            with self._lock(key):
                previous = self.read(key)
                self.put(key, loader(previous), previous, generation)
        except Exception:
            # An outage must never replace a usable snapshot or trigger a retry storm.
            with self.guard:
                if generation == self.generation:
                    self.retry_after[key] = time.time() + 60
        finally:
            with self.guard:
                if self.pending.get(key) == generation:
                    self.pending.pop(key, None)

    def refresh(self, key, loader, force=False):
        with self.guard:
            if key in self.pending or len(self.pending) >= self.max_pending:
                return False
            if not force and self.retry_after.get(key, 0) > time.time():
                return False
            self.pending[key] = self.generation
            self.pool.submit(self._refresh, key, loader, self.generation)
            return True

    def get(self, key, loader, ttl, force=False):
        entry = self.read(key)
        if entry:
            stale = force or time.time() - entry.checked >= ttl
            if stale:
                self.refresh(key, loader, force)
            return entry, 'STALE' if stale else 'HIT'
        with self._lock(key):
            entry = self.read(key)
            if entry:
                return entry, 'HIT'
            if self.retry_after.get(key, 0) > time.time():
                raise RuntimeError('内容服务暂时不可用，请稍后重试')
            with self.guard:
                generation = self.generation
            try:
                entry = self.put(key, loader(None), generation=generation)
            except Exception:
                with self.guard:
                    if generation == self.generation:
                        self.retry_after[key] = time.time() + 15
                raise
            return entry, 'MISS'

    def clear(self):
        with self.guard:
            self.generation += 1
            self.pending.clear()
            self.retry_after.clear()
            count = self.db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
            self.db.execute('DELETE FROM entries')
            self.db.commit()
            self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            self.db.execute('VACUUM')
            return count

    def close(self):
        self.pool.shutdown(wait=True)
        with self.guard:
            self.db.close()


def request_key(path, values):
    # Values have passed FastAPI's parameter validation and include defaults.
    values = {k: v for k, v in values.items() if k not in {'refresh', 'no_cache', '_request'}}
    return path + ':' + json_bytes(values).decode()


def response_headers(entry, state, max_age=30):
    return {'ETag': entry.etag, 'Cache-Control': f'private, max-age={max_age}, stale-while-revalidate=60', 'X-NAS-Cache': state, 'X-NAS-Updated': str(int(entry.updated))}


def not_modified(header, etag):
    return bool(header) and any(tag.strip().removeprefix('W/') in {etag, '*'} for tag in header.split(','))
