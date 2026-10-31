from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    deepseek_api_key: SecretStr | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = Field(default="deepseek-flash", min_length=1)
    deepseek_thinking: bool = False
    deepseek_max_tokens: int = Field(default=4096, ge=256, le=32768)
    deepseek_timeout_seconds: float = Field(default=60, gt=0, le=300)
    host: str = Field(default="127.0.0.1", validation_alias="CHEMISTRY_HOST")
    port: int = Field(default=8765, ge=1, le=65535, validation_alias="CHEMISTRY_PORT")
    max_tool_rounds: int = Field(
        default=6, ge=1, le=20, validation_alias="CHEMISTRY_MAX_TOOL_ROUNDS"
    )
    run_timeout_seconds: float = Field(
        default=180, gt=0, le=1800, validation_alias="CHEMISTRY_RUN_TIMEOUT_SECONDS"
    )
    database_path: Path = Field(
        default=PROJECT_ROOT / "data" / "agent.sqlite3",
        validation_alias="CHEMISTRY_DATABASE_PATH",
    )
    context_window_tokens: int = Field(
        default=32768, ge=2048, le=1000000, validation_alias="CHEMISTRY_CONTEXT_WINDOW_TOKENS"
    )
    context_trigger_ratio: float = Field(
        default=0.8, ge=0.4, le=0.95, validation_alias="CHEMISTRY_CONTEXT_TRIGGER_RATIO"
    )
    context_recent_turns: int = Field(
        default=4, ge=1, le=20, validation_alias="CHEMISTRY_CONTEXT_RECENT_TURNS"
    )
    context_summary_tokens: int = Field(
        default=1024, ge=128, le=4096, validation_alias="CHEMISTRY_CONTEXT_SUMMARY_TOKENS"
    )
    context_tool_result_tokens: int = Field(
        default=512, ge=128, le=8192, validation_alias="CHEMISTRY_CONTEXT_TOOL_RESULT_TOKENS"
    )
    tokenizer_path: Path = Field(
        default=PROJECT_ROOT / "data" / "deepseek-tokenizer.json",
        validation_alias="CHEMISTRY_TOKENIZER_PATH",
    )

    @field_validator("deepseek_api_key", mode="before")
    @classmethod
    def clean_key(cls, value):
        if isinstance(value, str):
            return value.strip() or None
        return value

    auth_enabled: bool = Field(default=False, validation_alias="CHEMISTRY_AUTH_ENABLED")
    cookie_secure: bool = Field(default=False, validation_alias="CHEMISTRY_COOKIE_SECURE")
    session_ttl_seconds: int = Field(
        default=43200, ge=300, le=2592000, validation_alias="CHEMISTRY_SESSION_TTL_SECONDS"
    )
    trusted_proxy_ips: str = Field(
        default="127.0.0.1", validation_alias="CHEMISTRY_TRUSTED_PROXY_IPS"
    )

    @field_validator("deepseek_base_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        url = urlsplit(value)
        if url.scheme not in {"https", "http"} or not url.hostname:
            raise ValueError("DEEPSEEK_BASE_URL must be an HTTP(S) URL")
        if url.username or url.password or url.query or url.fragment:
            raise ValueError("DEEPSEEK_BASE_URL must not contain credentials, query, or fragment")
        return value.rstrip("/")

    @field_validator("database_path", "tokenizer_path")
    @classmethod
    def resolve_project_path(cls, value: Path) -> Path:
        return value if value.is_absolute() else PROJECT_ROOT / value

    @model_validator(mode="after")
    def validate_context_budget(self):
        if (
            self.context_window_tokens
            <= max(self.deepseek_max_tokens, self.context_summary_tokens) + 1024
        ):
            raise ValueError("Context window must reserve output tokens plus 1024 input tokens")
        return self

    @property
    def context_input_budget(self) -> int:
        return self.context_window_tokens - self.deepseek_max_tokens

    @property
    def model_configured(self) -> bool:
        return bool(self.deepseek_api_key and self.deepseek_api_key.get_secret_value().strip())
