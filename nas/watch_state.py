"""Shared household viewing state, protected by the existing site middleware."""
import json
import math
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse

KINDS = {'history', 'favorite', 'hidden'}
MAX_RECORDS = 6000


def validate(operation):
    if not isinstance(operation, dict):
        raise ValueError('记录格式无效')
    kind, sid, base, value = (operation.get(k) for k in ('kind', 'sid', 'base', 'value'))
    if kind not in KINDS or not isinstance(sid, str) or not re.fullmatch(r'\d{1,24}', sid):
        raise ValueError('剧集编号无效')
    if type(base) is not int or base < 0 or type(operation.get('seed', False)) is not bool:
        raise ValueError('记录版本无效')
    if value is None:
        return {**operation, 'value': None}
    if not isinstance(value, dict):
        raise ValueError('记录内容无效')
    clean = {'sid': sid}
    for key, maximum in [('title', 500), ('cover', 4096)]:
        text = value.get(key, '')
        if not isinstance(text, str) or len(text) > maximum:
            raise ValueError('剧集信息过长')
        if key == 'cover' and text and not text.startswith(('https://', 'http://')):
            raise ValueError('封面地址无效')
        clean[key] = text
    if kind == 'history':
        for key in ('ep', 'epCnt'):
            n = value.get(key, 1)
            if type(n) is not int or not 1 <= n <= 10000:
                raise ValueError('集数无效')
            clean[key] = n
        for key in ('pos', 'dur'):
            n = value.get(key, 0)
            if type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n <= 86400:
                raise ValueError('进度无效')
            clean[key] = n
        if type(value.get('finished', False)) is not bool:
            raise ValueError('播放状态无效')
        clean['finished'] = value.get('finished', False)
        clean['pos'] = min(clean['pos'], clean['dur']) if clean['dur'] else 0
    elif kind == 'hidden':
        if value.get('reason') not in ('finished', 'dislike'):
            raise ValueError('隐藏原因无效')
        clean['reason'] = value['reason']
    else:
        count = value.get('epCnt', 0)
        if type(count) is not int or not 0 <= count <= 10000:
            raise ValueError('集数无效')
        clean['epCnt'] = count
    if operation.get('seed'):
        stamp = value.get('ts', 0)
        if type(stamp) in (int, float) and math.isfinite(stamp):
            clean['ts'] = min(max(0, stamp), int(time.time() * 1000))
    return {**operation, 'value': clean}


class WatchState:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS identity (id TEXT PRIMARY KEY)')
            if not db.execute('SELECT id FROM identity').fetchone():
                db.execute('INSERT INTO identity VALUES (?)', (str(uuid.uuid4()),))
            db.execute('CREATE TABLE IF NOT EXISTS entries (kind TEXT, sid TEXT, revision INTEGER, value TEXT, PRIMARY KEY(kind,sid))')
            db.execute('CREATE INDEX IF NOT EXISTS entries_revision ON entries(revision)')
            self.server_id = db.execute('SELECT id FROM identity').fetchone()[0]
            db.execute('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, revision INTEGER)')
            db.execute('INSERT OR IGNORE INTO counter VALUES (1,0)')
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def row(row):
        return dict(zip(('kind', 'sid', 'rev', 'value'), (*row[:3], json.loads(row[3]))))

    def snapshot(self, since=0):
        with self.connect() as db:
            db.execute('BEGIN')
            revision = db.execute('SELECT revision FROM counter').fetchone()[0]
            if since > revision:
                since = 0
            rows = db.execute('SELECT kind,sid,revision,value FROM entries WHERE revision>? ORDER BY revision', (since,)).fetchall()
            return {'server': db.execute('SELECT id FROM identity').fetchone()[0], 'cursor': revision,
                    'rows': [self.row(row) for row in rows]}

    def apply(self, operations):
        if not isinstance(operations, list) or not 1 <= len(operations) <= 50:
            raise ValueError('每次同步1至50条记录')
        checked = [validate(op) for op in operations]
        if len({(op['kind'], op['sid']) for op in checked}) != len(checked):
            raise ValueError('不能重复提交同一条记录')
        result = []
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
            for op in checked:
                kind, sid = op['kind'], op['sid']
                old = db.execute('SELECT kind,sid,revision,value FROM entries WHERE kind=? AND sid=?', (kind, sid)).fetchone()
                revision = old[2] if old else 0
                if op['base'] != revision or (op.get('seed') and old):
                    result.append({'ok': False, **(self.row(old) if old else {'kind': kind, 'sid': sid, 'rev': 0, 'value': None})})
                    continue
                if old is None and count >= MAX_RECORDS:
                    raise ValueError('同步记录已达上限，请联系管理员')
                value = op['value']
                if value is not None and kind in ('favorite', 'hidden') and (old is None or old[3] == 'null'):
                    cap = 500 if kind == 'favorite' else 1000
                    if db.execute('SELECT COUNT(*) FROM entries WHERE kind=? AND value!=?', (kind, 'null')).fetchone()[0] >= cap:
                        raise ValueError('收藏或隐藏列表已达上限')
                if value is not None:
                    value['ts'] = value.get('ts', 0) if op.get('seed') else int(time.time() * 1000)
                db.execute('UPDATE counter SET revision=revision+1')
                new_rev = db.execute('SELECT revision FROM counter').fetchone()[0]
                db.execute('INSERT OR REPLACE INTO entries VALUES (?,?,?,?)', (kind, sid, new_rev, json.dumps(value, ensure_ascii=False)))
                if old is None:
                    count += 1
                result.append({'ok': True, 'kind': kind, 'sid': sid, 'rev': new_rev, 'value': value})
            # Keep only 200 live progress records; tombstones prevent old devices restoring evictions.
            histories = db.execute("SELECT sid,value FROM entries WHERE kind='history' AND value!='null'").fetchall()
            histories.sort(key=lambda row: json.loads(row[1]).get('ts', 0), reverse=True)
            for sid, _ in histories[200:]:
                db.execute('UPDATE counter SET revision=revision+1')
                new_rev = db.execute('SELECT revision FROM counter').fetchone()[0]
                db.execute("UPDATE entries SET value='null',revision=? WHERE kind='history' AND sid=?", (new_rev, sid))
        return result

    def values(self, kind):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT value FROM entries WHERE kind=? AND value!=?', (kind, 'null'))]


def install_watch_state(app, store, resolve=None):
    @app.get('/watch-state')
    def read_watch_state(request: Request, since: int = Query(0, ge=0)):
        current = resolve(request) if resolve else store
        return JSONResponse(current.snapshot(since), headers={'Cache-Control': 'private, no-store'})

    @app.post('/watch-state')
    async def write_watch_state(request: Request):
        current = resolve(request) if resolve else store
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise HTTPException(415, '请提交JSON')
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 128 * 1024:
                raise HTTPException(413, '同步内容过大')
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or data.get('server') != current.server_id:
                raise HTTPException(409, '服务器已变更，请重新同步')
            rows = current.apply(data.get('operations'))
        except (ValueError, TypeError) as error:
            raise HTTPException(400, str(error)) from error
        return JSONResponse({'rows': rows}, headers={'Cache-Control': 'private, no-store'})
