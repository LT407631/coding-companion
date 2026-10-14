import asyncio
import json
import tempfile
import unittest
from http.cookies import SimpleCookie
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from site_auth import COOKIE, SESSION_SECONDS, SiteAuth, install_auth


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.now = 1000000
        self.auth = SiteAuth(self.root / ".site_auth.sqlite3", clock=lambda: self.now)
        self.setup_token = self.auth.initialize()
        self.assertTrue(self.auth.setup(self.setup_token, "fixture-password"))
        (self.root / "login.html").write_text("<h1>登录</h1>")
        (self.root / "movie.mp4").write_bytes(b"test-video-body")
        self.hits = 0
        self.app = FastAPI()

        @self.app.middleware("http")
        async def original_middleware(request, call_next):
            self.hits += 1
            return await call_next(request)

        for path in ["/", "/ui", "/search", "/play", "/episodes", "/img", "/healthz", "/playback/status"]:
            self.app.add_api_route(path, lambda: JSONResponse({"ok": True}, headers={"Cache-Control": "public, max-age=900", "ETag": "fixture"}), methods=["GET"])
        self.app.add_api_route("/cache/clear", lambda: {"ok": True}, methods=["POST"])
        self.app.add_api_route("/download", lambda: {"ok": True}, methods=["POST"])
        self.app.add_api_route("/stream", lambda: FileResponse(self.root / "movie.mp4", media_type="video/mp4"), methods=["GET", "HEAD"])

        @self.app.get("/admin")
        def admin(request: Request):
            return JSONResponse({"ok": True}, status_code=200 if request.headers.get("x-admin-token") == "fixture-admin-token" else 401)

        install_auth(self.app, self.auth, self.root / "login.html")

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, path, method="GET", data=None, cookie=None, headers=None, peer="198.51.100.10", origin="http://site.test", raw=None, more_body=False):
        body = raw if raw is not None else json.dumps(data).encode() if data is not None else b""
        header_values = {"host": "site.test"}
        if method == "POST":
            header_values["content-type"] = "application/json"
            if origin is not None:
                header_values["origin"] = origin
        if cookie:
            header_values["cookie"] = f"{COOKIE}={cookie}"
        header_values.update(headers or {})
        base, _, query = path.partition("?")
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "scheme": "http", "method": method, "path": base, "raw_path": base.encode(), "root_path": "", "query_string": query.encode(), "headers": [(k.lower().encode(), v.encode()) for k, v in header_values.items()], "client": (peer, 12345), "server": ("site.test", 80)}
        messages = []
        async def run():
            received = False
            async def receive():
                nonlocal received
                if not received:
                    received = True
                    return {"type": "http.request", "body": body, "more_body": more_body}
                await asyncio.Event().wait()
            async def send(message):
                messages.append(message)
            await self.app(scope, receive, send)
        asyncio.run(asyncio.wait_for(run(), timeout=10))
        start = next(m for m in messages if m["type"] == "http.response.start")
        return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}, b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")

    def login(self, password="fixture-password"):
        status, headers, _ = self.request("/auth/login", "POST", {"password": password})
        self.assertEqual(status, 200)
        cookies = SimpleCookie(headers["set-cookie"])
        return cookies[COOKIE].value, headers

    def test_default_deny_before_original_endpoints_and_middleware(self):
        for path in ["/search", "/play?series_id=1", "/episodes", "/img", "/stream", "/playback/status", "/docs", "/redoc", "/openapi.json", "/admin", "/stats", "/not-yet-existing", "/auth/password", "/ui/"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 401)
        self.assertEqual(self.hits, 0)
        self.assertEqual(self.request("/stream", "HEAD", headers={"range": "bytes=0-3"})[0], 401)
        self.assertEqual(self.request("/cache/clear", "POST")[0], 401)
        self.assertEqual(self.request("/download", "POST")[0], 401)

    def test_ui_redirect_preserves_query(self):
        status, headers, _ = self.request("/ui?v=fixture")
        self.assertEqual(status, 303)
        self.assertEqual(headers["location"], "/login?next=%2Fui%3Fv%3Dfixture")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(self.request("/login")[0], 200)

    def test_login_cookie_and_no_raw_password_or_session_in_database(self):
        token, headers = self.login()
        cookie = SimpleCookie(headers["set-cookie"])[COOKIE]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "lax")
        self.assertEqual(cookie["path"], "/")
        self.assertFalse(cookie["secure"], "HTTP session must work on the requested HTTP site")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(self.request("/ui", cookie=token)[0], 200)
        self.assertEqual(self.auth.path.stat().st_mode & 0o777, 0o600)
        contents = self.auth.path.read_bytes()
        for value in (b"fixture-password", token.encode(), self.setup_token.encode()):
            self.assertNotIn(value, contents)

    def test_native_video_range_and_private_cached_images(self):
        token, _ = self.login()
        status, headers, body = self.request("/stream", cookie=token, headers={"range": "bytes=0-3"})
        self.assertEqual((status, body), (206, b"test"))
        self.assertEqual(headers["content-range"], "bytes 0-3/15")
        self.assertIn("private", headers["cache-control"])
        status, headers, _ = self.request("/img", cookie=token)
        self.assertEqual((status, headers["etag"]), (200, "fixture"))
        self.assertEqual(headers["cache-control"], "private, max-age=900")

    def test_signed_in_site_user_does_not_gain_admin_rights(self):
        token, _ = self.login()
        self.assertEqual(self.request("/admin", cookie=token)[0], 401)
        self.assertEqual(self.request("/admin", cookie=token, headers={"x-admin-token": "fixture-admin-token"})[0], 200)
        self.assertEqual(self.request("/admin", headers={"x-admin-token": "fixture-admin-token"})[0], 401)

    def test_logout_revokes_copied_cookie(self):
        token, _ = self.login()
        self.assertEqual(self.request("/auth/logout", "POST", cookie=token)[0], 200)
        self.assertEqual(self.request("/stream", cookie=token)[0], 401)

    def test_persisted_sessions_and_expiration(self):
        token, _ = self.login()
        self.auth = SiteAuth(self.auth.path, clock=lambda: self.now)
        self.assertTrue(self.auth.valid(token))
        self.now += SESSION_SECONDS
        self.assertFalse(self.auth.valid(token))

    def test_password_change_requires_old_password_and_revokes_all_devices(self):
        token, _ = self.login()
        other, _ = self.login()
        self.assertEqual(self.request("/auth/password", "POST", {"current_password": "wrong", "new_password": "new-fixture-password"}, cookie=token)[0], 400)
        self.assertTrue(self.auth.valid(other))
        self.assertEqual(self.request("/auth/password", "POST", {"current_password": "fixture-password", "new_password": "new-fixture-password"}, cookie=token)[0], 200)
        self.assertFalse(self.auth.valid(token))
        self.assertFalse(self.auth.valid(other))
        self.assertIsNone(self.auth.login("fixture-password"))
        self.assertTrue(self.auth.login("new-fixture-password"))

    def test_foreign_and_missing_origin_cannot_login_or_modify(self):
        token, _ = self.login()
        for origin in (None, "null", "http://attacker.test", "http://site.test.attacker.test"):
            for path, data, cookie in [("/auth/login", {"password": "fixture-password"}, None), ("/cache/clear", None, token), ("/auth/logout", None, token), ("/auth/password", {"current_password": "fixture-password", "new_password": "new-fixture-password"}, token)]:
                with self.subTest(origin=origin, path=path):
                    self.assertEqual(self.request(path, "POST", data, cookie=cookie, origin=origin)[0], 403)
        self.assertTrue(self.auth.valid(token))

    def test_login_rate_limit_and_spoofed_forwarded_addresses(self):
        for _ in range(5):
            self.assertEqual(self.request("/auth/login", "POST", {"password": "wrong"})[0], 401)
        status, headers, _ = self.request("/auth/login", "POST", {"password": "fixture-password"}, headers={"x-forwarded-for": "127.0.0.1"})
        self.assertEqual((status, headers["retry-after"]), (429, "60"))
        self.now += 61
        self.assertEqual(self.request("/auth/login", "POST", {"password": "fixture-password"})[0], 200)

    def test_global_attempt_limit_is_bounded_across_many_ips(self):
        for i in range(40):
            self.assertTrue(self.auth.permit_attempt(f"198.51.100.{i}"))
        self.assertFalse(self.auth.permit_attempt("192.0.2.1"))
        self.now += 61
        self.assertTrue(self.auth.permit_attempt("192.0.2.1"))
        self.assertEqual(len(self.auth.attempts), 1)

    def test_health_exemption_is_only_real_loopback_peer(self):
        self.assertEqual(self.request("/healthz", peer="127.0.0.1")[0], 200)
        self.assertEqual(self.request("/healthz", peer="::1")[0], 200)
        self.assertEqual(self.request("/healthz", headers={"x-forwarded-for": "127.0.0.1", "forwarded": "for=127.0.0.1"})[0], 401)
        self.assertEqual(self.request("/stream", peer="127.0.0.1")[0], 401)

    def test_setup_missing_password_fails_closed(self):
        with self.auth.database() as db:
            db.execute("DELETE FROM password")
            db.execute("DELETE FROM sessions")
        self.assertEqual(self.request("/ui")[0], 303)
        self.assertEqual(self.request("/stream")[0], 401)
        self.assertEqual(self.request("/auth/login", "POST", {"password": "anything"})[0], 503)
        self.assertEqual(self.request("/auth/setup", "POST", {"token": "a" * 43, "password": "fixture-password"})[0], 400)

    def test_setup_link_one_use_expiry_and_cookie_after_user_sets_password(self):
        with self.auth.database() as db:
            db.execute("DELETE FROM password")
        setup = self.auth.initialize()
        self.assertEqual(self.request("/auth/setup", "POST", {"token": "bad-token" * 5, "password": "fixture-password"})[0], 400)
        status, headers, _ = self.request("/auth/setup", "POST", {"token": setup, "password": "fixture-password"})
        self.assertEqual(status, 200)
        self.assertTrue(self.auth.valid(SimpleCookie(headers["set-cookie"])[COOKIE].value))
        self.assertFalse(self.auth.setup(setup, "replacement-password"))
        self.assertIsNone(self.auth.initialize())
        with self.auth.database() as db:
            db.execute("DELETE FROM password")
        setup = self.auth.initialize()
        self.now += 86400
        self.assertFalse(self.auth.setup(setup, "fixture-password"))

    def test_anonymous_body_limit_without_content_length_and_simple_form_rejected(self):
        self.assertEqual(self.request("/auth/login", "POST", raw=b"x" * 4097, more_body=True)[0], 413)
        self.assertEqual(self.request("/auth/setup", "POST", raw=b"x" * 4097, more_body=True)[0], 413)
        self.assertEqual(self.request("/auth/login", "POST", {"password": "fixture-password"}, headers={"content-type": "text/plain"})[0], 415)

    def test_malformed_and_short_passwords_and_untrusted_cookies(self):
        self.assertEqual(self.request("/auth/login", "POST", raw=b"not-json")[0], 422)
        token, _ = self.login()
        self.assertEqual(self.request("/auth/password", "POST", {"current_password": "fixture-password", "new_password": "tiny"}, cookie=token)[0], 422)
        for value in ("bogus", "é", "x" * 101):
            self.assertFalse(self.auth.valid(value))


if __name__ == "__main__":
    unittest.main()
