import sqlite3

import pytest

from chemistry_agent.backup import backup_database


def test_backup_includes_committed_wal_and_refuses_overwrites(tmp_path):
    source = tmp_path / "source.sqlite3"
    target = tmp_path / "backups" / "snapshot.sqlite3"
    with sqlite3.connect(source) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE records(value TEXT)")
        db.execute("INSERT INTO records VALUES('committed original')")
        db.commit()
        backup_database(source, target)
        with sqlite3.connect(target) as snapshot:
            assert (
                snapshot.execute("SELECT value FROM records").fetchone()[0] == "committed original"
            )
        with pytest.raises(FileExistsError):
            backup_database(source, target)
    with pytest.raises(ValueError):
        backup_database(tmp_path / "missing.sqlite3", tmp_path / "other.sqlite3")
