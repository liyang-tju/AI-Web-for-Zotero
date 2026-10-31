import uvicorn

from chemistry_agent.api import create_app
from chemistry_agent.config import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        proxy_headers=True,
        forwarded_allow_ips=settings.trusted_proxy_ips,
    )


if __name__ == "__main__":
    main()
