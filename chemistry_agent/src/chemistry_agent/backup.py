"""Create a consistent SQLite backup, including committed WAL data, while the service runs."""

import argparse
import sqlite3
from pathlib import Path

from chemistry_agent.config import Settings


def backup_database(source: Path, target: Path) -> None:
    if not source.is_file():
        raise ValueError("Source database does not exist")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Refuse to overwrite an existing backup or the source database.
    with target.open("xb"):
        pass
    with sqlite3.connect(source, timeout=30) as source_db, sqlite3.connect(target) as target_db:
        source_db.backup(target_db)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        backup_database(Settings().database_path, args.output)
    except (ValueError, OSError, sqlite3.Error) as exc:
        raise SystemExit(str(exc)) from None
    print("Database snapshot saved:", args.output)


if __name__ == "__main__":
    main()
