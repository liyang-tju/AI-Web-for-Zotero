"""Opt-in live integration check. Requires the running API and makes billable model calls."""

import argparse
import json
import time
from pathlib import Path

import httpx


def checked(response: httpx.Response) -> dict | list:
    if not response.is_success:
        # The local API sanitizes provider errors; do not dump request headers or settings.
        try:
            error = response.json().get("error", {})
        except ValueError:
            error = {}
        raise RuntimeError(f"HTTP {response.status_code}: {error.get('code', 'request_failed')}")
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    report = {"status": "running", "checks": []}
    report_path = Path(__file__).resolve().parents[1] / "data" / "live-test-result.json"
    try:
        # Ignore proxy env for requests to the local service. Its model client handles upstream.
        with httpx.Client(base_url=args.url, timeout=120, trust_env=False) as client:
            health = checked(client.get("/health"))
            if not health["model_configured"]:
                raise RuntimeError("DEEPSEEK_API_KEY is not configured in the server")
            report["model"] = health["model"]
            session = checked(client.post("/sessions", json={"title": "DeepSeek 真实接口联调"}))
            session_id = session["id"]
            report["session_id"] = session_id
            cases = [
                ("connection", "请只回复：连接成功。", None),
                (
                    "molecular_properties",
                    "请务必调用 molecular_properties 工具，计算乙醇 "
                    "SMILES=CCO 的分子式和分子量，用一句话报告结果和单位。",
                    "molecular_properties",
                ),
                (
                    "conversation_and_similarity",
                    "请沿用上一轮分子的 SMILES，与甲醇 SMILES=CO "
                    "调用 molecular_similarity 工具比较结构相似度，只报告两个分子和相似度数值。",
                    "molecular_similarity",
                ),
            ]
            for name, message, expected_tool in cases:
                started = time.monotonic()
                data = checked(
                    client.post(
                        "/chat",
                        json={
                            "session_id": session_id,
                            "message": message,
                        },
                    )
                )
                calls = data["tool_calls"]
                if expected_tool and not any(
                    call["name"] == expected_tool and call["success"] for call in calls
                ):
                    raise RuntimeError(f"{name}: expected successful tool execution")
                if expected_tool == "molecular_properties":
                    result = next(
                        call["result"]
                        for call in calls
                        if call["name"] == expected_tool and call["success"]
                    )
                    if result["formula"] != "C2H6O":
                        raise RuntimeError("Unexpected ethanol molecular formula")
                if expected_tool == "molecular_similarity":
                    result = next(
                        call["result"]
                        for call in calls
                        if call["name"] == expected_tool and call["success"]
                    )
                    if {result["canonical_smiles_a"], result["canonical_smiles_b"]} != {
                        "CCO",
                        "CO",
                    }:
                        raise RuntimeError("Follow-up did not preserve the previous molecule")
                run = checked(client.get("/runs/" + data["run_id"]))
                if run["status"] != "completed":
                    raise RuntimeError(f"{name}: run was not saved as completed")
                check = {
                    "name": name,
                    "status": "passed",
                    "answer": data["answer"],
                    "tool_names": [call["name"] for call in calls],
                    "usage": data["usage"],
                    "elapsed_seconds": round(time.monotonic() - started, 2),
                }
                report["checks"].append(check)
                print(json.dumps(check, ensure_ascii=False), flush=True)
            history = checked(client.get("/sessions/" + session_id))["messages"]
            if sum(item["role"] == "user" for item in history) != len(cases):
                raise RuntimeError("Conversation history was not persisted correctly")
            report["history_messages"] = len(history)
            report["status"] = "passed"
    except (RuntimeError, httpx.HTTPError) as exc:
        report["status"] = "failed"
        # Print only a controlled diagnostic, not exception chains or HTTP request objects.
        report["error"] = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"status": "failed", "error": report["error"]}), flush=True)
    finally:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if report["status"] != "passed":
        raise SystemExit(1)
    print("All live checks passed; report saved under data/.", flush=True)


if __name__ == "__main__":
    main()
