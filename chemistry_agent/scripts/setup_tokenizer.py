"""Install official DeepSeek tokenizer data locally; never execute downloaded Python code."""

import argparse
import hashlib
import io
from pathlib import Path
from zipfile import ZipFile

import httpx

SOURCE = "https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip"
ARCHIVE_SHA256 = "e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495"
DATA_SHA256 = "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proxy", default=None, help="Optional HTTP(S) proxy URL")
    parser.add_argument("--output", type=Path, default=None, help="Optional output JSON path")
    args = parser.parse_args()
    target = args.output or Path(__file__).resolve().parents[1] / "data" / "deepseek-tokenizer.json"
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == DATA_SHA256:
        print("Official tokenizer is already installed.")
        return
    with httpx.Client(proxy=args.proxy, timeout=45, follow_redirects=True) as client:
        response = client.get(SOURCE)
        response.raise_for_status()
    if hashlib.sha256(response.content).hexdigest() != ARCHIVE_SHA256:
        raise SystemExit(
            "Tokenizer archive changed; verify its source and checksum before updating."
        )
    with ZipFile(io.BytesIO(response.content)) as archive:
        data = archive.read("deepseek_v4_tokenizer/tokenizer.json")
    if hashlib.sha256(data).hexdigest() != DATA_SHA256:
        raise SystemExit("Tokenizer data checksum does not match.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print("Official tokenizer data installed under data/; no downloaded code was executed.")


if __name__ == "__main__":
    main()
