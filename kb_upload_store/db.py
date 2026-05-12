from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

LEGAL_AI_ROOT = Path(__file__).resolve().parents[1]

_INIT_LOCK = threading.Lock()
_INITIALIZED_PATHS: set[str] = set()

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kb_upload_records (
  id TEXT PRIMARY KEY,
  law_id TEXT NOT NULL,
  law_name TEXT,
  version_hash TEXT NOT NULL,
  export_file_path TEXT NOT NULL,
  export_file_name TEXT,
  bailian_file_id TEXT,
  bailian_job_id TEXT,
  upload_status TEXT NOT NULL,
  index_status TEXT,
  uploaded_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(law_id, version_hash)
);

CREATE INDEX IF NOT EXISTS idx_kb_upload_records_law_id ON kb_upload_records(law_id);
CREATE INDEX IF NOT EXISTS idx_kb_upload_records_status ON kb_upload_records(upload_status);
"""


def get_kb_upload_db_path() -> Path:
    raw = os.environ.get("LEGAL_KB_STRUCTURED_DB", "data/legal_kb_structured.db").strip()
    path = Path(raw)
    if not path.is_absolute():
        path = LEGAL_AI_ROOT / path
    return path.resolve()


def _migrate_kb_upload_records(conn: sqlite3.Connection) -> None:
    """已有库补充 deleted_at（第 7.3 删除回写）。"""
    cur = conn.execute("PRAGMA table_info(kb_upload_records)")
    cols = {row[1] for row in cur.fetchall()}
    if "deleted_at" not in cols:
        conn.execute("ALTER TABLE kb_upload_records ADD COLUMN deleted_at TEXT")


def init_kb_upload_db(db_path: str | Path | None = None) -> Path:
    """Create parent directory, SQLite file, tables, and indexes (idempotent)."""
    path = Path(db_path) if db_path is not None else get_kb_upload_db_path()
    path = path.resolve()
    key = str(path)
    with _INIT_LOCK:
        if key in _INITIALIZED_PATHS:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), timeout=30)
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.executescript(SCHEMA_SQL)
            _migrate_kb_upload_records(conn)
            conn.commit()
        finally:
            conn.close()
        _INITIALIZED_PATHS.add(key)
    return path


def connect(db_path: str | Path | None = None) -> sqlite3.Connection:
    p = Path(db_path) if db_path is not None else get_kb_upload_db_path()
    p = p.resolve()
    init_kb_upload_db(p)
    conn = sqlite3.connect(str(p), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _migrate_kb_upload_records(conn)
    conn.commit()
    return conn
