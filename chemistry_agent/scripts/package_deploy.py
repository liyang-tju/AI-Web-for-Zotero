"""Package an allowlisted source deployment bundle, without credentials or runtime data."""

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "Dockerfile",
    ".dockerignore",
    "compose.yaml",
    ".env.server.example",
    ".env.example",
    ".gitignore",
    "pyproject.toml",
    "constraints.txt",
    "README.md",
    "DEPLOYMENT.md",
    "LICENSE",
    "deploy/Caddyfile",
    "scripts/setup_tokenizer.py",
    "scripts/package_deploy.py",
)


def package(output: Path):
    sources = [ROOT / name for name in FILES]
    sources.extend(
        path
        for path in (ROOT / "src").rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    )
    for source in sources:
        if not source.is_file():
            raise ValueError(f"Missing deployment source: {source.relative_to(ROOT)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for source in sorted(sources):
            archive.write(source, source.relative_to(ROOT).as_posix())
    return len(sources)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    count = package(args.output)
    print(f"Packaged {count} source files; local credentials and runtime data are excluded.")


if __name__ == "__main__":
    main()
