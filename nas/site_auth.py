"""Shared website password and revocable, persistent browser sessions."""
import argparse
import re
import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, StrictStr
from starlette.datastructures import Headers

COOKIE = "coding_session"
SESSION_SECONDS = 7 * 86400
ITERATIONS = 600000


class PasswordBody(BaseModel):
    password: StrictStr = Field(min_length=1, max_length=256)


class ChangeBody(BaseModel):
    current_password: StrictStr = Field(min_length=1, max_length=256)
    new_password: StrictStr = Field(min_length=8, max_length=256)


class SetupBody(BaseModel):
    token: StrictStr = Field(min_length=20, max_length=100)
    password: StrictStr = Field(min_length=8, max_length=256)


class SiteAuth:
    def __init__(self, path, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.lock = threading.RLock()
        self.attempts = {}
        self.global_attempts = deque()
        with self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS password (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB, digest BLOB)")
            db.execute("CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires REAL)")
            db.execute("CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT, expires REAL)")
        self.path.chmod(0o600)

    @contextmanager
    def database(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def password_digest(password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)

    @staticmethod
    def session_digest(token):
        return hashlib.sha256(token.encode("ascii")).hexdigest()

    def initialize(self):
        """Issue a one-use setup link from the NAS console, never a public claim."""
        with self.lock, self.database() as db:
            if db.execute("SELECT 1 FROM password WHERE id=1").fetchone():
                return None
            token = secrets.token_urlsafe(32)
            db.execute("INSERT OR REPLACE INTO setup VALUES (1, ?, ?)", (self.session_digest(token), self.clock() + 86400))
            return token

    def setup(self, token, password):
        with self.lock, self.database() as db:
            row = db.execute("SELECT digest, expires FROM setup WHERE id=1").fetchone()
            if db.execute("SELECT 1 FROM password WHERE id=1").fetchone() or not row:
                return False
            if not token.isascii() or not hmac.compare_digest(self.session_digest(token), row[0]) or row[1] <= self.clock():
                return False
            salt = secrets.token_bytes(32)
            db.execute("INSERT INTO password VALUES (1, ?, ?)", (salt, self.password_digest(password, salt)))
            db.execute("DELETE FROM setup")
            return True

    def configured(self):
        with self.database() as db:
            return bool(db.execute("SELECT 1 FROM password WHERE id=1").fetchone())

    def permit_attempt(self, address):
        # Use the socket peer, never caller-supplied forwarding headers.
        now = self.clock()
        with self.lock:
            self.attempts = {ip: q for ip, q in self.attempts.items() if q and q[-1] > now - 60}
            while self.global_attempts and self.global_attempts[0] <= now - 60:
                self.global_attempts.popleft()
            attempts = self.attempts.setdefault(address, deque())
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if len(attempts) >= 5 or len(self.global_attempts) >= 40:
                return False
            attempts.append(now)
            self.global_attempts.append(now)
            return True

    def login(self, password):
        with self.lock, self.database() as db:
            row = db.execute("SELECT salt, digest FROM password WHERE id=1").fetchone()
            if not row or not hmac.compare_digest(self.password_digest(password, row[0]), row[1]):
                return None
            token = secrets.token_urlsafe(32)
            now = self.clock()
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            # Bound storage when a password holder repeatedly creates sessions.
            db.execute("DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 99)")
            db.execute("INSERT INTO sessions VALUES (?, ?)", (self.session_digest(token), now + SESSION_SECONDS))
            return token

    def valid(self, token):
        if not token or len(token) > 100 or not token.isascii():
            return False
        with self.database() as db:
            row = db.execute("SELECT expires FROM sessions WHERE digest=?", (self.session_digest(token),)).fetchone()
            return bool(row and row[0] > self.clock())

    def logout(self, token):
        if token and token.isascii() and len(token) <= 100:
            with self.lock, self.database() as db:
                db.execute("DELETE FROM sessions WHERE digest=?", (self.session_digest(token),))

    def change(self, current_password, new_password):
        with self.lock, self.database() as db:
            row = db.execute("SELECT salt, digest FROM password WHERE id=1").fetchone()
            if not row or not hmac.compare_digest(self.password_digest(current_password, row[0]), row[1]):
                return False
            salt = secrets.token_bytes(32)
            db.execute("UPDATE password SET salt=?, digest=? WHERE id=1", (salt, self.password_digest(new_password, salt)))
            db.execute("DELETE FROM sessions")
            return True


class AuthMiddleware:
    def __init__(self, app, auth):
        self.app, self.auth = app, auth

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        path, method = scope["path"], scope["method"]
        peer = (scope.get("client") or ("", 0))[0]
        # Uvicorn runs with proxy_headers=False; this exemption is Docker-local only.
        local_health = path == "/healthz" and method in {"GET", "HEAD"} and peer in {"127.0.0.1", "::1"}
        public = (path == "/login" and method in {"GET", "HEAD"}) or (path in {"/auth/login", "/auth/login-form", "/auth/setup"} and method == "POST")
        public_update = method in {"GET", "HEAD"} and re.fullmatch(r"/updates/android-tv-public/(latest|[0-9a-f]{64}\.apk)", path) is not None
        if not public and not public_update and not local_health and not self.auth.valid(request.cookies.get(COOKIE)):
            if path in {"/", "/ui", "/phone-input"} and method in {"GET", "HEAD"}:
                query = scope.get("query_string", b"").decode("ascii", errors="ignore")
                target = path + ("?" + query if query else "")
                response = RedirectResponse("/login?" + urlencode({"next": target}), status_code=303)
            else:
                response = JSONResponse({"detail": "请先登录", "code": "login_required"}, status_code=401)
            response.headers["Cache-Control"] = "no-store"
            await response(scope, receive, send)
            return
        if method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            expected = f"{scope.get('scheme', 'http')}://{request.headers.get('host', '')}"
            if not origin or origin != expected:
                await JSONResponse({"detail": "请从本站页面操作"}, status_code=403)(scope, receive, send)
                return
        if path in {"/auth/login", "/auth/login-form", "/auth/setup"} and method == "POST":
            expected_type = "application/x-www-form-urlencoded" if path == "/auth/login-form" else "application/json"
            if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != expected_type:
                await JSONResponse({"detail": "请求格式错误"}, status_code=415)(scope, receive, send)
                return
            # Bound anonymous bodies even when Content-Length is absent/chunked.
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > 4096:
                    await JSONResponse({"detail": "请求过大"}, status_code=413)(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            original_receive = receive
            delivered = False
            async def buffered_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await original_receive()
            receive = buffered_receive

        async def private_send(message):
            if message["type"] == "http.response.start":
                headers = Headers(raw=message["headers"])
                cache = headers.get("cache-control", "")
                if path in {"/", "/ui", "/login"} or path.startswith(("/auth/", "/phone-input")):
                    cache = "no-store"
                elif "private" not in cache and "no-store" not in cache:
                    cache = "private" + (", " + cache.replace("public, ", "").replace("public", "").strip(", ") if cache else "")
                message["headers"] = [(k, v) for k, v in message["headers"] if k.lower() not in {b"cache-control", b"x-frame-options", b"referrer-policy"}]
                message["headers"] += [(b"cache-control", cache.encode()), (b"x-frame-options", b"DENY"), (b"referrer-policy", b"same-origin")]
            await send(message)
        await self.app(scope, receive, private_send)


def install_auth(app, auth, login_page):
    app.add_middleware(AuthMiddleware, auth=auth)

    def signed_in(token, request, response=None):
        response = response or JSONResponse({"ok": True})
        response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True, secure=request.url.scheme == "https", samesite="lax", path="/")
        return response

    def safe_next(value):
        try:
            target = urlsplit(value or "/ui")
        except ValueError:
            return "/ui"
        if target.scheme or target.netloc or not target.path.startswith("/") or target.path.startswith("//"):
            return "/ui"
        if target.path not in {"/", "/ui", "/phone-input"}:
            return "/ui"
        return urlunsplit(("", "", target.path, target.query, ""))

    def form_failure(target, error, retry_after=None):
        response = RedirectResponse("/login?" + urlencode({"next": target, "error": error}), status_code=303)
        if retry_after:
            response.headers["Retry-After"] = retry_after
        return response

    @app.get("/login", include_in_schema=False)
    def login_page_route():
        return FileResponse(login_page, media_type="text/html")

    @app.post("/auth/setup", include_in_schema=False)
    def setup_password(body: SetupBody, request: Request):
        if not auth.permit_attempt(request.client.host):
            return JSONResponse({"detail": "尝试次数过多，请一分钟后再试"}, status_code=429, headers={"Retry-After": "60"})
        if not auth.setup(body.token, body.password):
            return JSONResponse({"detail": "初始化入口已失效或密码已设置，请返回登录"}, status_code=400)
        return signed_in(auth.login(body.password), request)

    @app.post("/auth/login", include_in_schema=False)
    def login(body: PasswordBody, request: Request):
        if not auth.permit_attempt(request.client.host):
            return JSONResponse({"detail": "尝试次数过多，请一分钟后再试"}, status_code=429, headers={"Retry-After": "60"})
        if not auth.configured():
            return JSONResponse({"detail": "请先通过一次性初始化入口设置密码"}, status_code=503)
        token = auth.login(body.password)
        if not token:
            return JSONResponse({"detail": "密码不正确"}, status_code=401)
        return signed_in(token, request)

    @app.post("/auth/login-form", include_in_schema=False)
    async def login_form(request: Request):
        try:
            values = parse_qs((await request.body()).decode("utf-8"), keep_blank_values=True, max_num_fields=4)
            password_values = values.get("password", [])
            next_values = values.get("next", [])
            if len(password_values) != 1 or len(next_values) > 1:
                raise ValueError("invalid form")
            password = password_values[0]
            target = safe_next(next_values[0] if next_values else "/ui")
        except (UnicodeDecodeError, ValueError):
            return form_failure("/ui", "invalid")
        if not 1 <= len(password) <= 256:
            return form_failure(target, "invalid")
        if not auth.permit_attempt(request.client.host):
            return form_failure(target, "rate_limited", "60")
        if not auth.configured():
            return form_failure(target, "setup_required")
        token = auth.login(password)
        if not token:
            return form_failure(target, "incorrect")
        return signed_in(token, request, RedirectResponse(target, status_code=303))

    @app.post("/auth/logout", include_in_schema=False)
    def logout(request: Request):
        auth.logout(request.cookies.get(COOKIE))
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, httponly=True, samesite="lax", path="/")
        return response

    @app.post("/auth/password", include_in_schema=False)
    def change_password(body: ChangeBody, request: Request):
        if not auth.permit_attempt(request.client.host):
            return JSONResponse({"detail": "尝试次数过多，请一分钟后再试"}, status_code=429, headers={"Retry-After": "60"})
        if not auth.change(body.current_password, body.new_password):
            return JSONResponse({"detail": "当前密码不正确"}, status_code=400)
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, httponly=True, samesite="lax", path="/")
        return response


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--initialize", metavar="DATABASE", required=True)
    args = parser.parse_args()
    token = SiteAuth(args.initialize).initialize()
    print(token if token else "密码已配置，保持原密码")
