"""Check the built Linux image, account isolation, RDKit and volume persistence locally."""

import argparse
import json
import secrets
import subprocess
import time
from pathlib import Path

import httpx

LABEL = "chemistry-agent-smoke"
# Disposable test accounts only. This script is excluded from deployment archives and images.
PASSWORD = "local-preview-only-password"


def docker(*args, input_text=None):
    process = subprocess.run(
        ["docker", *args],
        input=input_text,
        text=True,
        encoding="utf-8",
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if process.returncode:
        raise RuntimeError(f"Docker command {args[0]} failed: {process.stderr[-1500:]}")
    return process.stdout.strip()


def remove_container(name, marker):
    info = json.loads(docker("inspect", name))[0]
    if info["Config"]["Labels"].get("codex.test") != marker:
        raise RuntimeError("Refusing to remove a container outside this test")
    docker("rm", "--force", name)


def start_container(name, volume, marker, port):
    return docker(
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        f"codex.test={marker}",
        "--publish",
        f"127.0.0.1:{port}:8765",
        "--env",
        "CHEMISTRY_COOKIE_SECURE=false",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=67108864,mode=1777",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--volume",
        f"{volume}:/data",
        "chemistry-agent:local",
    )


def ready(url):
    with httpx.Client(base_url=url, timeout=2, trust_env=False) as client:
        for _ in range(100):
            try:
                if client.get("/health").status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
    raise RuntimeError("Container API did not become ready")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="Keep the loopback-only test for UI QA")
    parser.add_argument("--port", type=int, default=18766)
    args = parser.parse_args()
    marker = LABEL + "-" + secrets.token_hex(4)
    name, volume = marker, marker + "-data"
    url = f"http://127.0.0.1:{args.port}"
    docker("volume", "create", "--label", f"codex.test={marker}", volume)
    running = False
    success = False
    try:
        start_container(name, volume, marker, args.port)
        running = True
        ready(url)
        code = (
            "import asyncio,json,sys; from chemistry_agent.config import Settings; "
            "from chemistry_agent.auth import create_user_account; data=json.load(sys.stdin); "
            "asyncio.run(create_user_account(Settings(),data['username'],data['password']))"
        )
        for username in ("alice", "bob"):
            docker(
                "exec",
                "-i",
                name,
                "python",
                "-c",
                code,
                input_text=json.dumps({"username": username, "password": PASSWORD}),
            )
        with (
            httpx.Client(base_url=url, timeout=15, trust_env=False) as alice,
            httpx.Client(base_url=url, timeout=15, trust_env=False) as bob,
        ):
            assert alice.get("/sessions").status_code == 401
            assert (
                alice.post(
                    "/auth/login", json={"username": "alice", "password": PASSWORD}
                ).status_code
                == 200
            )
            assert (
                bob.post("/auth/login", json={"username": "bob", "password": PASSWORD}).status_code
                == 200
            )
            session = alice.post("/sessions", json={"title": "乙醇分子研究"}).json()
            assert bob.get("/sessions").json() == []
            assert bob.get("/sessions/" + session["id"]).status_code == 404
            result = alice.post(
                "/tools/molecular_properties/invoke", json={"arguments": {"smiles": "CCO"}}
            )
            assert result.status_code == 200, result.text
            assert result.json()["result"]["formula"] == "C2H6O"
            assert alice.get("/health").json()["model_configured"] is False
            docker(
                "exec",
                name,
                "python",
                "-c",
                (
                    "import os; from chemistry_agent.config import Settings; "
                    "from chemistry_agent.tokens import TokenCounter; "
                    "assert os.getuid()==10001; "
                    "assert TokenCounter(Settings().tokenizer_path).tokenizer is not None; "
                    "print('Non-root runtime and bundled tokenizer verified.')"
                ),
            )
            remove_container(name, marker)
            running = False
            start_container(name, volume, marker, args.port)
            running = True
            ready(url)
            # Existing cookies and data must survive a replacement container, not just a restart.
            assert alice.get("/auth/status").json()["user"]["username"] == "alice"
            assert alice.get("/sessions").json()[0]["id"] == session["id"]
            assert bob.get("/sessions").json() == []
            assert alice.post("/auth/logout").status_code == 204
            assert alice.get("/sessions").status_code == 401
        report = {
            "status": "passed",
            "url": url,
            "container": name,
            "volume": volume,
            "marker": marker,
            "kept_for_preview": args.keep,
            "checks": [
                "login",
                "account_isolation",
                "rdkit_linux",
                "non_root_readonly",
                "tokenizer",
                "replacement_container_persistence",
                "logout",
            ],
        }
        path = Path(__file__).resolve().parents[1] / "data" / "docker-smoke-result.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        success = True
        print(json.dumps(report, ensure_ascii=False), flush=True)
    finally:
        if not (success and args.keep):
            if running:
                remove_container(name, marker)
            info = json.loads(docker("volume", "inspect", volume))[0]
            if info["Labels"].get("codex.test") != marker:
                raise RuntimeError("Refusing to remove a volume outside this test")
            docker("volume", "rm", volume)


if __name__ == "__main__":
    main()
