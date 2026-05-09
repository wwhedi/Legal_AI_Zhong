#!/usr/bin/env python3
"""
上传前知识库导出校验：仅生成 JSON 报告，不修改文件、不上传百炼、不接入爬虫。

用法：
  python scripts/validate_kb_export.py \\
    --master path/to/law_master.jsonl \\
    --export-dir path/to/aliyun_upload/法律 \\
    --output path/to/validate_report.json \\
    --strict

退出码：存在 error 且启用 --strict 时为 1；否则 0。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 项目根目录，便于导入 services.law_chunk_parse
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from services.law_chunk_parse import (  # noqa: E402
    MISSING,
    extract_article_number,
    parse_law_chunk_text,
)

STATUS_ENUM = frozenset({"尚未生效", "有效", "已修改", "已废止"})
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_URL_START = re.compile(r"^https?://", re.I)
_ZW_RE = re.compile(r"[\u200b-\u200f\ufeff]")
_ARTICLE_HEAD_RE = re.compile(r"第[0-9零一二三四五六七八九十百千万〇两]+条")
_CHAPTER_RE = re.compile(r"第[0-9零一二三四五六七八九十百千〇]+章")


def _sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", errors="ignore")).hexdigest()


def _norm_path(p: str) -> str:
    try:
        return str(Path(p).resolve())
    except Exception:
        return p.strip()


def _add_issue(
    errors: List[dict],
    warnings: List[dict],
    *,
    level: str,
    code: str,
    message: str,
    **extra: Any,
) -> None:
    row = {"code": code, "message": message, **extra}
    if level == "error":
        errors.append(row)
    else:
        warnings.append(row)


def validate_master(
    master_path: Path,
    errors: List[dict],
    warnings: List[dict],
) -> Tuple[int, Dict[str, dict], Dict[str, int], Dict[str, int]]:
    """
    校验 law_master.jsonl。
    返回 (行数, bbbs->row 合并用最后一行, bbbs 计数, doc_id 计数)。
    """
    if not master_path.is_file():
        _add_issue(
            errors,
            warnings,
            level="error",
            code="master.file_missing",
            message=f"law_master 不存在: {master_path}",
        )
        return 0, {}, {}, {}

    bbbs_counts: Counter[str] = Counter()
    doc_id_counts: Counter[str] = Counter()
    rows_by_file: Dict[str, dict] = {}
    line_no = 0

    for raw in master_path.read_text(encoding="utf-8").splitlines():
        line_no += 1
        raw = raw.strip()
        if not raw:
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError as e:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.invalid_json",
                message=f"第 {line_no} 行非合法 JSON: {e}",
                line=line_no,
            )
            continue
        if not isinstance(row, dict):
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.not_object",
                message=f"第 {line_no} 行根类型不是对象",
                line=line_no,
            )
            continue

        bbbs = row.get("bbbs")
        if bbbs is None or str(bbbs).strip() == "":
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.missing_bbbs",
                message=f"第 {line_no} 行缺少 bbbs",
                line=line_no,
            )
        else:
            bbbs_counts[str(bbbs).strip()] += 1

        doc_id = row.get("doc_id")
        if doc_id is None or str(doc_id).strip() == "":
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.missing_doc_id",
                message=f"第 {line_no} 行缺少 doc_id",
                line=line_no,
            )
        else:
            doc_id_counts[str(doc_id).strip()] += 1

        title = row.get("title")
        law_name_field = row.get("law_name")
        if (title is None or str(title).strip() == "") and (
            law_name_field is None or str(law_name_field).strip() == ""
        ):
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.missing_title_or_law_name",
                message=f"第 {line_no} 行缺少 title 与 law_name",
                line=line_no,
            )

        if not row.get("detail_url"):
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.missing_detail_url",
                message=f"第 {line_no} 行缺少 detail_url",
                line=line_no,
            )

        uf = row.get("upload_file_path")
        if not uf or not str(uf).strip():
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.missing_upload_file_path",
                message=f"第 {line_no} 行缺少 upload_file_path",
                line=line_no,
            )
        else:
            p = Path(str(uf))
            if not p.is_file():
                _add_issue(
                    errors,
                    warnings,
                    level="error",
                    code="master.upload_file_missing",
                    message=f"upload_file_path 不存在: {uf}",
                    line=line_no,
                    path=str(uf),
                )

        if not row.get("content_sha256"):
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.missing_content_sha256",
                message=f"第 {line_no} 行缺少 content_sha256",
                line=line_no,
            )

        uf_key = _norm_path(str(uf)) if uf else ""
        if uf_key:
            rows_by_file[uf_key] = row

    for bb, c in bbbs_counts.items():
        if c > 1:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.duplicate_bbbs",
                message=f"bbbs 重复出现 {c} 次: {bb}",
                bbbs=bb,
                count=c,
            )

    for did, c in doc_id_counts.items():
        if c > 1:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="master.duplicate_doc_id",
                message=f"doc_id 重复出现 {c} 次: {did}",
                doc_id=did,
                count=c,
            )

    return line_no, rows_by_file, dict(bbbs_counts), dict(doc_id_counts)


def _check_url_contamination(url: str, errors: List[dict], warnings: List[dict], ctx: dict) -> None:
    if not url:
        return
    if "【章节】" in url or "【法规正文】" in url:
        _add_issue(
            errors,
            warnings,
            level="error",
            code="chunk.url_has_marker",
            message="来源链接疑似混入标签文字",
            **ctx,
        )
    if _CHAPTER_RE.search(url) or _ARTICLE_HEAD_RE.search(url):
        _add_issue(
            errors,
            warnings,
            level="error",
            code="chunk.url_has_article_chapter",
            message="来源链接中混入章/条样式文本",
            **ctx,
        )
    # 中文（CJK）出现在 URL 中多为异常（域名除外：简化检测整条）
    if re.search(r"[\u4e00-\u9fff]", url):
        _add_issue(
            errors,
            warnings,
            level="error",
            code="chunk.url_has_cjk",
            message="来源链接中包含中日韩文字符",
            **ctx,
        )
    if " " in url or "\t" in url:
        _add_issue(
            errors,
            warnings,
            level="warning",
            code="chunk.url_has_spaces",
            message="来源链接中包含空格或制表符",
            **ctx,
        )
    if _ZW_RE.search(url):
        _add_issue(
            errors,
            warnings,
            level="error",
            code="chunk.url_has_zwsp",
            message="来源链接中包含零宽字符",
            **ctx,
        )
    if "\n" in url or "\r" in url:
        _add_issue(
            errors,
            warnings,
            level="error",
            code="chunk.url_has_newline",
            message="来源链接中包含换行符",
            **ctx,
        )
    if "id=" in url and re.search(r"id=\s+", url):
        _add_issue(
            errors,
            warnings,
            level="warning",
            code="chunk.url_id_break_space",
            message="来源链接 query 中 id 可能存在断裂空格",
            **ctx,
        )


def _duplicate_article_tokens_in_chapter(chapter: str) -> List[str]:
    """例如「第十八条；第十八条」。"""
    if not chapter or chapter == MISSING:
        return []
    found = _ARTICLE_HEAD_RE.findall(chapter)
    dup: List[str] = []
    seen: set[str] = set()
    for t in found:
        if t in seen:
            dup.append(t)
        seen.add(t)
    return dup


def validate_markdown_file(
    md_path: Path,
    bbbs: Optional[str],
    errors: List[dict],
    warnings: List[dict],
    strict: bool,
    dup_law_article_hash: Dict[Tuple[str, str, str], List[dict]],
    dup_bbbs_article: Dict[Tuple[str, str], List[dict]],
) -> Tuple[int, int]:
    """返回 (总行数, 通过切片数)。通过表示该行未新增 error（可有 warning）。"""
    total_chunks = 0
    passed = 0
    try:
        text = md_path.read_text(encoding="utf-8")
    except OSError as e:
        _add_issue(
            errors,
            warnings,
            level="error",
            code="md.read_error",
            message=str(e),
            file=str(md_path),
        )
        return 0, 0

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for idx, line in enumerate(lines, start=1):
        total_chunks += 1
        line_errors_before = len(errors)

        ctx_base = {"file": str(md_path), "line_in_file": idx}
        if bbbs is not None:
            ctx_base["bbbs"] = bbbs

        if "【来源信息】" not in line:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="chunk.missing_source_block",
                message="行缺少【来源信息】",
                **ctx_base,
            )
        if "【法规正文】" not in line:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="chunk.missing_body_block",
                message="行缺少【法规正文】",
                **ctx_base,
            )

        parsed = parse_law_chunk_text(line)
        law_name = str(parsed.get("law_name") or "").strip()
        if not law_name or law_name == MISSING:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="chunk.empty_law_name",
                message="法规名称为空或未提供",
                **ctx_base,
            )

        law_type = str(parsed.get("law_type") or "").strip()
        if not law_type or law_type == MISSING:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="chunk.empty_law_type",
                message="类型为空或未提供",
                **ctx_base,
            )

        eff = str(parsed.get("effective_status") or "").strip()
        if eff and eff != MISSING:
            if eff not in STATUS_ENUM:
                _add_issue(
                    errors,
                    warnings,
                    level="error",
                    code="chunk.invalid_effective_status",
                    message=f"时效性不在允许枚举内: {eff}",
                    **ctx_base,
                )
            if eff in ("已废止", "已修改"):
                lvl = "error" if strict else "warning"
                _add_issue(
                    errors,
                    warnings,
                    level=lvl,
                    code="chunk.non_active_law_status",
                    message=f"有效库目标下出现非「有效」时效性: {eff}",
                    **ctx_base,
                )

        for label, key in (("公布日期", "publish_date"), ("生效日期", "effective_date")):
            val = str(parsed.get(key) or "").strip()
            if not val or val == MISSING:
                continue
            if not DATE_RE.match(val):
                _add_issue(
                    errors,
                    warnings,
                    level="error",
                    code="chunk.invalid_date",
                    message=f"{label} 格式应为 YYYY-MM-DD 或为空: {val}",
                    **ctx_base,
                )

        url = parsed.get("source_url")
        url_s = str(url).strip() if url else ""
        if url_s:
            if not _URL_START.match(url_s):
                _add_issue(
                    errors,
                    warnings,
                    level="error",
                    code="chunk.invalid_url_scheme",
                    message=f"来源链接非 http/https: {url_s[:80]}",
                    **ctx_base,
                )
            _check_url_contamination(url_s, errors, warnings, ctx_base)
        else:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="chunk.missing_source_url",
                message="来源链接为空",
                **ctx_base,
            )

        chapter = str(parsed.get("chapter") or "").strip()
        if not chapter or chapter == MISSING:
            _add_issue(
                errors,
                warnings,
                level="warning",
                code="chunk.empty_chapter",
                message="章节为空（部分体裁可能合理）",
                **ctx_base,
            )

        body = str(parsed.get("text") or "").strip()
        if not body or body == MISSING:
            _add_issue(
                errors,
                warnings,
                level="error",
                code="chunk.empty_body",
                message="法规正文为空",
                **ctx_base,
            )
        else:
            if "【来源信息】" in body or "http://" in body or "https://" in body:
                _add_issue(
                    errors,
                    warnings,
                    level="error",
                    code="chunk.body_has_source_or_url",
                    message="法规正文疑似混入来源标签或 URL",
                    **ctx_base,
                )

        article_no = extract_article_number(chapter if chapter != MISSING else "", body if body != MISSING else "")
        if article_no == MISSING:
            _add_issue(
                errors,
                warnings,
                level="warning",
                code="chunk.article_not_recognized",
                message="未能识别条号",
                **ctx_base,
            )

        for dup_t in _duplicate_article_tokens_in_chapter(chapter):
            _add_issue(
                errors,
                warnings,
                level="warning",
                code="chunk.duplicate_article_in_chapter",
                message=f"章节字符串中条号重复: {dup_t}",
                **ctx_base,
            )

        law_text_hash = _sha256_text(body) if body and body != MISSING else ""
        key_triple = (law_name or "", article_no if article_no != MISSING else "", law_text_hash)
        dup_law_article_hash.setdefault(key_triple, []).append({**ctx_base})
        bbbs_s = str(bbbs or "").strip()
        if bbbs_s and article_no != MISSING:
            dup_bbbs_article.setdefault((bbbs_s, article_no), []).append({**ctx_base})

        if len(errors) <= line_errors_before:
            passed += 1

    return total_chunks, passed


def _finalize_duplicates(
    dup_law_article_hash: Dict[Tuple[str, str, str], List[dict]],
    dup_bbbs_article: Dict[Tuple[str, str], List[dict]],
    errors: List[dict],
    warnings: List[dict],
) -> None:
    for k, locs in dup_law_article_hash.items():
        if len(locs) < 2:
            continue
        law_name, article_no, h = k
        _add_issue(
            errors,
            warnings,
            level="warning",
            code="duplicate.law_article_hash",
            message=f"重复切片 law_name+article+text_hash 出现 {len(locs)} 次",
            law_name=law_name,
            article_no=article_no,
            text_hash_prefix=h[:16] if h else "",
            locations=locs[:20],
            total=len(locs),
        )
    for k, locs in dup_bbbs_article.items():
        if len(locs) < 2:
            continue
        bbbs, article_no = k
        _add_issue(
            errors,
            warnings,
            level="warning",
            code="duplicate.bbbs_article",
            message=f"重复切片 bbbs+article 出现 {len(locs)} 次",
            bbbs=bbbs,
            article_no=article_no,
            locations=locs[:20],
            total=len(locs),
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 law_master.jsonl 与导出 Markdown，生成 JSON 报告。")
    ap.add_argument("--master", required=True, type=Path, help="law_master.jsonl 路径")
    ap.add_argument("--export-dir", required=True, type=Path, help="导出 Markdown 所在目录")
    ap.add_argument("--output", required=True, type=Path, help="validate_report.json 输出路径")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="若存在 error 级问题则以退出码 1 结束（warning 不单独导致失败）",
    )
    args = ap.parse_args()

    errors: List[dict] = []
    warnings: List[dict] = []

    _lines_read, rows_by_file, _bc, _dc = validate_master(args.master, errors, warnings)

    md_files = sorted(args.export_dir.rglob("*.md")) if args.export_dir.is_dir() else []
    if not args.export_dir.is_dir():
        _add_issue(
            errors,
            warnings,
            level="error",
            code="export_dir.missing",
            message=f"export-dir 不是目录: {args.export_dir}",
        )

    total_chunks = 0
    passed_chunks = 0
    dup_law_article_hash: Dict[Tuple[str, str, str], List[dict]] = {}
    dup_bbbs_article: Dict[Tuple[str, str], List[dict]] = {}

    for md in md_files:
        key = _norm_path(str(md))
        row = rows_by_file.get(key)
        bbbs = str(row["bbbs"]).strip() if row and row.get("bbbs") else None
        tc, pc = validate_markdown_file(
            md,
            bbbs,
            errors,
            warnings,
            args.strict,
            dup_law_article_hash,
            dup_bbbs_article,
        )
        total_chunks += tc
        passed_chunks += pc

    _finalize_duplicates(dup_law_article_hash, dup_bbbs_article, errors, warnings)

    error_count = len(errors)
    warning_count = len(warnings)
    err_type_counter: Counter[str] = Counter(e.get("code", "unknown") for e in errors)
    top_error_types = [list(x) for x in err_type_counter.most_common(20)]

    allow_upload = error_count == 0

    report = {
        "total_files": len(md_files),
        "total_chunks": total_chunks,
        "passed_chunks": passed_chunks,
        "warning_count": warning_count,
        "error_count": error_count,
        "errors": errors,
        "warnings": warnings,
        "top_error_types": top_error_types,
        "allow_upload": allow_upload,
        "strict": args.strict,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.strict and error_count > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
