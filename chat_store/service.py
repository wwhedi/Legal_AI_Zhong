from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from chat_store.db import db_connection


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def list_sessions(*, user_id: str) -> list[dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, title, created_at, updated_at
            FROM chat_sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_session(*, user_id: str, title: str | None) -> dict[str, Any]:
    sid = str(uuid.uuid4())
    now = _iso_now()
    t = (title or "").strip() or "新对话"
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (sid, user_id, t, now, now),
        )
    return {"id": sid, "title": t, "created_at": now, "updated_at": now}


def _get_session_row(conn, *, session_id: str, user_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT id, user_id, title, created_at, updated_at
        FROM chat_sessions
        WHERE id = ? AND user_id = ?
        """,
        (session_id, user_id),
    ).fetchone()
    return dict(row) if row else None


def get_session_with_messages(*, session_id: str, user_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    with db_connection() as conn:
        sess = _get_session_row(conn, session_id=session_id, user_id=user_id)
        if sess is None:
            return None
        msg_rows = conn.execute(
            """
            SELECT id, role, content, answer_card_json, process_events_json, created_at
            FROM chat_messages
            WHERE session_id = ? AND user_id = ?
            ORDER BY created_at ASC, id ASC
            """,
            (session_id, user_id),
        ).fetchall()
    messages: list[dict[str, Any]] = []
    for r in msg_rows:
        ac_raw = r["answer_card_json"]
        pe_raw = r["process_events_json"]
        messages.append(
            {
                "id": r["id"],
                "role": r["role"],
                "content": r["content"],
                "answer_card": json.loads(ac_raw) if ac_raw else None,
                "process_events": json.loads(pe_raw) if pe_raw else None,
                "created_at": r["created_at"],
            }
        )
    summary = {
        "id": sess["id"],
        "title": sess["title"],
        "created_at": sess["created_at"],
        "updated_at": sess["updated_at"],
    }
    return summary, messages


def patch_session_title(*, session_id: str, user_id: str, title: str) -> dict[str, Any] | None:
    now = _iso_now()
    with db_connection() as conn:
        cur = conn.execute(
            """
            UPDATE chat_sessions
            SET title = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (title.strip(), now, session_id, user_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(
            "SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ?",
            (session_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def delete_session(*, session_id: str, user_id: str) -> bool:
    with db_connection() as conn:
        cur = conn.execute(
            "DELETE FROM chat_sessions WHERE id = ? AND user_id = ?",
            (session_id, user_id),
        )
        return cur.rowcount > 0


def append_message(
    *,
    session_id: str,
    user_id: str,
    role: str,
    content: str | None,
    answer_card: Any,
    process_events: Any,
    created_at: str | None,
) -> dict[str, Any] | None:
    """Returns message dict or None if session missing / not owned."""
    mid = str(uuid.uuid4())
    ca = created_at.strip() if isinstance(created_at, str) and created_at.strip() else _iso_now()
    ac_json = json.dumps(answer_card, ensure_ascii=False) if answer_card is not None else None
    pe_json = json.dumps(process_events, ensure_ascii=False) if process_events is not None else None
    with db_connection() as conn:
        sess = _get_session_row(conn, session_id=session_id, user_id=user_id)
        if sess is None:
            return None
        conn.execute(
            """
            INSERT INTO chat_messages (
              id, session_id, user_id, role, content, answer_card_json, process_events_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (mid, session_id, user_id, role, content, ac_json, pe_json, ca),
        )
        conn.execute(
            "UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?",
            (ca, session_id, user_id),
        )
    return {
        "id": mid,
        "role": role,
        "content": content,
        "answer_card": answer_card,
        "process_events": process_events,
        "created_at": ca,
    }
