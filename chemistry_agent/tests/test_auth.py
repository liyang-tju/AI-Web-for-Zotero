import hashlib
import sqlite3
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from chemistry_agent.api import create_app
from chemistry_agent.auth import (
    COOKIE_NAME,
    LOGIN_LIMIT,
    create_user_account,
    hash_password,
    verify_password,
)
from chemistry_agent.schemas import TokenUsage
from chemistry_agent.store import Store
from chemistry_agent.users import manage_account

PASSWORD = "correct horse battery staple"


def provider(request):
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "这是当前用户的回答。",
                    },
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        },
    )


def auth_settings(factory, **overrides):
    return factory(**({"auth_enabled": True, "cookie_secure": False} | overrides))


async def test_accounts_cannot_read_or_write_each_others_conversations(settings_factory):
    settings = auth_settings(settings_factory)
    await create_user_account(settings, "alice", PASSWORD)
    await create_user_account(settings, "bob", PASSWORD)
    app = create_app(settings, transport=httpx.MockTransport(provider))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as alice,
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as bob,
    ):
        assert (await alice.get("/sessions")).status_code == 401
        assert (
            await alice.post("/auth/login", json={"username": "Alice", "password": PASSWORD})
        ).status_code == 200
        assert (
            await bob.post("/auth/login", json={"username": "bob", "password": PASSWORD})
        ).status_code == 200
        answer = await alice.post("/chat", json={"message": "Alice 的私有问题"})
        assert answer.status_code == 200, answer.text
        data = answer.json()
        session_id, run_id = data["session_id"], data["run_id"]
        assert len((await alice.get("/sessions")).json()) == 1
        assert (await bob.get("/sessions")).json() == []
        for path in (f"/sessions/{session_id}", f"/sessions/{session_id}/runs", f"/runs/{run_id}"):
            assert (await bob.get(path)).status_code == 404
            assert (await alice.get(path)).status_code == 200
        assert (
            await bob.post("/chat", json={"session_id": session_id, "message": "越权写入"})
        ).status_code == 404
        assert len((await alice.get(f"/sessions/{session_id}")).json()["messages"]) == 2
        bob_data = (await bob.post("/chat", json={"message": "Bob 的私有问题"})).json()
        assert (await alice.get("/sessions/" + bob_data["session_id"])).status_code == 404
        # Ownership is resolved server-side; a supplied owner_id is never accepted.
        assert (
            await bob.post(
                "/sessions",
                json={"owner_id": (await alice.get("/auth/status")).json()["user"]["id"]},
            )
        ).status_code == 422
        assert (await alice.post("/auth/logout")).status_code == 204
        assert (await alice.get("/sessions")).status_code == 401
        assert (await bob.get("/sessions")).status_code == 200


async def test_cookie_properties_revocation_and_tokens_are_hashed(settings_factory):
    settings = auth_settings(settings_factory, cookie_secure=True)
    await create_user_account(settings, "alice", PASSWORD)
    with TestClient(
        create_app(settings, transport=httpx.MockTransport(provider)), base_url="https://testserver"
    ) as client:
        response = client.post("/auth/login", json={"username": "alice", "password": PASSWORD})
        assert response.status_code == 200
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
        token = client.cookies.get(COOKIE_NAME)
        assert client.get("/sessions").status_code == 200
        with sqlite3.connect(settings.database_path) as db:
            row = db.execute("SELECT token_hash FROM auth_sessions").fetchone()
            assert row[0] != token
            assert row[0] == hashlib.sha256(token.encode()).hexdigest()
            password_hash = db.execute("SELECT password_hash FROM users").fetchone()[0]
            assert PASSWORD not in password_hash and password_hash.startswith("scrypt$")
        assert client.post("/auth/logout").status_code == 204
        assert client.get("/sessions").status_code == 401
        assert (
            client.get("/sessions", headers={"Cookie": f"{COOKIE_NAME}={token}"}).status_code == 401
        )


async def test_public_endpoints_remain_available_and_private_endpoints_require_login(
    settings_factory,
):
    settings = auth_settings(settings_factory)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        for path in ("/", "/assets/styles.css", "/assets/app.mjs", "/health", "/auth/status"):
            assert client.get(path).status_code == 200
        assert client.get("/auth/status").json() == {"enabled": True, "user": None}
        for path in ("/sessions", "/tools", "/docs", "/openapi.json"):
            response = client.get(path)
            assert response.status_code == 401
            assert response.json()["error"]["code"] == "authentication_required"
        assert (
            client.post(
                "/tools/molecular_properties/invoke",
                json={
                    "arguments": {"smiles": "CCO"},
                },
            ).status_code
            == 401
        )
        assert client.post("/chat", json={"message": "should not call model"}).status_code == 401


async def test_cross_origin_writes_are_rejected(settings_factory):
    settings = auth_settings(settings_factory)
    await create_user_account(settings, "alice", PASSWORD)
    with TestClient(
        create_app(settings, transport=httpx.MockTransport(provider)), base_url="https://testserver"
    ) as client:
        assert (
            client.post(
                "/auth/login",
                json={"username": "alice", "password": PASSWORD},
                headers={"Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/auth/login",
                json={"username": "alice", "password": PASSWORD},
                headers={"Origin": "https://testserver"},
            ).status_code
            == 200
        )
        for origin in ("null", "https://evil.example", "http://testserver"):
            response = client.post(
                "/sessions", json={"title": "cross origin"}, headers={"Origin": origin}
            )
            assert response.status_code == 403
        assert client.get("/sessions").json() == []
        assert (
            client.post("/sessions", json={}, headers={"Origin": "https://testserver"}).status_code
            == 201
        )


async def test_bad_logins_are_generic_and_rate_limited(settings_factory):
    settings = auth_settings(settings_factory)
    await create_user_account(settings, "alice", PASSWORD)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        known = client.post("/auth/login", json={"username": "alice", "password": "bad-password"})
        unknown = client.post(
            "/auth/login", json={"username": "nobody", "password": "bad-password"}
        )
        assert known.json() == unknown.json()
        for _ in range(LOGIN_LIMIT - 2):
            assert (
                client.post(
                    "/auth/login", json={"username": "alice", "password": "wrong"}
                ).status_code
                == 401
            )
        assert (
            client.post("/auth/login", json={"username": "alice", "password": PASSWORD}).status_code
            == 429
        )
        assert client.get("/auth/status").json()["user"] is None


async def test_expired_disabled_and_reset_sessions_are_invalidated(settings_factory):
    settings = auth_settings(settings_factory)
    await create_user_account(settings, "alice", PASSWORD)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        assert (
            client.post("/auth/login", json={"username": "alice", "password": PASSWORD}).status_code
            == 200
        )
        await manage_account(settings, "disable", "alice")
        assert client.get("/sessions").status_code == 401
        assert (
            client.post("/auth/login", json={"username": "alice", "password": PASSWORD}).status_code
            == 401
        )
        await manage_account(settings, "enable", "alice")
        assert (
            client.post("/auth/login", json={"username": "alice", "password": PASSWORD}).status_code
            == 200
        )
        await manage_account(
            settings, "reset-password", "alice", "a new sufficiently long password"
        )
        assert client.get("/sessions").status_code == 401
        assert (
            client.post("/auth/login", json={"username": "alice", "password": PASSWORD}).status_code
            == 401
        )
        assert (
            client.post(
                "/auth/login",
                json={"username": "alice", "password": "a new sufficiently long password"},
            ).status_code
            == 200
        )
        with sqlite3.connect(settings.database_path) as db:
            db.execute("UPDATE auth_sessions SET expires_at=?", (time.time() - 1,))
        assert client.get("/sessions").status_code == 401


async def test_legacy_history_is_private_until_explicitly_claimed(settings_factory):
    settings = auth_settings(settings_factory)
    store = await Store.open(settings.database_path)
    session = await store.create_session("old local conversation")
    run_id, _ = await store.begin_run(session["id"])
    messages = [
        {"role": "user", "content": "original local data"},
        {"role": "assistant", "content": "original answer"},
    ]
    await store.complete_run(session["id"], run_id, messages, "original answer", [], TokenUsage())
    await store.close()
    await create_user_account(settings, "alice", PASSWORD)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        client.post("/auth/login", json={"username": "alice", "password": PASSWORD})
        assert client.get("/sessions").json() == []
        assert client.get("/sessions/" + session["id"]).status_code == 404
        claimed = await manage_account(settings, "claim-legacy", "alice")
        assert claimed["claimed_sessions"] == 1
        assert client.get("/sessions/" + session["id"]).json()["messages"] == messages
        assert client.get("/runs/" + run_id).status_code == 200
    # Disabling authentication must not expose sessions that now belong to an account.
    with TestClient(
        create_app(
            settings_factory(database_path=settings.database_path),
            transport=httpx.MockTransport(provider),
        )
    ) as client:
        assert client.get("/sessions").json() == []


async def test_account_validation_and_password_whitespace(settings_factory):
    settings = auth_settings(settings_factory)
    password = "  password whitespace stays  "
    await create_user_account(settings, "Alice", password)
    with pytest.raises(ValueError):
        await create_user_account(settings, "alice", PASSWORD)
    with pytest.raises(ValueError):
        await create_user_account(settings, "bad user", PASSWORD)
    with pytest.raises(ValueError):
        await create_user_account(settings, "other", "too short")
    assert not verify_password(PASSWORD, "malformed hash")
    assert hash_password(PASSWORD) != hash_password(PASSWORD)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        assert (
            client.post("/auth/login", json={"username": "alice", "password": password}).status_code
            == 200
        )
        assert client.get("/sessions").headers["cache-control"] == "no-store"
