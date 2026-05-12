#!/usr/bin/env python3
"""
第 7.3 步：按 dry-run 计划受控执行 DeleteIndexDocument（测试用）。
默认仅预览；必须同时 --execute 与 --confirm DELETE_OLD_VERSIONS 且 --allow-index-id 与计划一致才真删。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", encoding="utf-8")
except ImportError:
    pass

from kb_upload_store.bailian_index_documents import (
    _ci_get,
    delete_index_document_call_succeeded,
    delete_index_documents_batch,
)
from kb_upload_store.db import init_kb_upload_db
from kb_upload_store.service import mark_records_deleted_by_bailian_file_ids

CONFIRM_PHRASE = "DELETE_OLD_VERSIONS"


def _collect_remote_ids_from_groups(plan: Dict[str, Any], list_key: str) -> Set[str]:
    out: Set[str] = set()
    for g in plan.get("law_groups") or []:
        for d in g.get(list_key) or []:
            rid = str(d.get("remote_document_id") or "").strip()
            if rid:
                out.add(rid)
    return out


def _flatten_delete_candidates(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    seen: Set[str] = set()
    rows: List[Dict[str, Any]] = []
    for g in plan.get("law_groups") or []:
        for d in g.get("delete_candidates") or []:
            rid = str(d.get("remote_document_id") or "").strip()
            if not rid or rid in seen:
                continue
            seen.add(rid)
            rows.append(dict(d))
    return rows


def _error_detail(norm: Dict[str, Any]) -> str:
    return str(
        _meta_msg(norm)
        or norm.get("Message")
        or norm.get("message")
        or "unknown error"
    )


def _meta_msg(norm: Dict[str, Any]) -> str:
    m = norm.get("_meta") if isinstance(norm.get("_meta"), dict) else {}
    return str(m.get("message") or m.get("code") or "")


def main() -> int:
    ap = argparse.ArgumentParser(description="按 dry-run 计划执行 DeleteIndexDocument（受控）")
    ap.add_argument("--plan", required=True, help="第 7.2 步生成的 JSON 计划路径")
    ap.add_argument("--db-path", default="", help="kb_upload_records 库路径")
    ap.add_argument(
        "--output",
        default=str(ROOT / "data" / "bailian_old_version_delete_execute_report.json"),
        help="执行报告输出路径",
    )
    ap.add_argument("--workspace-id", default=os.getenv("BAILIAN_WORKSPACE_ID", "").strip())
    ap.add_argument("--execute", action="store_true", help="必须指定才真正调用删除 API")
    ap.add_argument("--confirm", default="", help=f'必须精确为 {CONFIRM_PHRASE}')
    ap.add_argument("--allow-index-id", default="", help="必须与计划中的 index_id 一致才允许执行")
    ap.add_argument("--batch-size", type=int, default=10, help="每批 DeleteIndexDocument 文档数")
    args = ap.parse_args()

    plan_path = Path(args.plan)
    if not plan_path.is_file():
        print(f"错误：计划文件不存在：{plan_path}", file=sys.stderr)
        return 2

    raw = plan_path.read_text(encoding="utf-8")
    plan: Dict[str, Any] = json.loads(raw)

    index_id = str(plan.get("index_id") or "").strip()
    wid = str(args.workspace_id or plan.get("workspace_id") or "").strip()
    if not wid:
        print("错误：缺少 workspace_id（--workspace-id 或计划中的 workspace_id 或环境变量）", file=sys.stderr)
        return 2
    if not index_id:
        print("错误：计划中缺少 index_id", file=sys.stderr)
        return 2

    allow = str(args.allow_index_id or "").strip()
    if args.execute and allow != index_id:
        print(
            f"错误：--allow-index-id 必须与计划 index_id 完全一致（计划={index_id!r}，传入={allow!r}）",
            file=sys.stderr,
        )
        return 2

    delete_rows = _flatten_delete_candidates(plan)
    delete_ids = {str(r.get("remote_document_id") or "").strip() for r in delete_rows}

    keep_ids = _collect_remote_ids_from_groups(plan, "keep_documents")
    blocked_ids = _collect_remote_ids_from_groups(plan, "blocked_candidates")

    bad_keep = delete_ids & keep_ids
    bad_block = delete_ids & blocked_ids
    if bad_keep:
        print(f"错误：delete_candidates 与 keep_documents 存在交集（禁止执行）：{sorted(bad_keep)[:20]}", file=sys.stderr)
        return 2
    if bad_block:
        print(f"错误：delete_candidates 与 blocked_candidates 存在交集：{sorted(bad_block)[:20]}", file=sys.stderr)
        return 2

    db_arg = (args.db_path or "").strip()
    db_path = Path(db_arg).resolve() if db_arg else None

    batch_size = max(1, min(int(args.batch_size), 50))
    source_plan = str(plan_path.resolve())

    base_report: Dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "index_id": index_id,
        "execute": bool(args.execute),
        "source_plan_path": source_plan,
        "total_candidates": len(delete_rows),
        "deleted_count": 0,
        "failed_count": 0,
        "skipped_count": 0,
        "deleted_documents": [],
        "failed_documents": [],
        "skipped_documents": [],
    }

    if not args.execute:
        base_report["skipped_count"] = len(delete_rows)
        base_report["skipped_documents"] = [
            {
                "remote_document_id": r.get("remote_document_id"),
                "remote_document_name": r.get("remote_document_name"),
                "reason": "未指定 --execute，仅预览",
            }
            for r in delete_rows
        ]
        _write_output(args.output, base_report)
        print(f"预览模式：未调用 DeleteIndexDocument。报告：{Path(args.output).resolve()}")
        return 0

    if str(args.confirm).strip() != CONFIRM_PHRASE:
        print(f"错误：--confirm 必须为 {CONFIRM_PHRASE}", file=sys.stderr)
        return 2

    init_kb_upload_db(db_path)

    deleted_docs: List[Dict[str, Any]] = []
    failed_docs: List[Dict[str, Any]] = []
    deleted_ids_success: List[str] = []
    batch_results: List[Dict[str, Any]] = []

    def chunk(lst: List[Dict[str, Any]], n: int) -> List[List[Dict[str, Any]]]:
        return [lst[i : i + n] for i in range(0, len(lst), n)]

    batches = chunk(delete_rows, batch_size)
    for bidx, batch in enumerate(batches):
        ids = [str(r.get("remote_document_id") or "").strip() for r in batch]
        ids = [x for x in ids if x]
        names = [str(r.get("remote_document_name") or "") for r in batch]
        print(f"[删除批次 {bidx + 1}/{len(batches)}] document_ids={ids}")
        for i, doc_id in enumerate(ids):
            nm = names[i] if i < len(names) else ""
            print(f"  -> 将删除 remote_document_id={doc_id!r} remote_document_name={nm!r}")

        batch_entry: Dict[str, Any] = {
            "batch_index": bidx,
            "document_ids": list(ids),
            "ok": False,
            "error": None,
            "response_code": None,
        }

        try:
            norm = delete_index_documents_batch(wid, index_id, ids)
        except Exception as e:
            err_s = str(e)
            batch_entry["error"] = err_s
            batch_results.append(batch_entry)
            for r in batch:
                did = str(r.get("remote_document_id") or "").strip()
                failed_docs.append(
                    {
                        "remote_document_id": did,
                        "remote_document_name": r.get("remote_document_name"),
                        "error": err_s,
                    }
                )
            base_report["failed_count"] = len(failed_docs)
            base_report["failed_documents"] = failed_docs
            base_report["deleted_documents"] = deleted_docs
            base_report["deleted_count"] = len(deleted_docs)
            base_report["batch_results"] = batch_results
            _write_output(args.output, base_report)
            print(f"错误：批次 API 异常（已记录，继续后续批次）：{e}", file=sys.stderr)
            continue

        meta = _ci_get(norm, "_meta", "_Meta") or {}
        batch_entry["response_code"] = str(
            _ci_get(norm, "code", "Code") or (meta.get("code") if isinstance(meta, dict) else None) or ""
        ).strip() or None
        if delete_index_document_call_succeeded(norm):
            batch_entry["ok"] = True
            batch_results.append(batch_entry)
            for r in batch:
                did = str(r.get("remote_document_id") or "").strip()
                deleted_docs.append(
                    {
                        "remote_document_id": did,
                        "remote_document_name": r.get("remote_document_name"),
                        "remote_status": r.get("remote_status"),
                    }
                )
                deleted_ids_success.append(did)
        else:
            err = _error_detail(norm)
            batch_entry["error"] = err
            batch_results.append(batch_entry)
            for r in batch:
                did = str(r.get("remote_document_id") or "").strip()
                failed_docs.append(
                    {
                        "remote_document_id": did,
                        "remote_document_name": r.get("remote_document_name"),
                        "error": err,
                    }
                )
            base_report["failed_count"] = len(failed_docs)
            base_report["failed_documents"] = failed_docs
            _write_output(args.output, base_report)
            print(f"错误：DeleteIndexDocument 业务失败（已记录，继续后续批次）：{err}", file=sys.stderr)

        base_report["deleted_count"] = len(deleted_docs)
        base_report["deleted_documents"] = deleted_docs
        base_report["batch_results"] = batch_results
        _write_output(args.output, base_report)

    n_local = 0
    if deleted_ids_success:
        n_local = mark_records_deleted_by_bailian_file_ids(deleted_ids_success, db_path=db_path)

    base_report["deleted_documents"] = deleted_docs
    base_report["deleted_count"] = len(deleted_docs)
    base_report["failed_count"] = len(failed_docs)
    base_report["failed_documents"] = failed_docs
    base_report["skipped_count"] = 0
    base_report["batch_results"] = batch_results
    _write_output(args.output, base_report)
    print(
        f"完成：删除成功 {len(deleted_docs)} 条，失败 {len(failed_docs)} 条，本地 kb_upload_records 更新 {n_local} 行。"
        f" 报告：{Path(args.output).resolve()}"
    )
    return 0 if not failed_docs else 3


def _write_output(path_str: str, data: Dict[str, Any]) -> None:
    p = Path(path_str)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
