import asyncio
import hashlib
import hmac
import re
import secrets
import time
from typing import TYPE_CHECKING
from uuid import uuid4

import aiosqlite
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import JSONResponse

from chemistry_agent.config import Settings
from chemistry_agent.errors import AgentError

if TYPE_CHECKING:
    from chemistry_agent.store import Store

COOKIE_NAME = "chemistry_session"
LOGIN_WINDOW = 900
LOGIN_LIMIT = 8


def normalize_username(username: str) -> str:
    username = username.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,31}", username):
        raise ValueError("用户名应为 3–32 位字母、数字、下划线、点或连字符。")
    return username


def hash_password(password: str) -> str:
    if not 12 <= len(password) <= 256:
        raise ValueError("密码应为 12–256 个字符。")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=32768, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32
    )
    return f"scrypt$32768$8$1${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    if len(password) > 256:
        return False
    try:
        scheme, n, r, p, salt, expected = encoded.split("$")
        if (scheme, n, r, p) != ("scrypt", "32768", "8", "1"):
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt),
            n=32768,
            r=8,
            p=1,
            maxmem=64 * 1024 * 1024,
            dklen=32,
        )
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = hash_password("dummy-password-never-used-to-login")


async def init_auth_schema(db: aiosqlite.Connection) -> None:
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
            expires_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
        CREATE TABLE IF NOT EXISTS auth_failures (
            scope TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start REAL NOT NULL
        );
    """)


async def create_user_account(settings: Settings, username: str, password: str) -> dict[str, str]:
    username = normalize_username(username)
    encoded = await asyncio.to_thread(hash_password, password)
    await asyncio.to_thread(settings.database_path.parent.mkdir, parents=True, exist_ok=True)
    async with aiosqlite.connect(settings.database_path, timeout=10) as db:
        await db.execute("PRAGMA foreign_keys=ON")
        await init_auth_schema(db)
        user_id = str(uuid4())
        try:
            await db.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                (user_id, username, encoded, time.time()),
            )
            await db.commit()
        except aiosqlite.IntegrityError as exc:
            raise ValueError("此用户名已存在。") from exc
    return {"id": user_id, "username": username}


class AuthManager:
    def __init__(self, settings: Settings, store: "Store"):
        self.settings = settings
        self.store = store

    async def current_user(self, token: str | None) -> dict[str, str] | None:
        if not token or len(token) > 256:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        async with self.store.lock:
            row = await self.store._one(
                "SELECT users.id, users.username FROM auth_sessions JOIN users "
                "ON users.id=auth_sessions.user_id "
                "WHERE token_hash=? AND expires_at>? AND active=1",
                (digest, time.time()),
            )
        return dict(row) if row else None

    async def login(self, username: str, password: str, client_ip: str) -> tuple[dict, str]:
        try:
            username = normalize_username(username)
        except ValueError:
            username = "!invalid"
        ip_scope = "ip:" + hashlib.sha256(client_ip.encode()).hexdigest()
        scope = "account:" + username
        now = time.time()
        async with self.store.transaction():
            await self.store.db.execute(
                "DELETE FROM auth_failures WHERE window_start<?", (now - LOGIN_WINDOW,)
            )
            for key in (ip_scope, scope):
                failure = await self.store._one(
                    "SELECT attempts FROM auth_failures WHERE scope=?", (key,)
                )
                if failure and failure["attempts"] >= LOGIN_LIMIT:
                    raise AgentError("login_rate_limited", "尝试次数过多，请 15 分钟后重试。", 429)
            for key in (ip_scope, scope):
                await self.store.db.execute(
                    "INSERT INTO auth_failures(scope,attempts,window_start) VALUES(?,1,?) "
                    "ON CONFLICT(scope) DO UPDATE SET attempts=attempts+1",
                    (key, now),
                )
            row = await self.store._one("SELECT * FROM users WHERE username=?", (username,))
        valid = await asyncio.to_thread(
            verify_password, password, row["password_hash"] if row else _DUMMY_HASH
        )
        if not row or not row["active"] or not valid:
            raise AgentError("invalid_credentials", "用户名或密码不正确。", 401)
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        async with self.store.transaction():
            current = await self.store._one(
                "SELECT active,password_hash FROM users WHERE id=?", (row["id"],)
            )
            if (
                not current
                or not current["active"]
                or not hmac.compare_digest(current["password_hash"], row["password_hash"])
            ):
                raise AgentError("invalid_credentials", "用户名或密码不正确。", 401)
            await self.store.db.execute(
                "DELETE FROM auth_failures WHERE scope IN (?,?)", (ip_scope, scope)
            )
            await self.store.db.execute("DELETE FROM auth_sessions WHERE expires_at<=?", (now,))
            await self.store.db.execute(
                "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                (digest, row["id"], now + self.settings.session_ttl_seconds),
            )
        return {"id": row["id"], "username": row["username"]}, token

    async def logout(self, token: str | None) -> None:
        if not token or len(token) > 256:
            return
        async with self.store.transaction():
            await self.store.db.execute(
                "DELETE FROM auth_sessions WHERE token_hash=?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            )


class AuthenticationMiddleware:
    """Pure ASGI middleware: do not put long-running agent tasks in a cancellation task group."""

    def __init__(self, app, settings: Settings):
        self.app = app
        self.settings = settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        request.state.user_id = None
        request.state.user = None
        if self.settings.auth_enabled:
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                origin = request.headers.get("origin")
                if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
                    response = JSONResponse(
                        status_code=403,
                        content={
                            "error": {
                                "code": "origin_rejected",
                                "message": "请求来源不被允许。",
                            }
                        },
                        headers={"Cache-Control": "no-store"},
                    )
                    await response(scope, receive, send)
                    return
            user = await request.app.state.auth.current_user(request.cookies.get(COOKIE_NAME))
            request.state.user = user
            request.state.user_id = user["id"] if user else None
            public = request.url.path in {
                "/",
                "/health",
                "/auth/status",
                "/auth/login",
                "/auth/logout",
            }
            if not public and not request.url.path.startswith("/assets/") and not user:
                response = JSONResponse(
                    status_code=401,
                    content={
                        "error": {
                            "code": "authentication_required",
                            "message": "请先登录工作空间。",
                        }
                    },
                    headers={"Cache-Control": "no-store"},
                )
                await response(scope, receive, send)
                return

        async def send_private(message):
            if message["type"] == "http.response.start" and not request.url.path.startswith(
                "/assets/"
            ):
                MutableHeaders(scope=message)["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_private)
