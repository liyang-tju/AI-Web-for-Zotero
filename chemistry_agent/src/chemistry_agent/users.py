"""Administrator-only local CLI. Passwords are requested without echo, never as arguments."""

import argparse
import asyncio
import getpass

import aiosqlite

from chemistry_agent.auth import (
    create_user_account,
    hash_password,
    init_auth_schema,
    normalize_username,
)
from chemistry_agent.config import Settings


async def manage_account(
    settings: Settings, action: str, username: str | None = None, password: str | None = None
):
    if action == "create":
        return await create_user_account(settings, username, password)
    encoded = (
        await asyncio.to_thread(hash_password, password) if action == "reset-password" else None
    )
    async with aiosqlite.connect(settings.database_path, timeout=10) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys=ON")
        await init_auth_schema(db)
        if action == "list":
            async with db.execute("SELECT username,active FROM users ORDER BY username") as cursor:
                return [dict(row) for row in await cursor.fetchall()]
        username = normalize_username(username)
        await db.execute("BEGIN IMMEDIATE")
        try:
            async with db.execute("SELECT id FROM users WHERE username=?", (username,)) as cursor:
                row = await cursor.fetchone()
            if row is None:
                raise ValueError("用户不存在。")
            user_id = row["id"]
            if action == "reset-password":
                await db.execute("UPDATE users SET password_hash=? WHERE id=?", (encoded, user_id))
            elif action in {"disable", "enable"}:
                await db.execute(
                    "UPDATE users SET active=? WHERE id=?", (int(action == "enable"), user_id)
                )
            elif action == "claim-legacy":
                async with db.execute("PRAGMA table_info(sessions)") as cursor:
                    columns = {item["name"] for item in await cursor.fetchall()}
                if "owner_id" not in columns:
                    raise ValueError("请先启动新版服务完成数据库升级，再认领历史记录。")
                cursor = await db.execute(
                    "UPDATE sessions SET owner_id=? WHERE owner_id IS NULL", (user_id,)
                )
                count = cursor.rowcount
                await cursor.close()
                await db.commit()
                return {"username": username, "claimed_sessions": count}
            else:
                raise ValueError("未知管理操作。")
            await db.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))
            await db.execute("DELETE FROM auth_failures WHERE scope=?", ("account:" + username,))
            await db.commit()
        except BaseException:
            await db.rollback()
            raise
    return {"username": username, "action": action}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("create", "reset-password", "disable", "enable", "claim-legacy"):
        command = commands.add_parser(action)
        command.add_argument("username")
    commands.add_parser("list")
    args = parser.parse_args()
    password = None
    if args.action in {"create", "reset-password"}:
        password = getpass.getpass("Password (12-256 characters, hidden): ")
        if password != getpass.getpass("Confirm password (hidden): "):
            raise SystemExit("Passwords do not match.")
    try:
        result = asyncio.run(
            manage_account(Settings(), args.action, getattr(args, "username", None), password)
        )
    except (ValueError, aiosqlite.Error) as exc:
        # Expected admin errors do not include supplied passwords or database connection details.
        raise SystemExit(str(exc)) from None
    print(result)


if __name__ == "__main__":
    main()
