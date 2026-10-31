import copy
import json
import sqlite3
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from tokenizers import Tokenizer, models, pre_tokenizers

from chemistry_agent.agent import SYSTEM_PROMPT
from chemistry_agent.api import create_app
from chemistry_agent.context import SUMMARY_SYSTEM_PROMPT, ContextManager
from chemistry_agent.provider import DeepSeekClient
from chemistry_agent.schemas import ContextMemory, TokenUsage
from chemistry_agent.store import Store
from chemistry_agent.tokens import TokenCounter
from chemistry_agent.tools import ToolRegistry

MEMORY = "历史事实：样品为乙醇，SMILES 为 CCO，温度 298 K；结果需注明来源与单位。"


def reply(content="结果已核实。", calls=None, reasoning=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = calls
    if reasoning:
        message["reasoning_content"] = reasoning
    return {
        "choices": [{"message": message, "finish_reason": "tool_calls" if calls else "stop"}],
        "usage": {"prompt_tokens": 30, "completion_tokens": 5, "total_tokens": 35},
    }


def budget_settings(factory, **overrides):
    return factory(
        **(
            {
                "context_window_tokens": 8192,
                "deepseek_max_tokens": 256,
                "context_summary_tokens": 256,
                "context_recent_turns": 1,
                "context_trigger_ratio": 0.7,
            }
            | overrides
        )
    )


async def seed(settings, turns=6, padding=100):
    store = await Store.open(settings.database_path)
    originals = []
    try:
        session = await store.create_session("压缩测试")
        for index in range(turns):
            user = {
                "role": "user",
                "content": (
                    f"ORIGINAL-{index}: 样品乙醇 SMILES=CCO，温度 298 K。 " + "history " * padding
                ),
            }
            assistant = {"role": "assistant", "content": "数据来源待核实。 " + "answer " * padding}
            if index == 0:
                assistant["reasoning_content"] = "PRIVATE-REASONING-DO-NOT-SUMMARIZE"
            run_id, _ = await store.begin_run(session["id"])
            await store.complete_run(
                session["id"], run_id, [user, assistant], assistant["content"], [], TokenUsage()
            )
            originals.extend([user, assistant])
    finally:
        await store.close()
    return session["id"], originals


def without_reasoning(messages):
    return [
        {key: value for key, value in item.items() if key != "reasoning_content"}
        for item in messages
    ]


async def test_summary_budget_recent_turns_persistence_and_cache_reuse(settings_factory):
    settings = budget_settings(settings_factory)
    session_id, originals = await seed(settings)
    summaries, answers = [], []
    counter = TokenCounter(settings.tokenizer_path)

    def provider(request):
        payload = json.loads(request.content)
        if payload["messages"][0]["content"] == SUMMARY_SYSTEM_PROMPT:
            summaries.append(payload)
            assert payload["thinking"] == {"type": "disabled"}
            assert "tools" not in payload
            assert payload["max_tokens"] == 256
            assert "PRIVATE-REASONING" not in json.dumps(payload)
            assert counter.request_tokens(payload["messages"], []) <= 8192 - 256
            return httpx.Response(200, json=reply(MEMORY))
        answers.append(payload)
        assert counter.request_tokens(payload["messages"], payload["tools"]) <= 8192 - 256
        wire = payload["messages"]
        assert wire[0]["content"] == SYSTEM_PROMPT
        assert "<conversation_memory>" in wire[1]["content"]
        assert "CCO" in wire[1]["content"]
        assert "ORIGINAL-0" not in json.dumps(wire)
        assert originals[-2]["content"] in [item.get("content") for item in wire]
        assert originals[-1]["content"] in [item.get("content") for item in wire]
        return httpx.Response(200, json=reply())

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"session_id": session_id, "message": "请回忆样品。"})
        assert response.status_code == 200, response.text
        data = response.json()
        context = data["context"]
        assert context["compressed"] and context["summary_used"]
        assert context["summarized_messages"] == 10
        assert context["retained_turns"] == 1
        assert context["input_tokens_after"] < context["input_tokens_before"]
        assert context["input_tokens_after"] <= context["input_budget_tokens"]
        assert context["tokenizer"] == "utf8-bytes-conservative"
        assert context["summary_calls"] == len(summaries) >= 1
        assert data["usage"]["total_tokens"] == 35 * (len(summaries) + 1)
        run = client.get("/runs/" + data["run_id"]).json()
        assert run["context"] == context
        history = client.get("/sessions/" + session_id).json()["messages"]
        assert history[: len(originals)] == without_reasoning(originals)
        assert len(history) == len(originals) + 2
    count = len(summaries)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"session_id": session_id, "message": "继续。"})
        assert response.status_code == 200, response.text
        assert response.json()["context"]["summary_calls"] == 0
        assert response.json()["context"]["summary_used"]
        assert len(summaries) == count
        assert len(answers) == 2


async def test_very_long_old_history_is_chunked_instead_of_rejected(settings_factory):
    settings = budget_settings(settings_factory)
    session_id, originals = await seed(settings, turns=6, padding=1400)
    # Retain >120k characters without imposing the old serialized-character rejection.
    settings = budget_settings(
        settings_factory, context_recent_turns=1, context_window_tokens=65536
    )
    summaries = []

    def provider(request):
        payload = json.loads(request.content)
        if payload["messages"][0]["content"] == SUMMARY_SYSTEM_PROMPT:
            summaries.append(payload)
            return httpx.Response(200, json=reply(MEMORY))
        return httpx.Response(200, json=reply())

    assert len(json.dumps(originals, ensure_ascii=False)) > 120000
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"session_id": session_id, "message": "继续分析"})
        assert response.status_code == 200, response.text
        assert len(summaries) > 1
        assert response.json()["context"]["input_tokens_after"] <= settings.context_input_budget
        assert client.get("/sessions/" + session_id).json()["messages"][: len(originals)] == (
            without_reasoning(originals)
        )


@pytest.mark.parametrize("failure", ["upstream", "oversized", "unexpected_tools"])
async def test_failed_summary_keeps_originals_and_does_not_advance_memory(
    settings_factory, failure
):
    settings = budget_settings(settings_factory)
    session_id, originals = await seed(settings)

    def provider(request):
        payload = json.loads(request.content)
        assert payload["messages"][0]["content"] == SUMMARY_SYSTEM_PROMPT
        if failure == "upstream":
            return httpx.Response(500, json={"error": "do not expose upstream text"})
        if failure == "oversized":
            return httpx.Response(200, json=reply("X" * 1000))
        return httpx.Response(
            200,
            json=reply(
                None,
                calls=[
                    {
                        "id": "bad-summary-call",
                        "type": "function",
                        "function": {
                            "name": "molecular_properties",
                            "arguments": '{"smiles":"CCO"}',
                        },
                    }
                ],
            ),
        )

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"session_id": session_id, "message": "继续"})
        assert response.status_code == 502
        error = response.json()["error"]
        assert error["code"] == "context_summary_failed"
        assert "upstream text" not in response.text
        assert client.get("/sessions/" + session_id).json()["messages"] == without_reasoning(
            originals
        )
        run = client.get("/runs/" + error["run_id"]).json()
        assert run["status"] == "failed"
        assert run["usage"]["total_tokens"] == (0 if failure == "upstream" else 35)
    store = await Store.open(settings.database_path)
    try:
        assert (await store.get_context_memory(session_id)).covered_messages == 0
        run_id, _ = await store.begin_run(session_id)  # failed task released its reservation
        assert run_id
    finally:
        await store.close()


async def test_summary_survives_a_later_model_failure_and_is_reused(settings_factory):
    settings = budget_settings(settings_factory)
    session_id, originals = await seed(settings)
    summary_calls, main_calls = 0, 0

    def provider(request):
        nonlocal summary_calls, main_calls
        payload = json.loads(request.content)
        if payload["messages"][0]["content"] == SUMMARY_SYSTEM_PROMPT:
            summary_calls += 1
            return httpx.Response(200, json=reply(MEMORY))
        main_calls += 1
        return httpx.Response(500) if main_calls == 1 else httpx.Response(200, json=reply())

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        failed = client.post("/chat", json={"session_id": session_id, "message": "分析"})
        assert failed.status_code == 502
        count = summary_calls
        run = client.get("/runs/" + failed.json()["error"]["run_id"]).json()
        assert run["context"]["summary_calls"] == count
        assert run["usage"]["total_tokens"] == count * 35
        assert client.get("/sessions/" + session_id).json()["messages"] == without_reasoning(
            originals
        )
        success = client.post("/chat", json={"session_id": session_id, "message": "重试"})
        assert success.status_code == 200, success.text
        assert summary_calls == count
        assert success.json()["context"]["summary_calls"] == 0


def test_oversized_current_input_is_rejected_before_any_paid_call(settings_factory):
    settings = budget_settings(settings_factory)

    def unused(request):
        pytest.fail(
            "No summarization or model call is useful if the protected current input cannot fit"
        )

    with TestClient(create_app(settings, transport=httpx.MockTransport(unused))) as client:
        response = client.post("/chat", json={"message": "X" * 12000})
        assert response.status_code == 422
        error = response.json()["error"]
        assert error["code"] == "context_budget_exceeded"
        assert client.get("/sessions/" + error["session_id"]).json()["messages"] == []
        run = client.get("/runs/" + error["run_id"]).json()
        assert run["context"]["summary_calls"] == 0
        assert run["usage"]["total_tokens"] == 0


def test_large_active_tool_result_is_compacted_without_losing_raw_data_or_protocol(
    settings_factory,
    monkeypatch,
):
    original_result = {
        "canonical_smiles": "CCO",
        "formula": "C2H6O",
        "molecular_weight_g_mol": 46.069,
        "large_data": "X" * 140000,
    }
    monkeypatch.setattr("chemistry_agent.tools.molecular_properties", lambda args: original_result)
    settings = budget_settings(settings_factory, deepseek_thinking=True)
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        payload = json.loads(request.content)
        assert payload["messages"][0]["content"] != SUMMARY_SYSTEM_PROMPT
        if count == 1:
            return httpx.Response(
                200,
                json=reply(
                    None,
                    reasoning="keep-this-reasoning",
                    calls=[
                        {
                            "id": "pair-1",
                            "type": "function",
                            "function": {
                                "name": "molecular_properties",
                                "arguments": '{"smiles":"CCO"}',
                            },
                        }
                    ],
                ),
            )
        call_message, result_message = payload["messages"][-2:]
        assert call_message["reasoning_content"] == "keep-this-reasoning"
        assert call_message["tool_calls"][0]["id"] == result_message["tool_call_id"] == "pair-1"
        reduced = json.loads(result_message["content"])
        assert reduced["_context_compacted"]
        assert reduced["data"]["formula"] == "C2H6O"
        assert reduced["data"]["molecular_weight_g_mol"] == 46.069
        assert len(result_message["content"]) <= 512
        return httpx.Response(
            200, json=reply("乙醇的分子式为 C2H6O。", reasoning="final-reasoning")
        )

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"message": "计算 CCO"})
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["context"]["compacted_tool_results"] == 1
        assert data["context"]["compressed"]
        assert not data["context"]["summary_used"]
        assert data["tool_calls"][0]["result"] == original_result
        history = client.get("/sessions/" + data["session_id"]).json()["messages"]
        assert json.loads(history[2]["content"]) == original_result
        assert (
            client.get("/runs/" + data["run_id"]).json()["tool_calls"][0]["result"]
            == original_result
        )


def test_token_counter_handles_local_tokenizer_fallback_and_unicode(tmp_path):
    absent = TokenCounter(tmp_path / "missing.json")
    assert absent.text_tokens("化学") == 6
    assert absent.prefix("化学研究", 7) == "化学"
    assert absent.prefix("化学", 0) == ""
    broken = tmp_path / "broken.json"
    broken.write_text("not json", encoding="utf-8")
    assert TokenCounter(broken).method == "utf8-bytes-conservative"
    tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0, "hello": 1, "world": 2}, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    path = tmp_path / "tokenizer.json"
    tokenizer.save(str(path))
    counter = TokenCounter(path)
    assert counter.text_tokens("hello world") == 2
    assert counter.method == "deepseek-tokenizer+15%-margin"
    assert counter.text_tokens(counter.prefix("hello world hello world", 2)) <= 2


async def test_default_four_recent_turns_are_retained_whole(settings_factory):
    settings = budget_settings(settings_factory, context_recent_turns=4)
    session_id, originals = await seed(settings, turns=8, padding=60)

    def provider(request):
        payload = json.loads(request.content)
        if payload["messages"][0]["content"] == SUMMARY_SYSTEM_PROMPT:
            return httpx.Response(200, json=reply(MEMORY))
        assert payload["messages"][-9:-1] == originals[-8:]
        return httpx.Response(200, json=reply())

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"session_id": session_id, "message": "继续"})
        assert response.status_code == 200, response.text
        assert response.json()["context"]["summary_used"]
        assert response.json()["context"]["summarized_messages"] == 8
        assert response.json()["context"]["retained_turns"] == 4


async def test_later_summary_updates_only_the_uncovered_prefix(settings_factory):
    settings = budget_settings(settings_factory)
    session_id, _ = await seed(settings)
    phase, summary_inputs = 1, []

    def provider(request):
        payload = json.loads(request.content)
        if payload["messages"][0]["content"] == SUMMARY_SYSTEM_PROMPT:
            summary_inputs.append((phase, json.loads(payload["messages"][1]["content"])))
            return httpx.Response(200, json=reply(MEMORY))
        return httpx.Response(200, json=reply("NEW-ANSWER " * 90))

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        first = client.post("/chat", json={"session_id": session_id, "message": "继续"})
        assert first.status_code == 200, first.text
        initial_coverage = first.json()["context"]["summarized_messages"]
        phase = 2
        for _ in range(5):
            response = client.post(
                "/chat",
                json={
                    "session_id": session_id,
                    "message": "新增资料 " + "new-fact " * 70,
                },
            )
            assert response.status_code == 200, response.text
            if response.json()["context"]["summarized_messages"] > initial_coverage:
                break
        assert response.json()["context"]["summarized_messages"] > initial_coverage
    later = [item for current_phase, item in summary_inputs if current_phase == 2]
    assert later
    assert later[0]["previous_memory"] == MEMORY
    assert all("ORIGINAL-0" not in item["new_transcript"] for item in later)


def test_budget_is_rechecked_after_large_thinking_output(settings_factory):
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        assert count == 1, "An oversized active task must not be sent back to the provider"
        return httpx.Response(
            200,
            json=reply(
                None,
                reasoning="X" * 15000,
                calls=[
                    {
                        "id": "pair",
                        "type": "function",
                        "function": {
                            "name": "molecular_properties",
                            "arguments": '{"smiles":"CCO"}',
                        },
                    }
                ],
            ),
        )

    settings = budget_settings(settings_factory, deepseek_thinking=True)
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"message": "计算 CCO"})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "context_budget_exceeded"
        run = client.get("/runs/" + response.json()["error"]["run_id"]).json()
        assert run["usage"]["total_tokens"] == 35
        assert run["tool_calls"][0]["result"]["formula"] == "C2H6O"


async def test_tool_compaction_does_not_mutate_source_and_remains_valid_json(settings_factory):
    settings = budget_settings(settings_factory, context_tool_result_tokens=128)
    counter = TokenCounter(settings.tokenizer_path)
    store = await Store.open(settings.database_path)
    provider = DeepSeekClient(
        settings, transport=httpx.MockTransport(lambda request: httpx.Response(500))
    )
    manager = ContextManager(
        settings, provider, store, counter, SYSTEM_PROMPT, ToolRegistry().schemas()
    )
    try:
        content = json.dumps({"items": [{"long": "X" * 1000}] * 100, "formula": "C2H6O"})
        original = {"role": "tool", "tool_call_id": "pair", "content": content}
        before = copy.deepcopy(original)
        wire, compacted = manager._wire([], [original], ContextMemory())
        assert compacted == 1
        assert counter.text_tokens(wire[-1]["content"]) <= 128
        assert json.loads(wire[-1]["content"])["_context_compacted"]
        assert wire[-1]["tool_call_id"] == "pair"
        assert original == before
    finally:
        await provider.close()
        await store.close()


@pytest.mark.parametrize(
    "values",
    [
        {"context_window_tokens": 4096, "deepseek_max_tokens": 4096},
        {"context_trigger_ratio": 1},
        {"context_recent_turns": 0},
    ],
)
def test_invalid_context_configuration_is_rejected(settings_factory, values):
    with pytest.raises(ValueError):
        settings_factory(**values)


def test_old_database_migrates_without_changing_saved_messages(settings_factory):
    settings = settings_factory()
    session_id, run_id = str(uuid4()), str(uuid4())
    raw = '{"role":"user","content":"original remains"}'
    with sqlite3.connect(settings.database_path) as db:
        db.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,created_at TEXT,updated_at TEXT,
                                  active_run_id TEXT);
            CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                                  session_id TEXT,payload TEXT);
            CREATE TABLE runs(id TEXT PRIMARY KEY,session_id TEXT,status TEXT,started_at TEXT,
                              finished_at TEXT,answer TEXT,error_code TEXT,
                              tool_calls TEXT DEFAULT '[]',usage TEXT DEFAULT '{}');
        """)
        db.execute("INSERT INTO sessions VALUES(?, 'old', 'now', 'now', NULL)", (session_id,))
        db.execute("INSERT INTO messages(session_id,payload) VALUES(?,?)", (session_id, raw))
        db.execute(
            "INSERT INTO runs(id,session_id,status,started_at,finished_at) "
            "VALUES(?,?,'completed','now','now')",
            (run_id, session_id),
        )
    with TestClient(
        create_app(settings, transport=httpx.MockTransport(lambda request: httpx.Response(500)))
    ) as client:
        assert client.get("/runs/" + run_id).json()["context"]["compressed"] is False
        assert (
            client.get("/sessions/" + session_id).json()["messages"][0]["content"]
            == "original remains"
        )
    with sqlite3.connect(settings.database_path) as db:
        assert db.execute("SELECT payload FROM messages").fetchone()[0] == raw
