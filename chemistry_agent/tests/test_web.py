import httpx
from fastapi.testclient import TestClient

from chemistry_agent.api import create_app


def test_frontend_assets_and_api_are_served_together(settings_factory):
    app = create_app(
        settings_factory(), transport=httpx.MockTransport(lambda request: httpx.Response(200))
    )
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Chemistry Agent" in response.text
        assert 'id="chat-form"' in response.text
        assert "test-only-key" not in response.text
        for asset in (
            "styles.css",
            "app.mjs",
            "core.mjs",
            "favicon.svg",
            "vendor/markdown-it.min.js",
        ):
            response = client.get("/assets/" + asset)
            assert response.status_code == 200
            assert "test-only-key" not in response.text
        assert client.get("/assets/app.mjs").headers["content-type"].split(";")[0] in {
            "application/javascript",
            "text/javascript",
        }
        assert client.get("/docs").status_code == 200
        assert client.get("/.env").status_code == 404
        assert client.get("/assets/%2e%2e/%2e%2e/.env").status_code == 404
