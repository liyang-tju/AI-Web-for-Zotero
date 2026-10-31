from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator

from chemistry_agent.config import Settings
from chemistry_agent.errors import AgentError
from chemistry_agent.schemas import TokenUsage


class FunctionCall(BaseModel):
    name: str = Field(min_length=1)
    arguments: str


class ToolCall(BaseModel):
    id: str = Field(min_length=1)
    type: Literal["function"]
    function: FunctionCall


class AssistantMessage(BaseModel):
    role: Literal["assistant"]
    content: str | None = None
    reasoning_content: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list, max_length=16)

    @field_validator("tool_calls", mode="before")
    @classmethod
    def normalize_null_calls(cls, value):
        return [] if value is None else value

    def to_wire(self) -> dict[str, Any]:
        # Preserve reasoning for DeepSeek's thinking+tools continuation protocol.
        message = self.model_dump(exclude_none=True)
        if not self.tool_calls:
            message.pop("tool_calls", None)
        return message


class Completion(BaseModel):
    message: AssistantMessage
    usage: TokenUsage


class DeepSeekClient:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.http = httpx.AsyncClient(
            base_url=settings.deepseek_base_url + "/",
            timeout=httpx.Timeout(settings.deepseek_timeout_seconds, connect=10),
            transport=transport,
        )

    async def close(self) -> None:
        await self.http.aclose()

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        allow_tools: bool,
        max_tokens: int | None = None,
        thinking: bool | None = None,
    ) -> Completion:
        if not self.settings.model_configured:
            raise AgentError("model_not_configured", "请先配置 DEEPSEEK_API_KEY。", 503)
        payload = {
            "model": self.settings.deepseek_model,
            "messages": messages,
            "thinking": {
                "type": "enabled"
                if (self.settings.deepseek_thinking if thinking is None else thinking)
                else "disabled"
            },
            "max_tokens": max_tokens
            if max_tokens is not None
            else self.settings.deepseek_max_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto" if allow_tools else "none"
        key = self.settings.deepseek_api_key.get_secret_value()
        try:
            response = await self.http.post(
                "chat/completions", json=payload, headers={"Authorization": f"Bearer {key}"}
            )
        except httpx.TimeoutException as exc:
            raise AgentError("provider_timeout", "DeepSeek 响应超时，请稍后重试。", 504) from exc
        except httpx.RequestError as exc:
            raise AgentError("provider_unreachable", "无法连接 DeepSeek，请检查网络配置。") from exc

        if response.status_code in {401, 403}:
            raise AgentError(
                "provider_authentication_failed", "DeepSeek 认证失败，请检查 API Key。"
            )
        if response.status_code == 402:
            raise AgentError("provider_insufficient_balance", "DeepSeek 账户余额不足。")
        if response.status_code == 429:
            raise AgentError("provider_rate_limited", "DeepSeek 请求受限，请稍后重试。", 503)
        if not response.is_success:
            # Do not expose upstream response bodies: they can contain credentials or input text.
            raise AgentError("provider_error", f"DeepSeek 返回 HTTP {response.status_code}。")
        try:
            data = response.json()
            choice = data["choices"][0]
            if not isinstance(choice, dict):
                raise ValueError("Expected a choice object")
            if choice.get("finish_reason") == "length":
                raise AgentError(
                    "output_truncated", "模型输出达到上限，请缩小任务或增加 token 上限。"
                )
            if choice.get("finish_reason") not in {"stop", "tool_calls"}:
                raise AgentError("provider_incomplete", "模型未正常完成响应，请重试。")
            message = AssistantMessage.model_validate(choice["message"])
            ids = [call.id for call in message.tool_calls]
            if len(ids) != len(set(ids)):
                raise ValueError("Duplicate tool call IDs")
            if not message.tool_calls and not (message.content and message.content.strip()):
                raise ValueError("Empty final answer")
            usage_data = data.get("usage") or {}
            usage = TokenUsage.model_validate(usage_data)
        except (ValueError, TypeError, KeyError, IndexError, ValidationError) as exc:
            raise AgentError(
                "provider_invalid_response", "DeepSeek 返回了无法解析的响应。"
            ) from exc
        return Completion(message=message, usage=usage)
