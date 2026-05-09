#!/usr/bin/env python3
"""
只读审计：调用百炼 ListIndexDocuments，与本地 kb_upload_records 尝试建立映射。
不调用 DeleteIndexDocument；不上传、不 Submit、不修改数据库。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", encoding="utf-8")
except ImportError:
    pass

from kb_upload_store.bailian_index_documents import (
    compute_document_matches,
    list_all_index_documents,
)
from kb_upload_store.db import init_kb_upload_db
from kb_upload_store.service import fetch_kb_upload_records_as_dicts


def main() -> int:
    ap = argparse.ArgumentParser(description="ListIndexDocuments 映射审计（只读）")
    ap.add_argument("--workspace-id", default=os.getenv("BAILIAN_WORKSPACE_ID", "").strip(), help="默认读环境变量")
    ap.add_argument("--index-id", default=os.getenv("BAILIAN_INDEX_ID", "").strip(), help="默认读环境变量")
    ap.add_argument(
        "--db-path",
        default="",
        help="kb_upload_records 库路径；默认 LEGAL_KB_STRUCTURED_DB 或 data/legal_kb_structured.db",
    )
    ap.add_argument(
        "--output",
        default=str(ROOT / "data" / "bailian_index_documents_audit.json"),
        help="JSON 报告输出路径",
    )
    ap.add_argument("--limit", type=int, default=0, help="最多拉取的远端文档条数（0 表示不限制）")
    ap.add_argument("--page-size", type=int, default=50, help="ListIndexDocuments 每页大小")
    args = ap.parse_args()

    workspace_id = (args.workspace_id or "").strip()
    index_id = (args.index_id or "").strip()
    if not workspace_id:
        print("错误：缺少 BAILIAN_WORKSPACE_ID（参数 --workspace-id 或环境变量）", file=sys.stderr)
        return 2
    if not index_id:
        print("错误：缺少 BAILIAN_INDEX_ID（参数 --index-id 或环境变量）", file=sys.stderr)
        return 2

    db_arg = (args.db_path or "").strip()
    db_path = Path(db_arg).resolve() if db_arg else None
    init_kb_upload_db(db_path)

    local_rows = fetch_kb_upload_records_as_dicts(db_path=db_path)

    max_docs = args.limit if args.limit and args.limit > 0 else None
    page_size = max(1, min(args.page_size, 500))

    try:
        remote_docs, list_meta = list_all_index_documents(
            workspace_id,
            index_id,
            page_size=page_size,
            max_documents=max_docs,
        )
    except RuntimeError as e:
        print(f"错误：{e}", file=sys.stderr)
        return 3

    matches, unmatched_remote_idx, unmatched_local_ids = compute_document_matches(local_rows, remote_docs)

    unmatched_remote_docs = [
        {
            "remote_document_id": remote_docs[i].get("remote_document_id"),
            "remote_document_name": remote_docs[i].get("remote_document_name"),
            "remote_source_id": remote_docs[i].get("remote_source_id"),
            "remote_status": remote_docs[i].get("remote_status"),
        }
        for i in unmatched_remote_idx[:200]
    ]

    sample_local_ids = unmatched_local_ids[:200]
    local_by_id = {str(r.get("id")): r for r in local_rows}
    unmatched_local_detail = [local_by_id.get(lid, {"id": lid}) for lid in sample_local_ids]

    reported_total = list_meta.get("total_count_reported")

    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "workspace_id": workspace_id,
        "index_id": index_id,
        "total_remote_documents": len(remote_docs),
        "total_remote_total_count_reported": reported_total,
        "list_meta": {k: v for k, v in list_meta.items() if k != "total_count_reported"},
        "total_local_records": len(local_rows),
        "matched_count": len(matches),
        "unmatched_remote_count": len(unmatched_remote_idx),
        "unmatched_local_count": len(unmatched_local_ids),
        "matches": matches,
        "unmatched_remote_documents_sample": unmatched_remote_docs,
        "unmatched_local_records_sample": unmatched_local_detail,
        "note": "只读审计；未调用 DeleteIndexDocument；未修改 kb_upload_records",
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"报告已写入：{out_path.resolve()}")
    print(
        f"远端文档：{len(remote_docs)}，本地记录：{len(local_rows)}，"
        f"匹配：{len(matches)}，未匹配远端：{len(unmatched_remote_idx)}，未匹配本地：{len(unmatched_local_ids)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
