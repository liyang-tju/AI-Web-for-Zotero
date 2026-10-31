import pytest

from chemistry_agent.config import Settings


@pytest.fixture
def settings_factory(tmp_path):
    def create(**overrides):
        values = {
            "_env_file": None,
            "deepseek_api_key": "test-only-key",
            "deepseek_base_url": "https://deepseek.test/v1",
            "deepseek_model": "deepseek-flash",
            "deepseek_thinking": False,
            "database_path": tmp_path / "agent.sqlite3",
            "tokenizer_path": tmp_path / "missing-tokenizer.json",
        }
        return Settings(**(values | overrides))

    return create
