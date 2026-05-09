from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

LEGAL_AI_ROOT = Path(__file__).resolve().parents[1]

_INIT_LOCK = threading.Lock()
_INITIALIZED = False

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  answer_card_json TEXT,
  process_events_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated ON chat_sessions(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
"""


def get_chat_db_path() -> Path:
    raw = os.environ.get("CHAT_DB_PATH", "data/legal_ai_chat.db").strip()
    path = Path(raw)
    if not path.is_absolute():
        path = LEGAL_AI_ROOT / path
    return path.resolve()


def init_db() -> None:
    """Create parent directory, SQLite file, tables, and indexes (idempotent)."""
    global _INITIALIZED
    path = get_chat_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()
    with _INIT_LOCK:
        _INITIALIZED = True


def _ensure_initialized() -> None:
    """Lazy init if startup hook did not run (e.g. scripts)."""
    global _INITIALIZED
    if _INITIALIZED:
        return
    with _INIT_LOCK:
        if _INITIALIZED:
            return
        init_db()


@contextmanager
def db_connection():
    _ensure_initialized()
    path = get_chat_db_path()
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
