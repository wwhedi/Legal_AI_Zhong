#!/usr/bin/env python3
"""
第 7.2 步：旧版本下线 dry-run 删除预览。
只读 ListIndexDocuments + 本地 kb_upload_records，生成 JSON；不调用 DeleteIndexDocument。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", encoding="utf-8")
except ImportError:
    pass

from kb_upload_store.bailian_index_documents import list_all_index_documents, plan_old_version_delete_dry_run
from kb_upload_store.db import init_kb_upload_db
from kb_upload_store.service import fetch_kb_upload_records_as_dicts


def main() -> int:
    ap = argparse.ArgumentParser(description="旧版本下线 dry-run（不删除、不写库）")
    ap.add_argument("--db-path", default="", help="默认 LEGAL_KB_STRUCTURED_DB / data/legal_kb_structured.db")
    ap.add_argument("--workspace-id", default=os.getenv("BAILIAN_WORKSPACE_ID", "").strip())
    ap.add_argument("--index-id", default=os.getenv("BAILIAN_INDEX_ID", "").strip())
    ap.add_argument(
        "--output",
        default=str(ROOT / "data" / "bailian_old_version_delete_dry_run.json"),
        help="dry-run JSON 输出路径",
    )
    ap.add_argument("--keep-latest", type=int, default=1, help="每 law_id 保留本地 FINISH 最新记录条数（1 或 2）")
    ap.add_argument(
        "--scope",
        choices=("managed-only",),
        default="managed-only",
        help="仅分析本地 kb_upload_records 中出现的 law_id（默认 managed-only）",
    )
    ap.add_argument("--limit", type=int, default=0, help="ListIndexDocuments 最多拉取条数，0 表示不限制")
    ap.add_argument("--page-size", type=int, default=50, help="分页大小")
    ap.add_argument(
        "--no-dry-run",
        action="store_true",
        help="若指定则退出（未实现真实删除，仅支持 dry-run 报告）",
    )
    args = ap.parse_args()

    if args.no_dry_run:
        print("错误：当前仅支持 dry-run；未实现真实删除。", file=sys.stderr)
        return 2

    workspace_id = (args.workspace_id or "").strip()
    index_id = (args.index_id or "").strip()
    if not workspace_id:
        print("错误：缺少 BAILIAN_WORKSPACE_ID", file=sys.stderr)
        return 2
    if not index_id:
        print("错误：缺少 BAILIAN_INDEX_ID", file=sys.stderr)
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

    if args.scope != "managed-only":
        print("错误：仅支持 --scope managed-only", file=sys.stderr)
        return 2

    plan = plan_old_version_delete_dry_run(
        local_rows,
        remote_docs,
        keep_latest=args.keep_latest,
        managed_only=True,
    )

    report = {
        "workspace_id": workspace_id,
        "index_id": index_id,
        "total_remote_documents": len(remote_docs),
        "total_local_records": len(local_rows),
        "total_remote_total_count_reported": list_meta.get("total_count_reported"),
        "list_fetch_meta": {k: v for k, v in list_meta.items() if k != "total_count_reported"},
        **plan,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"dry-run 报告：{out_path.resolve()}")
    print(
        f"managed law 数={report['managed_law_count']}，"
        f"删除候选={report['delete_candidate_count']}，"
        f"blocked={report['blocked_candidate_count']}，"
        f"保留={report['keep_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
