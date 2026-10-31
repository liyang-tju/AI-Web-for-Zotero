import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import aiosqlite
from filelock import FileLock
from filelock import Timeout as LockTimeout

from chemistry_agent.auth import init_auth_schema
from chemistry_agent.errors import AgentError
from chemistry_agent.schemas import ContextMemory, ContextUsage, TokenUsage, ToolExecution


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class Store:
    """Single-process SQLite storage with atomic per-session run reservations."""

    def __init__(self, db: aiosqlite.Connection, process_lock: FileLock):
        self.db = db
        self.lock = asyncio.Lock()
        self.process_lock = process_lock

    @classmethod
    async def open(cls, path: Path) -> "Store":
        path = await asyncio.to_thread(path.resolve)
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        process_lock = FileLock(str(path) + ".lock")
        try:
            process_lock.acquire(timeout=0)
        except LockTimeout as exc:
            raise RuntimeError("此数据库已有 Chemistry Agent 服务运行，请使用现有服务。") from exc
        try:
            db = await aiosqlite.connect(path)
        except BaseException:
            process_lock.release()
            raise
        db.row_factory = aiosqlite.Row
        try:
            await init_auth_schema(db)
            await db.executescript("""
                PRAGMA foreign_keys = ON;
                PRAGMA journal_mode = WAL;
                PRAGMA busy_timeout = 5000;
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    active_run_id TEXT
                );
                CREATE TABLE IF NOT EXISTS messages (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id),
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id),
                    status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
                    answer TEXT, error_code TEXT,
                    tool_calls TEXT NOT NULL DEFAULT '[]', usage TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS context_memory (
                    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
                    summary TEXT NOT NULL, covered_messages INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );
            """)
            async with db.execute("PRAGMA table_info(sessions)") as cursor:
                session_columns = {row["name"] for row in await cursor.fetchall()}
            if "owner_id" not in session_columns:
                await db.execute(
                    "ALTER TABLE sessions ADD COLUMN owner_id TEXT REFERENCES users(id)"
                )
            await db.execute("CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id)")
            async with db.execute("PRAGMA table_info(runs)") as cursor:
                columns = {row["name"] for row in await cursor.fetchall()}
            if "context_info" not in columns:
                await db.execute(
                    "ALTER TABLE runs ADD COLUMN context_info TEXT NOT NULL DEFAULT '{}'"
                )
            # This service runs one worker. A previous worker's active jobs cannot be resumed.
            await db.execute(
                "UPDATE runs SET status='interrupted', error_code='service_restarted', "
                "finished_at=? WHERE status='running'",
                (utc_now(),),
            )
            await db.execute("UPDATE sessions SET active_run_id=NULL")
            await db.commit()
        except BaseException:
            await db.close()
            process_lock.release()
            raise
        return cls(db, process_lock)

    async def close(self) -> None:
        try:
            await self.db.close()
        finally:
            self.process_lock.release()

    @asynccontextmanager
    async def transaction(self):
        async with self.lock:
            await self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                await self.db.commit()
            except BaseException:
                await self.db.rollback()
                raise

    async def _one(self, sql: str, parameters: tuple = ()) -> aiosqlite.Row | None:
        async with self.db.execute(sql, parameters) as cursor:
            return await cursor.fetchone()

    async def _history(self, session_id: str) -> list[dict[str, Any]]:
        async with self.db.execute(
            "SELECT payload FROM messages WHERE session_id=? ORDER BY seq", (session_id,)
        ) as cursor:
            return [json.loads(row["payload"]) for row in await cursor.fetchall()]

    async def create_session(self, title: str, owner_id: str | None = None) -> dict[str, Any]:
        session_id, now = str(uuid4()), utc_now()
        async with self.transaction():
            await self.db.execute(
                "INSERT INTO sessions(id, title, created_at, updated_at, owner_id) "
                "VALUES (?,?,?,?,?)",
                (session_id, title, now, now, owner_id),
            )
        return {"id": session_id, "title": title, "created_at": now, "updated_at": now}

    async def list_sessions(
        self, limit: int, offset: int, owner_id: str | None = None
    ) -> list[dict[str, Any]]:
        async with (
            self.lock,
            self.db.execute(
                "SELECT id, title, created_at, updated_at FROM sessions "
                "WHERE owner_id IS ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?",
                (owner_id, limit, offset),
            ) as cursor,
        ):
            return [dict(row) for row in await cursor.fetchall()]

    async def get_session(self, session_id: str, owner_id: str | None = None) -> dict[str, Any]:
        async with self.lock:
            row = await self._one(
                "SELECT id, title, created_at, updated_at FROM sessions "
                "WHERE id=? AND owner_id IS ?",
                (session_id, owner_id),
            )
            if row is None:
                raise AgentError("session_not_found", "会话不存在。", 404)
            history = await self._history(session_id)
        # Internal model reasoning is persisted only for the provider continuation protocol.
        messages = [
            {k: v for k, v in message.items() if k != "reasoning_content"} for message in history
        ]
        return {**dict(row), "messages": messages}

    async def begin_run(
        self, session_id: str, owner_id: str | None = None
    ) -> tuple[str, list[dict[str, Any]]]:
        run_id = str(uuid4())
        async with self.transaction():
            row = await self._one(
                "SELECT active_run_id FROM sessions WHERE id=? AND owner_id IS ?",
                (session_id, owner_id),
            )
            if row is None:
                raise AgentError("session_not_found", "会话不存在。", 404)
            if row["active_run_id"] is not None:
                raise AgentError("session_busy", "此会话已有运行中的任务，请稍后重试。", 409)
            await self.db.execute(
                "INSERT INTO runs(id, session_id, status, started_at) VALUES (?, ?, 'running', ?)",
                (run_id, session_id, utc_now()),
            )
            await self.db.execute(
                "UPDATE sessions SET active_run_id=? WHERE id=?", (run_id, session_id)
            )
            history = await self._history(session_id)
        return run_id, history

    async def complete_run(
        self,
        session_id: str,
        run_id: str,
        messages: list[dict[str, Any]],
        answer: str,
        tool_calls: list[ToolExecution],
        usage: TokenUsage,
        context: ContextUsage | None = None,
    ) -> None:
        now = utc_now()
        async with self.transaction():
            await self.db.executemany(
                "INSERT INTO messages(session_id, payload) VALUES (?, ?)",
                [(session_id, json.dumps(message, ensure_ascii=False)) for message in messages],
            )
            await self.db.execute(
                "UPDATE runs SET status='completed', finished_at=?, answer=?, tool_calls=?, "
                "usage=?, context_info=? WHERE id=?",
                (
                    now,
                    answer,
                    json.dumps([call.model_dump() for call in tool_calls], ensure_ascii=False),
                    usage.model_dump_json(),
                    (context or ContextUsage()).model_dump_json(),
                    run_id,
                ),
            )
            await self.db.execute(
                "UPDATE sessions SET updated_at=?, active_run_id=NULL "
                "WHERE id=? AND active_run_id=?",
                (now, session_id, run_id),
            )

    async def fail_run(
        self,
        session_id: str,
        run_id: str,
        code: str,
        *,
        tool_calls: list[ToolExecution],
        usage: TokenUsage,
        cancelled=False,
        context: ContextUsage | None = None,
    ) -> None:
        async with self.transaction():
            await self.db.execute(
                "UPDATE runs SET status=?, finished_at=?, error_code=?, tool_calls=?, usage=?, "
                "context_info=? WHERE id=?",
                (
                    "cancelled" if cancelled else "failed",
                    utc_now(),
                    code,
                    json.dumps([call.model_dump() for call in tool_calls], ensure_ascii=False),
                    usage.model_dump_json(),
                    (context or ContextUsage()).model_dump_json(),
                    run_id,
                ),
            )
            await self.db.execute(
                "UPDATE sessions SET active_run_id=NULL WHERE id=? AND active_run_id=?",
                (session_id, run_id),
            )

    async def get_run(self, run_id: str, owner_id: str | None = None) -> dict[str, Any]:
        async with self.lock:
            row = await self._one(
                "SELECT runs.* FROM runs JOIN sessions ON sessions.id=runs.session_id "
                "WHERE runs.id=? AND sessions.owner_id IS ?",
                (run_id, owner_id),
            )
        if row is None:
            raise AgentError("run_not_found", "运行记录不存在。", 404)
        return self._run_data(row)

    async def list_runs(
        self, session_id: str, limit: int, offset: int, owner_id: str | None = None
    ) -> list[dict[str, Any]]:
        async with self.lock:
            if (
                await self._one(
                    "SELECT id FROM sessions WHERE id=? AND owner_id IS ?", (session_id, owner_id)
                )
                is None
            ):
                raise AgentError("session_not_found", "会话不存在。", 404)
            async with self.db.execute(
                "SELECT * FROM runs WHERE session_id=? ORDER BY started_at DESC, id "
                "LIMIT ? OFFSET ?",
                (session_id, limit, offset),
            ) as cursor:
                return [self._run_data(row) for row in await cursor.fetchall()]

    @staticmethod
    def _run_data(row: aiosqlite.Row) -> dict[str, Any]:
        result = dict(row)
        result["tool_calls"] = json.loads(result["tool_calls"])
        result["usage"] = json.loads(result["usage"])
        result["context"] = json.loads(result.pop("context_info", "{}"))
        return result

    async def get_context_memory(self, session_id: str) -> ContextMemory:
        async with self.lock:
            row = await self._one(
                "SELECT summary, covered_messages FROM context_memory WHERE session_id=?",
                (session_id,),
            )
        return ContextMemory(**dict(row)) if row else ContextMemory()

    async def save_context_memory(
        self, session_id: str, run_id: str, memory: ContextMemory
    ) -> None:
        async with self.transaction():
            row = await self._one("SELECT active_run_id FROM sessions WHERE id=?", (session_id,))
            if row is None or row["active_run_id"] != run_id:
                raise AgentError("session_reservation_lost", "会话运行状态已改变，请重试。", 409)
            await self.db.execute(
                "INSERT INTO context_memory(session_id, summary, covered_messages, updated_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
                "summary=excluded.summary, covered_messages=excluded.covered_messages, "
                "updated_at=excluded.updated_at",
                (session_id, memory.summary, memory.covered_messages, utc_now()),
            )
