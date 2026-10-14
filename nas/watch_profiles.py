"""Password-free household profiles behind the existing website login."""
import re
import sqlite3
import threading
import uuid
import json
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from watch_state import WatchState
from watch_updates import WatchUpdates


class WatchProfiles:
    def __init__(self, path, default, loader):
        self.path, self.default, self.loader = Path(path), default, loader
        self.folder = self.path.parent / '.watch_profiles'
        self.folder.mkdir(mode=0o700, exist_ok=True)
        self.lock = threading.Lock()
        self.stores = {'default': default}
        self.checks = {}
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT, name_key TEXT UNIQUE)')
            db.execute('INSERT OR IGNORE INTO profiles VALUES (?,?,?)', ('default', '默认用户', '默认用户'))
        self.path.chmod(0o600)

    def listing(self):
        with sqlite3.connect(self.path) as db:
            return [{'id': row[0], 'name': row[1]} for row in db.execute('SELECT id,name FROM profiles ORDER BY rowid')]

    def create(self, name):
        if not isinstance(name, str):
            raise HTTPException(400, '请输入成员名字')
        name = name.strip()
        if not name or len(name) > 20 or any(ord(c) < 32 for c in name):
            raise HTTPException(400, '请输入1至20个字的名字')
        identity = str(uuid.uuid4())
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM profiles').fetchone()[0] >= 8:
                raise HTTPException(400, '最多保存8位家庭成员')
            try:
                db.execute('INSERT INTO profiles VALUES (?,?,?)', (identity, name, name.casefold()))
            except sqlite3.IntegrityError as exc:
                raise HTTPException(409, '这个名字已经存在') from exc
        return {'id': identity, 'name': name}

    def identity(self, request):
        identity = request.headers.get('x-watch-profile', 'default')
        if identity != 'default' and not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', identity):
            raise HTTPException(404, '家庭成员不存在，请重新选择')
        with sqlite3.connect(self.path) as db:
            if not db.execute('SELECT 1 FROM profiles WHERE id=?', (identity,)).fetchone():
                raise HTTPException(404, '家庭成员不存在，请重新选择')
        return identity

    def state(self, request):
        identity = self.identity(request)
        with self.lock:
            if identity not in self.stores:
                self.stores[identity] = WatchState(self.folder / (identity + '.sqlite3'))
            return self.stores[identity]

    def updates(self, request):
        store = self.state(request)
        with self.lock:
            if store.server_id not in self.checks:
                self.checks[store.server_id] = WatchUpdates(store, self.loader)
            return self.checks[store.server_id]

    def close(self):
        for checker in self.checks.values():
            checker.close()


def install_watch_profiles(app, profiles):
    @app.get('/watch-profiles')
    def list_profiles():
        return JSONResponse({'items': profiles.listing()}, headers={'Cache-Control': 'private, no-store'})

    @app.post('/watch-profiles')
    async def create_profile(request: Request):
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise HTTPException(415, '请提交JSON')
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 4096:
                raise HTTPException(413, '成员信息过长')
        try:
            data = json.loads(body)
        except ValueError as exc:
            raise HTTPException(400, '成员信息无效') from exc
        if not isinstance(data, dict) or set(data) != {'name'}:
            raise HTTPException(400, '成员信息无效')
        return JSONResponse(profiles.create(data['name']), headers={'Cache-Control': 'private, no-store'}, status_code=201)

    app.router.add_event_handler('shutdown', profiles.close)
