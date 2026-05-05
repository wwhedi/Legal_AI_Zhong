from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

from services.law_chunk_parse import MISSING, effective_status_to_status, extract_article_number

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_KB_REL = "data/dev_law_chunks.json"
_TOP_MATCHED = int(os.getenv("BAILIAN_RERANK_TOP_N", "6"))
_FALLBACK_COUNT = 3


def _resolve_kb_path(raw: str | None) -> Path:
    p = (raw or _DEFAULT_KB_REL).strip() or _DEFAULT_KB_REL
    path = Path(p)
    if not path.is_absolute():
        path = _PROJECT_ROOT / path
    return path


def _norm_score(value: Any) -> float:
    try:
        return max(0.0, min(float(value), 1.0))
    except Exception:
        return 0.0


def _query_tokens(query: str) -> List[str]:
    q = (query or "").strip()
    if not q:
        return []
    parts = [t for t in re.split(r"[\s\u3000]+", q) if t]
    return parts if parts else [q]


def _field_text(chunk: Dict[str, Any], key: str) -> str:
    v = chunk.get(key)
    if v is None:
        return ""
    return str(v).strip()


def _keyword_hit_score(chunk: Dict[str, Any], tokens: List[str]) -> int:
    if not tokens:
        return 0
    blobs = [
        _field_text(chunk, "law_name"),
        _field_text(chunk, "chapter"),
        _field_text(chunk, "article"),
        _field_text(chunk, "text"),
    ]
    joined = "\n".join(blobs)
    score = 0
    for t in tokens:
        if not t:
            continue
        if t in joined:
            score += 1
    return score


def _effective_chunks(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in chunks:
        if not isinstance(item, dict):
            continue
        if _field_text(item, "effective_status") == "有效":
            out.append(item)
    return out


class LocalKBService:
    """
    显式开发模式：从本地 JSON 读取法律切片，用于在无百炼环境时测试 RAG 链路。
    仅当 RAG_BACKEND=local 时应被选用；不做百炼失败后的自动回退。
    """

    def __init__(self) -> None:
        self._path = _resolve_kb_path(os.getenv("LOCAL_KB_PATH"))
        self._chunks = self._load_chunks(self._path)

    def _load_chunks(self, path: Path) -> List[Dict[str, Any]]:
        if not path.is_file():
            raise RuntimeError(f"LOCAL_KB_PATH does not exist or is not a file: {path}")
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid JSON in local KB file {path}: {exc}") from exc
        if not isinstance(data, list):
            raise RuntimeError(f"Local KB JSON root must be an array: {path}")
        logger.info("LocalKBService loaded %s chunks from %s", len(data), path)
        return data

    def _select_records(self, query: str) -> List[Dict[str, Any]]:
        effective = _effective_chunks(self._chunks)
        if not effective:
            return []

        tokens = _query_tokens(query)
        scored: List[Tuple[int, float, int, Dict[str, Any]]] = []
        for i, ch in enumerate(effective):
            hits = _keyword_hit_score(ch, tokens)
            s = _norm_score(ch.get("score"))
            scored.append((hits, s, i, ch))

        any_hit = any(t[0] > 0 for t in scored)
        if any_hit:
            scored.sort(key=lambda t: (-t[0], -t[1], t[2]))
            return [t[3] for t in scored[: max(1, _TOP_MATCHED)]]

        return [ch for _, _, _, ch in sorted(scored, key=lambda t: (-t[1], t[2]))[:_FALLBACK_COUNT]]

    def _chunk_to_citation(self, chunk: Dict[str, Any], ref_id: str) -> Dict[str, Any]:
        law_name = _field_text(chunk, "law_name") or MISSING
        law_type = _field_text(chunk, "law_type") or MISSING
        effective_status = _field_text(chunk, "effective_status") or MISSING
        publish_date = _field_text(chunk, "publish_date") or MISSING
        effective_date = _field_text(chunk, "effective_date") or MISSING
        chapter = _field_text(chunk, "chapter") or MISSING
        text_body = _field_text(chunk, "text") or MISSING
        article = _field_text(chunk, "article") or extract_article_number(chapter, text_body)
        source_raw = chunk.get("source_url")
        source_url: str | None
        if isinstance(source_raw, str) and source_raw.strip():
            source_url = source_raw.strip()
        else:
            source_url = None

        score_f = _norm_score(chunk.get("score"))
        status = effective_status_to_status(effective_status)
        eff_display = effective_status
        status_display = f"【本地测试知识库】时效性：{eff_display}"

        doc_id = str(chunk.get("ref_id") or "").strip() or None

        return {
            "ref_id": ref_id,
            "law_name": law_name,
            "law_type": law_type,
            "effective_status": effective_status,
            "publish_date": publish_date,
            "effective_date": effective_date,
            "chapter": chapter,
            "article": article,
            "text": text_body,
            "source_url": source_url,
            "score": score_f,
            "status": status,
            "status_display": status_display,
            "verified": True,
            "verify_source": "local_kb",
            "doc_id": doc_id,
        }

    def _chunk_to_node(self, chunk: Dict[str, Any]) -> Dict[str, Any]:
        text = _field_text(chunk, "text")
        meta = {
            "law_name": chunk.get("law_name"),
            "law_type": chunk.get("law_type"),
            "effective_status": chunk.get("effective_status"),
            "publish_date": chunk.get("publish_date"),
            "effective_date": chunk.get("effective_date"),
            "chapter": chunk.get("chapter"),
            "article": chunk.get("article"),
            "source_url": chunk.get("source_url"),
            "ref_id": chunk.get("ref_id"),
        }
        return {
            "Text": text,
            "Metadata": meta,
            "Score": _norm_score(chunk.get("score")),
        }

    def _format_context(self, query: str, records: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
        citations: List[Dict[str, Any]] = []
        ref_lines: List[str] = []
        snippets: List[str] = []

        for idx, ch in enumerate(records, start=1):
            text = _field_text(ch, "text")
            if not text:
                continue
            ref_id = f"[{idx}]"
            citation = self._chunk_to_citation(ch, ref_id=ref_id)
            citations.append(citation)
            display_name = str(citation.get("law_name") or "知识库文档").strip()
            ref_lines.append(f"{ref_id} {display_name}")
            snippets.append(f"{ref_id} {text}")

        context = (
            "[本地测试知识库检索背景]\n"
            f"用户问题：{query}\n\n"
            "召回片段（可引用编号）：\n"
            + ("\n".join(snippets) if snippets else "- 暂无可用召回片段。")
        )
        return context, citations, ref_lines

    async def retrieve(self, query: str) -> Dict[str, Any]:
        q = (query or "").strip()
        if not q:
            return {"context": "", "citations": [], "ref_lines": [], "nodes": []}

        records = self._select_records(q)
        context, citations, ref_lines = self._format_context(q, records)
        nodes = [self._chunk_to_node(ch) for ch in records]

        logger.info(
            "LocalKB retrieve: path=%s citations=%s nodes=%s query=%s",
            self._path,
            len(citations),
            len(nodes),
            q[:120] + ("..." if len(q) > 120 else ""),
        )
        return {
            "context": context,
            "citations": citations,
            "ref_lines": ref_lines,
            "nodes": nodes,
        }


__all__ = ["LocalKBService"]
