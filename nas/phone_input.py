"""Short-lived, authenticated phone-to-TV search pairing; no media access."""
import hashlib
import hmac
import io
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse

import qrcode
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, StrictStr
from site_auth import COOKIE

TTL = 15 * 60


class PairBody(BaseModel):
    public_origin: StrictStr = Field(default="", max_length=200)


class SearchBody(BaseModel):
    pair: StrictStr = Field(min_length=20, max_length=64)
    key: StrictStr = Field(min_length=20, max_length=64)
    query: StrictStr = Field(min_length=1, max_length=80)


class Pairings:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.pairs = {}

    @staticmethod
    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()

    def prune(self):
        now = self.clock()
        self.pairs = {key: p for key, p in self.pairs.items() if p['expires'] > now}

    def create(self, owner, origin, public_origin=""):
        if public_origin:
            parsed = urlparse(public_origin)
            try:
                valid = parsed.scheme in {"https", "http"} and parsed.hostname and parsed.port != 0
            except ValueError:
                valid = False
            if (not valid or parsed.username is not None or parsed.password is not None or
                    parsed.path not in {"", "/"} or parsed.query or parsed.fragment or
                    any(c.isspace() or ord(c) < 32 for c in public_origin)):
                raise HTTPException(400, '请在电视连接设置保存有效的外网网站地址')
            origin = public_origin.rstrip('/')
        with self.lock:
            self.prune()
            owner = self.digest(owner)
            self.pairs = {key: p for key, p in self.pairs.items() if p['owner'] != owner}
            if len(self.pairs) >= 256:
                raise HTTPException(429, '配对数量过多，请稍后重试')
            pair, key = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
            url = origin + '/phone-input#' + urlencode({'pair': pair, 'key': key})
            self.pairs[pair] = {'owner': owner, 'key': self.digest(key), 'url': url,
                                'expires': self.clock() + TTL, 'version': 0, 'query': '', 'last_send': None}
            return {'pair': pair, 'expires_in': TTL}

    def owned(self, pair, owner):
        self.prune()
        p = self.pairs.get(pair)
        if not p or not hmac.compare_digest(p['owner'], self.digest(owner)):
            raise HTTPException(404, '配对已结束，请在电视上重新扫码')
        return p

    def poll(self, pair, owner):
        with self.lock:
            p = self.owned(pair, owner)
            return {'version': p['version'], 'query': p['query'], 'expires_in': max(0, int(p['expires'] - self.clock()))}

    def close(self, pair, owner):
        with self.lock:
            self.owned(pair, owner)
            del self.pairs[pair]

    def url(self, pair, owner):
        with self.lock:
            return self.owned(pair, owner)['url']

    def submit(self, pair, key, query):
        query = query.strip()
        if not query or len(query) > 80 or any(ord(c) < 32 or ord(c) == 127 for c in query):
            raise HTTPException(400, '请输入 1–80 个字符的搜索内容')
        with self.lock:
            self.prune()
            p = self.pairs.get(pair)
            if not p or not hmac.compare_digest(p['key'], self.digest(key)):
                raise HTTPException(404, '配对已结束，请在电视上重新扫码')
            now = self.clock()
            if p['last_send'] is not None and now - p['last_send'] < 1:
                raise HTTPException(429, '发送太快，请稍等一秒')
            p['query'], p['last_send'] = query, now
            p['version'] += 1
            return {'ok': True, 'version': p['version']}


def install_phone_input(app, web_root, pairings=None):
    pairs = pairings if pairings is not None else Pairings()
    web_root = Path(web_root)

    @app.get('/phone-input', include_in_schema=False)
    def phone_page():
        return FileResponse(web_root / 'phone-input.html', headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})

    @app.get('/phone-input/client.js', include_in_schema=False)
    def phone_script():
        return FileResponse(web_root / 'assets/phone-input.js', media_type='application/javascript', headers={'Cache-Control': 'no-store'})

    @app.post('/phone-input/pairs', include_in_schema=False)
    def create(request: Request, body: PairBody = None):
        # Origin has already been verified by the existing login middleware.
        return pairs.create(request.cookies[COOKIE], request.headers['origin'], body.public_origin if body else '')

    @app.get('/phone-input/pairs/{pair}', include_in_schema=False)
    def poll(pair: str, request: Request):
        return pairs.poll(pair, request.cookies[COOKIE])

    @app.get('/phone-input/pairs/{pair}/qr', include_in_schema=False)
    def qr(pair: str, request: Request):
        url = pairs.url(pair, request.cookies[COOKIE])
        output = io.BytesIO()
        qrcode.make(url).save(output, format='PNG')
        return Response(output.getvalue(), media_type='image/png', headers={'Cache-Control': 'no-store'})

    @app.delete('/phone-input/pairs/{pair}', include_in_schema=False)
    def close(pair: str, request: Request):
        pairs.close(pair, request.cookies[COOKIE])
        return {'ok': True}

    @app.post('/phone-input/search', include_in_schema=False)
    def submit(body: SearchBody):
        return pairs.submit(body.pair, body.key, body.query)

    return pairs
