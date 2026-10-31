import httpx
import pytest
from fastapi.testclient import TestClient

from chemistry_agent.api import create_app
from chemistry_agent.config import PROJECT_ROOT, Settings
from chemistry_agent.store import Store


def test_real_rdkit_calculations_and_rejected_inputs(settings_factory):
    with TestClient(
        create_app(
            settings_factory(),
            transport=httpx.MockTransport(
                lambda request: pytest.fail("Local tools should not call DeepSeek")
            ),
        )
    ) as client:
        result = client.post(
            "/tools/molecular_properties/invoke",
            json={
                "arguments": {"smiles": "CCO"},
            },
        ).json()["result"]
        assert result["molecular_weight_g_mol"] == pytest.approx(46.069, abs=0.001)
        assert result["exact_mass_da"] == pytest.approx(46.041865, abs=0.000001)
        assert result["hydrogen_bond_donors"] == 1
        assert result["formal_charge"] == 0
        assert "RDKit" in result["source"]
        same = client.post(
            "/tools/molecular_similarity/invoke",
            json={
                "arguments": {"smiles_a": "CCO", "smiles_b": "OCC"},
            },
        )
        assert same.json()["result"]["tanimoto_similarity"] == 1
        for arguments in (
            {"smiles": "bogus"},
            {"smiles": ""},
            {"smiles": 123},
            {"smiles": "CCO", "extra": True},
            {},
        ):
            response = client.post(
                "/tools/molecular_properties/invoke", json={"arguments": arguments}
            )
            assert response.status_code == 422
            assert response.json()["success"] is False
        assert client.post("/tools/nonexistent/invoke", json={}).status_code == 404


async def test_restart_marks_active_runs_interrupted(settings_factory):
    path = settings_factory().database_path
    first = await Store.open(path)
    session = await first.create_session("unfinished")
    run_id, history = await first.begin_run(session["id"])
    assert history == []
    await first.close()
    second = await Store.open(path)
    try:
        run = await second.get_run(run_id)
        assert run["status"] == "interrupted"
        assert run["error_code"] == "service_restarted"
        new_run, _ = await second.begin_run(session["id"])
        assert new_run != run_id
    finally:
        await second.close()


async def test_second_process_cannot_reset_an_active_run(settings_factory):
    path = settings_factory().database_path
    first = await Store.open(path)
    try:
        session = await first.create_session("active")
        run_id, _ = await first.begin_run(session["id"])
        with pytest.raises(RuntimeError, match="Chemistry Agent"):
            await Store.open(path)
        assert (await first.get_run(run_id))["status"] == "running"
    finally:
        await first.close()


def test_settings_resolve_paths_and_do_not_print_key(settings_factory):
    settings = settings_factory(database_path="data/test.sqlite3")
    assert settings.database_path == PROJECT_ROOT / "data" / "test.sqlite3"
    assert "test-only-key" not in repr(settings)
    assert settings_factory(deepseek_api_key="   ").model_configured is False
    assert settings_factory(deepseek_base_url="https://example.com/v1/").deepseek_base_url.endswith(
        "v1"
    )
    with pytest.raises(ValueError):
        settings_factory(deepseek_base_url="https://user:secret@example.com")


def test_dotenv_loading_and_environment_override(tmp_path, monkeypatch):
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "DEEPSEEK_API_KEY=dotenv-test\nDEEPSEEK_MODEL=dotenv-model\n", encoding="utf-8"
    )
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_MODEL", "environment-model")
    settings = Settings(_env_file=dotenv)
    assert settings.model_configured
    assert settings.deepseek_api_key.get_secret_value() == "dotenv-test"
    assert settings.deepseek_model == "environment-model"
