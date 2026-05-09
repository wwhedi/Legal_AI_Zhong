from __future__ import annotations

import hashlib
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from kb_upload_store.db import connect, init_kb_upload_db

# 已存在且处于以下状态时：跳过 AddFile / 不再参与 SubmitIndexAddDocumentsJob
UPLOAD_SKIP_STATUSES = frozenset({"UPLOADED", "INDEX_SUBMITTED", "FINISH"})

# 允许重新走上传与解析的状态
UPLOAD_RETRY_STATUSES = frozenset({"FAILED", "PARSE_FAILED", "INDEX_ERROR"})


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def record_id_for(law_id: str, version_hash: str) -> str:
    return hashlib.sha256(f"{law_id}\n{version_hash}".encode("utf-8")).hexdigest()


def compute_law_id(master_row: Mapping[str, Any], export_file_path: str) -> str:
    bbbs = str(master_row.get("bbbs") or "").strip()
    if bbbs:
        return f"bbbs:{bbbs}"
    doc_id = str(master_row.get("doc_id") or "").strip()
    if doc_id:
        return f"doc_id:{doc_id}"
    base = os.path.basename(str(export_file_path).strip()) or "unknown"
    h = hashlib.sha256(base.encode("utf-8", errors="replace")).hexdigest()
    return f"file:{h}"


def sha256_file(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_version_hash(master_row: Mapping[str, Any], export_file_path: str) -> str:
    c = str(master_row.get("content_sha256") or "").strip()
    if c:
        return c
    return sha256_file(export_file_path)


def fetch_kb_upload_records_as_dicts(
    *,
    db_path: str | Path | None = None,
) -> List[Dict[str, Any]]:
    """只读：列出 kb_upload_records 全表行（审计 ListIndexDocuments 映射用）。"""
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        cur = conn.execute(
            """
            SELECT id, law_id, law_name, version_hash, export_file_path, export_file_name,
                   bailian_file_id, bailian_job_id, upload_status, index_status,
                   uploaded_at, last_error, created_at, updated_at
            FROM kb_upload_records
            ORDER BY updated_at DESC
            """
        )
        return [dict(row) for row in cur.fetchall()]


def fetch_record(
    law_id: str,
    version_hash: str,
    *,
    db_path: str | Path | None = None,
) -> Optional[sqlite3.Row]:
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        cur = conn.execute(
            "SELECT * FROM kb_upload_records WHERE law_id = ? AND version_hash = ?",
            (law_id, version_hash),
        )
        return cur.fetchone()


def should_skip_upload(record: Optional[sqlite3.Row]) -> bool:
    if record is None:
        return False
    st = str(record["upload_status"] or "").strip()
    return st in UPLOAD_SKIP_STATUSES


def classify_upload_skip(
    record: Optional[sqlite3.Row],
    *,
    require_index_submission: bool,
) -> Tuple[str, Optional[str]]:
    """
    返回 (mode, file_id)：
    - ("none", None)：正常走租约 + AddFile + 解析。
    - ("full_skip", None)：整行跳过（不参与 SubmitIndex 批次）。
    - ("reuse_file", file_id)：不再上传；用已有 bailian_file_id 参与 SubmitIndex（仅当配置了 index 且上次已 UPLOADED 但未写入 job_id 时）。
    """
    if record is None:
        return ("none", None)
    st = str(record["upload_status"] or "").strip()
    fid = str(record["bailian_file_id"] or "").strip()
    job_id = str(record["bailian_job_id"] or "").strip()

    if st == "FINISH":
        return ("full_skip", None)
    if st == "INDEX_SUBMITTED":
        return ("full_skip", None)
    if st == "UPLOADED":
        if not require_index_submission:
            return ("full_skip", None)
        if not fid:
            return ("none", None)
        if not job_id:
            return ("reuse_file", fid)
        return ("full_skip", None)
    return ("none", None)


def upsert_after_add_file(
    *,
    law_id: str,
    law_name: str,
    version_hash: str,
    export_file_path: str,
    bailian_file_id: str,
    db_path: str | Path | None = None,
) -> None:
    rid = record_id_for(law_id, version_hash)
    export_file_name = os.path.basename(export_file_path)
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO kb_upload_records (
              id, law_id, law_name, version_hash, export_file_path, export_file_name,
              bailian_file_id, bailian_job_id, upload_status, index_status, uploaded_at, last_error,
              created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(law_id, version_hash) DO UPDATE SET
              law_name = excluded.law_name,
              export_file_path = excluded.export_file_path,
              export_file_name = excluded.export_file_name,
              bailian_file_id = excluded.bailian_file_id,
              upload_status = excluded.upload_status,
              uploaded_at = excluded.uploaded_at,
              last_error = excluded.last_error,
              created_at = kb_upload_records.created_at,
              updated_at = excluded.updated_at
            """,
            (
                rid,
                law_id,
                law_name,
                version_hash,
                export_file_path,
                export_file_name,
                bailian_file_id,
                None,
                "UPLOADED",
                None,
                ts,
                None,
                ts,
                ts,
            ),
        )
        conn.commit()


def upsert_after_upload_failure(
    *,
    law_id: str,
    law_name: str,
    version_hash: str,
    export_file_path: str,
    message: str,
    db_path: str | Path | None = None,
) -> None:
    rid = record_id_for(law_id, version_hash)
    export_file_name = os.path.basename(export_file_path)
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO kb_upload_records (
              id, law_id, law_name, version_hash, export_file_path, export_file_name,
              bailian_file_id, bailian_job_id, upload_status, index_status, uploaded_at, last_error,
              created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(law_id, version_hash) DO UPDATE SET
              law_name = excluded.law_name,
              export_file_path = excluded.export_file_path,
              export_file_name = excluded.export_file_name,
              upload_status = excluded.upload_status,
              last_error = excluded.last_error,
              created_at = kb_upload_records.created_at,
              updated_at = excluded.updated_at
            """,
            (
                rid,
                law_id,
                law_name,
                version_hash,
                export_file_path,
                export_file_name,
                None,
                None,
                "FAILED",
                None,
                None,
                message[:4000],
                ts,
                ts,
            ),
        )
        conn.commit()


def update_after_parse_failure(
    *,
    law_id: str,
    version_hash: str,
    message: str,
    db_path: str | Path | None = None,
) -> None:
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET upload_status = 'PARSE_FAILED', last_error = ?, updated_at = ?
            WHERE law_id = ? AND version_hash = ?
            """,
            (message[:4000], ts, law_id, version_hash),
        )
        conn.commit()


def update_after_parse_success_terminal(
    *,
    law_id: str,
    version_hash: str,
    db_path: str | Path | None = None,
) -> None:
    """无后续 SubmitIndex 时，将本条标记为 FINISH，避免仅 UPLOADED 长期悬挂。"""
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET upload_status = 'FINISH', index_status = 'PARSE_SUCCESS', last_error = NULL, updated_at = ?
            WHERE law_id = ? AND version_hash = ?
            """,
            (ts, law_id, version_hash),
        )
        conn.commit()


def update_after_index_submitted(
    *,
    law_id: str,
    version_hash: str,
    bailian_job_id: str,
    db_path: str | Path | None = None,
) -> None:
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET upload_status = 'INDEX_SUBMITTED',
              bailian_job_id = ?,
              index_status = 'SUBMITTED',
              last_error = NULL,
              updated_at = ?
            WHERE law_id = ? AND version_hash = ?
            """,
            (bailian_job_id[:512] if bailian_job_id else None, ts, law_id, version_hash),
        )
        conn.commit()


def update_after_index_error(
    *,
    law_id: str,
    version_hash: str,
    message: str,
    index_status: str = "FAILED",
    db_path: str | Path | None = None,
) -> None:
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET upload_status = 'INDEX_ERROR', index_status = ?, last_error = ?, updated_at = ?
            WHERE law_id = ? AND version_hash = ?
            """,
            (index_status[:64], message[:4000], ts, law_id, version_hash),
        )
        conn.commit()


def update_records_index_running(
    pairs: Sequence[Tuple[str, str]],
    *,
    db_path: str | Path | None = None,
) -> None:
    """Submit 后轮询中：upload_status 维持 INDEX_SUBMITTED，index_status=RUNNING。"""
    if not pairs:
        return
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        for law_id, version_hash in pairs:
            conn.execute(
                """
                UPDATE kb_upload_records
                SET index_status = 'RUNNING', last_error = NULL, updated_at = ?
                WHERE law_id = ? AND version_hash = ?
                  AND upload_status = 'INDEX_SUBMITTED'
                """,
                (ts, law_id, version_hash),
            )
        conn.commit()


def update_record_index_finish(
    *,
    law_id: str,
    version_hash: str,
    db_path: str | Path | None = None,
) -> None:
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET upload_status = 'FINISH', index_status = 'FINISH', last_error = NULL, updated_at = ?
            WHERE law_id = ? AND version_hash = ?
            """,
            (ts, law_id, version_hash),
        )
        conn.commit()


def update_record_index_timeout(
    *,
    law_id: str,
    version_hash: str,
    message: str,
    db_path: str | Path | None = None,
) -> None:
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET index_status = 'TIMEOUT', last_error = ?, updated_at = ?
            WHERE law_id = ? AND version_hash = ?
              AND upload_status = 'INDEX_SUBMITTED'
            """,
            (message[:4000], ts, law_id, version_hash),
        )
        conn.commit()


def update_record_index_unknown(
    *,
    law_id: str,
    version_hash: str,
    message: str,
    db_path: str | Path | None = None,
) -> None:
    ts = _now()
    init_kb_upload_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            UPDATE kb_upload_records
            SET index_status = 'UNKNOWN', last_error = ?, updated_at = ?
            WHERE law_id = ? AND version_hash = ?
              AND upload_status = 'INDEX_SUBMITTED'
            """,
            (message[:4000], ts, law_id, version_hash),
        )
        conn.commit()


def _as_plain_dict(obj: Any) -> Dict[str, Any]:
    """将 SDK 模型或 dict 转为普通 dict，便于按 key 取值。"""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    to_map = getattr(obj, "to_map", None)
    if callable(to_map):
        try:
            m = to_map()
            if isinstance(m, dict):
                return m
        except Exception:
            pass
    return {}


def _ci_dict_get(d: Mapping[str, Any], *logical_names: str) -> Any:
    """大小写/下划线不敏感读取，如 Data/data、JobId/job_id。"""
    if not isinstance(d, Mapping):
        return None
    targets = {n.lower().replace("_", "") for n in logical_names}
    for k, v in d.items():
        kn = str(k).lower().replace("_", "")
        if kn in targets:
            return v
    return None


def extract_bailian_job_id(payload: Any) -> str:
    """
    从 SubmitIndexAddDocumentsJob / 同类响应中解析索引任务 Id。
    支持：Data.Id、Data.JobId、Data.JobID、Data.job_id、顶层 Id 等；SDK 对象会先 to_map。
    """
    root = _as_plain_dict(payload)
    data_obj = _ci_dict_get(root, "data", "Data")
    data = _as_plain_dict(data_obj)

    for logical in ("id", "jobid", "job_id", "taskid", "task_id"):
        v = _ci_dict_get(data, logical) if data else None
        if v is not None and str(v).strip():
            return str(v).strip()

    for logical in ("id", "jobid", "job_id", "taskid", "task_id"):
        v = _ci_dict_get(root, logical)
        if v is not None and str(v).strip():
            return str(v).strip()

    return ""


def law_name_from_row(master_row: Mapping[str, Any]) -> str:
    for key in ("law_name", "title", "name"):
        v = master_row.get(key)
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


