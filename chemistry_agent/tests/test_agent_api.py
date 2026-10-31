import asyncio
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from chemistry_agent.api import create_app


def completion(content="计算完成。", *, calls=None, reasoning=None, finish=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = calls
    if reasoning is not None:
        message["reasoning_content"] = reasoning
    return {
        "choices": [
            {"message": message, "finish_reason": finish or ("tool_calls" if calls else "stop")}
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


def tool_call(name="molecular_properties", arguments=None, call_id="call-1"):
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments if arguments is not None else {"smiles": "CCO"}),
        },
    }


def unused_provider(request):
    pytest.fail("This endpoint must not call the model")


def test_starts_without_key_and_local_tools_work(settings_factory):
    app = create_app(
        settings_factory(deepseek_api_key=""), transport=httpx.MockTransport(unused_provider)
    )
    with TestClient(app) as client:
        assert client.get("/health").json()["model_configured"] is False
        assert client.get("/docs").status_code == 200
        assert client.get("/openapi.json").status_code == 200
        assert len(client.get("/tools").json()) == 2
        result = client.post(
            "/tools/molecular_properties/invoke",
            json={
                "arguments": {"smiles": "CCO"},
            },
        )
        assert result.status_code == 200
        assert result.json()["result"]["formula"] == "C2H6O"
        response = client.post("/chat", json={"message": "你好"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "model_not_configured"
        assert client.get("/sessions").json() == []


def test_two_tools_then_followup_survive_service_restart(settings_factory):
    requests = []

    def provider(request):
        assert str(request.url) == "https://deepseek.test/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-only-key"
        payload = json.loads(request.content)
        requests.append(payload)
        assert payload["thinking"] == {"type": "disabled"}
        if len(requests) == 1:
            return httpx.Response(
                200,
                json=completion(
                    None,
                    calls=[
                        tool_call(),
                        tool_call(
                            "molecular_similarity",
                            {
                                "smiles_a": "CCO",
                                "smiles_b": "CO",
                            },
                            "call-2",
                        ),
                    ],
                ),
            )
        if len(requests) == 2:
            results = payload["messages"][-2:]
            assert [item["tool_call_id"] for item in results] == ["call-1", "call-2"]
            assert json.loads(results[0]["content"])["formula"] == "C2H6O"
            assert 0 < json.loads(results[1]["content"])["tanimoto_similarity"] < 1
            return httpx.Response(200, json=completion("乙醇的分子量约为 46.069 g/mol。"))
        assert payload["messages"][1]["role"] == "user"
        assert len(payload["messages"]) == 7  # system + previous 5 messages + followup
        return httpx.Response(200, json=completion("以上是工具计算值。"))

    settings = settings_factory()
    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        response = client.post("/chat", json={"message": "计算乙醇 CCO 并与 CO 比较"})
        assert response.status_code == 200, response.text
        data = response.json()
        session_id = data["session_id"]
        assert len(data["tool_calls"]) == 2
        assert data["usage"]["total_tokens"] == 30
        run = client.get("/runs/" + data["run_id"]).json()
        assert run["status"] == "completed"
        assert run["tool_calls"] == data["tool_calls"]
        assert run["usage"] == data["usage"]
        assert "test-only-key" not in client.get("/sessions/" + session_id).text

    with TestClient(create_app(settings, transport=httpx.MockTransport(provider))) as client:
        assert len(client.get("/sessions/" + session_id).json()["messages"]) == 5
        response = client.post("/chat", json={"session_id": session_id, "message": "解释数据来源"})
        assert response.status_code == 200, response.text
        assert len(client.get("/sessions/" + session_id).json()["messages"]) == 7
        assert len(client.get("/sessions").json()) == 1


def test_thinking_protocol_preserves_reasoning_but_api_hides_it(settings_factory):
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        payload = json.loads(request.content)
        assert payload["thinking"] == {"type": "enabled"}
        if count == 1:
            return httpx.Response(
                200, json=completion(None, calls=[tool_call()], reasoning="internal-tool-reasoning")
            )
        assert payload["messages"][2]["reasoning_content"] == "internal-tool-reasoning"
        if count == 3:
            assert payload["messages"][4]["reasoning_content"] == "internal-final-reasoning"
        return httpx.Response(
            200, json=completion("这是答案。", reasoning="internal-final-reasoning")
        )

    app = create_app(
        settings_factory(deepseek_thinking=True), transport=httpx.MockTransport(provider)
    )
    with TestClient(app) as client:
        data = client.post("/chat", json={"message": "计算 CCO"}).json()
        session_id = data["session_id"]
        assert "internal-" not in json.dumps(data)
        assert "internal-" not in client.get("/sessions/" + session_id).text
        assert "internal-" not in client.get("/runs/" + data["run_id"]).text
        assert (
            client.post(
                "/chat",
                json={
                    "session_id": session_id,
                    "message": "继续解释",
                },
            ).status_code
            == 200
        )


@pytest.mark.parametrize(
    ("status", "code", "api_status"),
    [
        (401, "provider_authentication_failed", 502),
        (403, "provider_authentication_failed", 502),
        (402, "provider_insufficient_balance", 502),
        (429, "provider_rate_limited", 503),
        (500, "provider_error", 502),
    ],
)
def test_upstream_errors_record_failed_run_without_poisoning_history(
    settings_factory,
    status,
    code,
    api_status,
):
    def provider(request):
        return httpx.Response(status, json={"error": "test-only-key private upstream response"})

    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(provider))
    ) as client:
        response = client.post("/chat", json={"message": "分析 CCO"})
        assert response.status_code == api_status
        assert "test-only-key" not in response.text
        data = response.json()["error"]
        assert data["code"] == code
        assert client.get("/sessions/" + data["session_id"]).json()["messages"] == []
        run = client.get("/runs/" + data["run_id"]).json()
        assert run["status"] == "failed"
        assert run["error_code"] == code


@pytest.mark.parametrize(
    ("exc_type", "status", "code"),
    [
        (httpx.ReadTimeout, 504, "provider_timeout"),
        (httpx.ConnectError, 502, "provider_unreachable"),
    ],
)
def test_transport_errors_are_sanitized(settings_factory, exc_type, status, code):
    def provider(request):
        raise exc_type("test-only-key sensitive detail", request=request)

    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(provider))
    ) as client:
        response = client.post("/chat", json={"message": "你好"})
        assert response.status_code == status
        assert response.json()["error"]["code"] == code
        assert "sensitive" not in response.text


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {"choices": [None]},
        completion(""),
        completion(None, calls=[tool_call(), tool_call()]),
        completion(None, calls=[{"id": "x", "type": "function", "function": {}}]),
    ],
)
def test_malformed_model_responses_fail_cleanly(settings_factory, payload):
    with TestClient(
        create_app(
            settings_factory(),
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)),
        )
    ) as client:
        response = client.post("/chat", json={"message": "你好"})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "provider_invalid_response"


def test_non_json_and_truncation_fail_cleanly(settings_factory):
    replies = [
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json=completion("半截", finish="length")),
    ]
    with TestClient(
        create_app(
            settings_factory(), transport=httpx.MockTransport(lambda request: replies.pop(0))
        )
    ) as client:
        first = client.post("/chat", json={"message": "你好"})
        assert first.json()["error"]["code"] == "provider_invalid_response"
        session_id = first.json()["error"]["session_id"]
        second = client.post("/chat", json={"message": "重试", "session_id": session_id})
        assert second.json()["error"]["code"] == "output_truncated"
        assert client.get("/sessions/" + session_id).json()["messages"] == []


@pytest.mark.parametrize(
    "bad_call",
    [
        tool_call(arguments={"smiles": "invalid"}),
        tool_call(arguments={"smiles": "CCO", "arbitrary": "ignored?"}),
        tool_call(name="execute_shell", arguments={"command": "anything"}),
        {
            "id": "x",
            "type": "function",
            "function": {
                "name": "molecular_properties",
                "arguments": "{broken-json",
            },
        },
    ],
)
def test_bad_tool_inputs_are_returned_to_model_for_correction(settings_factory, bad_call):
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        if count == 1:
            return httpx.Response(200, json=completion(None, calls=[bad_call]))
        payload = json.loads(request.content)
        assert json.loads(payload["messages"][-1]["content"])["error"] == "invalid_tool_input"
        return httpx.Response(200, json=completion("请提供有效的 SMILES。"))

    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(provider))
    ) as client:
        response = client.post("/chat", json={"message": "执行计算"})
        assert response.status_code == 200, response.text
        assert response.json()["tool_calls"][0]["success"] is False


@pytest.mark.parametrize("obeys_limit", [True, False])
def test_tool_loop_is_bounded(settings_factory, obeys_limit):
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        payload = json.loads(request.content)
        if count == 1:
            assert payload["tool_choice"] == "auto"
            return httpx.Response(200, json=completion(None, calls=[tool_call()]))
        assert count == 2
        assert payload["tool_choice"] == "none"
        return httpx.Response(
            200,
            json=completion("已总结。")
            if obeys_limit
            else completion(None, calls=[tool_call(call_id="call-2")]),
        )

    with TestClient(
        create_app(settings_factory(max_tool_rounds=1), transport=httpx.MockTransport(provider))
    ) as client:
        response = client.post("/chat", json={"message": "计算 CCO"})
        assert response.status_code == (200 if obeys_limit else 422)
        if not obeys_limit:
            assert response.json()["error"]["code"] == "tool_round_limit"


def test_failed_turn_can_be_retried_with_clean_history(settings_factory):
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        if count == 1:
            return httpx.Response(500)
        messages = json.loads(request.content)["messages"]
        assert [message["role"] for message in messages] == ["system", "user"]
        assert messages[-1]["content"] == "第二次问题"
        return httpx.Response(200, json=completion("成功。"))

    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(provider))
    ) as client:
        data = client.post("/chat", json={"message": "第一次问题"}).json()["error"]
        response = client.post(
            "/chat",
            json={
                "message": "第二次问题",
                "session_id": data["session_id"],
            },
        )
        assert response.status_code == 200
        assert len(client.get("/sessions/" + data["session_id"]).json()["messages"]) == 2


def test_context_is_delimited_and_persisted(settings_factory):
    def provider(request):
        message = json.loads(request.content)["messages"][-1]["content"]
        assert (
            message == "分析片段\n\n<user_provided_reference>\n论文原文\n</user_provided_reference>"
        )
        return httpx.Response(200, json=completion("根据提供的片段……"))

    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(provider))
    ) as client:
        data = client.post("/chat", json={"message": "分析片段", "context": "论文原文"}).json()
        history = client.get("/sessions/" + data["session_id"]).json()["messages"]
        assert "论文原文" in history[0]["content"]


def test_validation_and_missing_resources(settings_factory):
    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(unused_provider))
    ) as client:
        assert client.post("/chat", json={"message": "   "}).status_code == 422
        assert client.post("/chat", json={"message": "hi", "unexpected": True}).status_code == 422
        assert client.post("/sessions", json={"title": " "}).status_code == 422
        assert client.get("/sessions/not-a-uuid").status_code == 422
        assert client.get("/sessions/" + str(uuid4())).status_code == 404
        assert client.get("/runs/" + str(uuid4())).status_code == 404
        assert (
            client.post(
                "/chat",
                json={
                    "message": "hello",
                    "session_id": str(uuid4()),
                },
            ).status_code
            == 404
        )
        assert client.get("/sessions?limit=10000").status_code == 422
        assert client.get("/sessions").json() == []
        created = client.post("/sessions", json={"title": "化学测试"})
        assert created.status_code == 201
        assert client.get("/sessions").json()[0]["title"] == "化学测试"


async def test_same_session_conflicts_but_other_sessions_can_run(settings_factory):
    started, release = asyncio.Event(), asyncio.Event()
    count = 0

    async def provider(request):
        nonlocal count
        count += 1
        if count == 1:
            started.set()
            await release.wait()
        return httpx.Response(200, json=completion("完成。"))

    app = create_app(settings_factory(), transport=httpx.MockTransport(provider))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        session_id = (await client.post("/sessions", json={})).json()["id"]
        first = asyncio.create_task(
            client.post(
                "/chat",
                json={
                    "session_id": session_id,
                    "message": "第一条任务",
                },
            )
        )
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            second = await client.post(
                "/chat", json={"session_id": session_id, "message": "第二条"}
            )
            assert second.status_code == 409
            assert second.json()["error"]["code"] == "session_busy"
            other = await client.post("/chat", json={"message": "另一会话"})
            assert other.status_code == 200
        finally:
            release.set()
            first_result = await first
        assert first_result.status_code == 200


async def test_total_run_timeout_releases_session(settings_factory):
    async def provider(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json=completion())

    app = create_app(
        settings_factory(run_timeout_seconds=0.02), transport=httpx.MockTransport(provider)
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.post("/chat", json={"message": "长任务"})
        assert response.status_code == 504
        error = response.json()["error"]
        assert error["code"] == "run_timeout"
        assert (await client.get("/runs/" + error["run_id"])).json()["status"] == "failed"
        again = await client.post(
            "/chat", json={"message": "重试", "session_id": error["session_id"]}
        )
        assert again.status_code == 504  # timed out, but is not stuck with a busy reservation


def test_completed_tool_results_are_preserved_when_model_later_fails(settings_factory):
    count = 0

    def provider(request):
        nonlocal count
        count += 1
        if count == 1:
            return httpx.Response(200, json=completion(None, calls=[tool_call()]))
        return httpx.Response(500)

    with TestClient(
        create_app(settings_factory(), transport=httpx.MockTransport(provider))
    ) as client:
        response = client.post("/chat", json={"message": "计算 CCO"})
        assert response.status_code == 502
        error = response.json()["error"]
        run = client.get("/runs/" + error["run_id"]).json()
        assert run["status"] == "failed"
        assert run["tool_calls"][0]["result"]["formula"] == "C2H6O"
        assert run["usage"]["total_tokens"] == 15
        assert client.get("/sessions/" + error["session_id"]).json()["messages"] == []


async def test_cancelled_request_is_recorded_and_session_can_continue(settings_factory):
    started = asyncio.Event()
    count = 0

    async def provider(request):
        nonlocal count
        count += 1
        if count == 1:
            started.set()
            await asyncio.Event().wait()
        return httpx.Response(200, json=completion())

    app = create_app(settings_factory(), transport=httpx.MockTransport(provider))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        session_id = (await client.post("/sessions", json={})).json()["id"]
        pending = asyncio.create_task(
            client.post(
                "/chat",
                json={
                    "session_id": session_id,
                    "message": "取消此任务",
                },
            )
        )
        await asyncio.wait_for(started.wait(), timeout=5)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        runs = (await client.get(f"/sessions/{session_id}/runs")).json()
        assert runs[0]["status"] == "cancelled"
        assert runs[0]["error_code"] == "run_cancelled"
        again = await client.post("/chat", json={"session_id": session_id, "message": "重试"})
        assert again.status_code == 200


def test_nullable_tool_calls_are_valid_final_responses(settings_factory):
    payload = completion()
    payload["choices"][0]["message"]["tool_calls"] = None
    with TestClient(
        create_app(
            settings_factory(),
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)),
        )
    ) as client:
        assert client.post("/chat", json={"message": "你好"}).status_code == 200
