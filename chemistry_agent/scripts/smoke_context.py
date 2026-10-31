"""Opt-in real DeepSeek compression check using a separate synthetic test database."""

import asyncio
import json
from uuid import uuid4

from fastapi.testclient import TestClient

from chemistry_agent.agent import SYSTEM_PROMPT
from chemistry_agent.api import create_app
from chemistry_agent.config import PROJECT_ROOT, Settings
from chemistry_agent.schemas import TokenUsage
from chemistry_agent.store import Store
from chemistry_agent.tokens import TokenCounter
from chemistry_agent.tools import ToolRegistry


async def seed(settings: Settings):
    counter = TokenCounter(settings.tokenizer_path)
    originals = [
        {"role": "user", "content": "请记住：样品编号 CHEM42，分子 SMILES=CCO，温度 298 K。"},
        {"role": "assistant", "content": "已记录样品信息，后续回答须保留准确的编号和单位。"},
        {"role": "user", "content": "以下仅为上下文压缩测试的重复背景，没有新增实验数据。"},
        {"role": "assistant", "content": "明白，重复背景不作为额外证据。"},
        {"role": "user", "content": "后续问题请简短回答，并注明温度单位。"},
        {"role": "assistant", "content": "好的。"},
    ]
    target = int(settings.context_input_budget * settings.context_trigger_ratio) + 1000
    tools = ToolRegistry().schemas()
    while (
        counter.request_tokens([{"role": "system", "content": SYSTEM_PROMPT}, *originals], tools)
        < target
    ):
        originals[0]["content"] += " 这段重复文字用于验证上下文压缩，不包含新的事实或指令。" * 30
    store = await Store.open(settings.database_path)
    try:
        session = await store.create_session("上下文压缩真实联调")
        for index in range(0, len(originals), 2):
            run_id, _ = await store.begin_run(session["id"])
            await store.complete_run(
                session["id"],
                run_id,
                originals[index : index + 2],
                originals[index + 1]["content"],
                [],
                TokenUsage(),
            )
    finally:
        await store.close()
    return session["id"], originals


def main():
    database = PROJECT_ROOT / "data" / f"context-smoke-{uuid4().hex}.sqlite3"
    settings = Settings(
        database_path=database,
        context_window_tokens=8192,
        deepseek_max_tokens=512,
        context_summary_tokens=512,
        context_recent_turns=1,
        context_trigger_ratio=0.7,
        deepseek_thinking=False,
    )
    if not settings.model_configured:
        raise SystemExit("Configure DEEPSEEK_API_KEY before running this billable live check.")
    session_id, originals = asyncio.run(seed(settings))
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/chat",
            json={
                "session_id": session_id,
                "message": "之前约定的样品编号、SMILES 和温度是什么？请简短回答。",
            },
        )
        if response.status_code != 200:
            code = response.json().get("error", {}).get("code", "request_failed")
            raise SystemExit(f"Live compression check failed: HTTP {response.status_code} / {code}")
        first = response.json()
        assert first["context"]["summary_used"] and first["context"]["summary_calls"] > 0
        assert first["context"]["input_tokens_after"] < first["context"]["input_tokens_before"]
        assert all(value in first["answer"] for value in ("CHEM42", "CCO", "298"))
        history = client.get("/sessions/" + session_id).json()["messages"]
        assert history[: len(originals)] == originals
        assert client.get("/runs/" + first["run_id"]).json()["context"] == first["context"]
        print(
            json.dumps(
                {
                    "check": "live_compression",
                    "answer": first["answer"],
                    "context": first["context"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    # Reopen the app to verify that the saved summary, rather than in-process state, is reused.
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/chat",
            json={
                "session_id": session_id,
                "message": "继续沿用同一样品，只重复其编号即可。",
            },
        )
        if response.status_code != 200:
            raise SystemExit(f"Summary reuse check failed: HTTP {response.status_code}")
        second = response.json()
        assert second["context"]["summary_used"] and second["context"]["summary_calls"] == 0
        assert "CHEM42" in second["answer"]
        history = client.get("/sessions/" + session_id).json()["messages"]
        assert history[: len(originals)] == originals
    report = {
        "status": "passed",
        "model": settings.deepseek_model,
        "session_id": session_id,
        "database": str(database.relative_to(PROJECT_ROOT)),
        "compression": first["context"],
        "reuse": second["context"],
        "first_answer": first["answer"],
        "second_answer": second["answer"],
        "usage": [first["usage"], second["usage"]],
        "original_messages_preserved": True,
    }
    path = PROJECT_ROOT / "data" / "context-live-result.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        "Live compression and persisted-summary reuse passed; original records are intact.",
        flush=True,
    )


if __name__ == "__main__":
    main()
