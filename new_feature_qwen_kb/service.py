from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from copy import deepcopy
from typing import Any, AsyncIterator, Dict, List, Optional

from config.dashscope_config import get_configured_chat_model
from config.legal_prompts import (
    LEGAL_PUBLIC_ANALYSIS_SYSTEM_PROMPT,
    LEGAL_PUBLIC_ANALYSIS_USER_PROMPT_TEMPLATE,
    LEGAL_QUERY_REWRITE_SYSTEM_PROMPT,
    LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE,
    LEGAL_RAG_ANSWER_SYSTEM_PROMPT,
    LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE,
)
from services.aliyun_kb_service import AliyunKBService
from services.local_kb_service import LocalKBService
from services.reasoning_service import ReasoningService

logger = logging.getLogger(__name__)

_MISSING = "未提供"


def _new_request_id() -> str:
    return uuid.uuid4().hex[:12]


def _perf_ms(since: float) -> int:
    return int(round((time.perf_counter() - since) * 1000))


def _log_new_rag_timing(
    request_id: str,
    stage: str,
    *,
    duration_ms: int,
    elapsed_ms: int,
    status: Optional[str] = None,
) -> None:
    extra = f" status={status}" if status else ""
    logger.info(
        "[new-rag timing] request_id=%s stage=%s duration_ms=%s elapsed_ms=%s%s",
        request_id,
        stage,
        duration_ms,
        elapsed_ms,
        extra,
    )


class _RequestClock:
    """单调时钟：request_start 起的 elapsed；各阶段 start/end 的 duration。"""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        self.t0 = time.perf_counter()

    def elapsed_ms(self) -> int:
        return _perf_ms(self.t0)

    def mark(self) -> float:
        return time.perf_counter()


_NO_VALID_ANSWER = "知识库未检索到可用于回答该问题的有效法条，建议人工复核。"


def parse_query_rewrite_result(text: str) -> Dict[str, Any]:
    """
    解析 query 改写模型输出中的 JSON。
    支持外层 ```json ... ``` 代码围栏；从首个 '{' 到最后一个 '}' 截取后 json.loads。
    解析失败时抛出 ValueError（由调用方记录日志并回退检索 query）。
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("query rewrite model returned empty text")

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fenced:
        raw = fenced.group(1).strip()

    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found in query rewrite output")

    blob = raw[start : end + 1]
    try:
        data = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in query rewrite output: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("query rewrite JSON root must be an object")

    return data


def _display_field(value: Any) -> str:
    if value is None:
        return _MISSING
    if isinstance(value, str):
        s = value.strip()
        return s if s else _MISSING
    s = str(value).strip()
    return s if s else _MISSING


def _link_display(citation: Dict[str, Any]) -> str:
    u = citation.get("source_url")
    if u is None:
        return _MISSING
    if isinstance(u, str) and not u.strip():
        return _MISSING
    return str(u).strip()


def _chapter_article_line(citation: Dict[str, Any]) -> str:
    ch = _display_field(citation.get("chapter"))
    ar = _display_field(citation.get("article"))
    if ch == _MISSING and ar == _MISSING:
        return _MISSING
    if ch != _MISSING and ar != _MISSING:
        return f"{ch}；{ar}"
    return ch if ch != _MISSING else ar


def _is_effective_citation(citation: Dict[str, Any]) -> bool:
    return _display_field(citation.get("effective_status")) == "有效"


def _filter_effective_citations(citations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [c for c in citations if isinstance(c, dict) and _is_effective_citation(c)]


def _renumber_citations(citations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i, c in enumerate(citations, start=1):
        row = deepcopy(c)
        row["ref_id"] = f"[{i}]"
        out.append(row)
    return out


def _build_ref_lines_block(citation: Dict[str, Any], index: int) -> str:
    lines = [
        f"[{index}]",
        f"法规名称：{_display_field(citation.get('law_name'))}",
        f"类型：{_display_field(citation.get('law_type'))}",
        f"时效性：{_display_field(citation.get('effective_status'))}",
        f"公布日期：{_display_field(citation.get('publish_date'))}",
        f"生效日期：{_display_field(citation.get('effective_date'))}",
        f"章节/条文：{_chapter_article_line(citation)}",
        f"链接：{_link_display(citation)}",
        f"法规正文：{_display_field(citation.get('text'))}",
    ]
    return "\n".join(lines)


def _build_effective_kb_context(renumbered: List[Dict[str, Any]]) -> str:
    blocks: List[str] = []
    for i, c in enumerate(renumbered, start=1):
        body = _display_field(c.get("text"))
        blocks.append(f"[{i}]\n{body}")
    return "\n\n".join(blocks) if blocks else _MISSING


def _format_retrieval_query_info(
    *,
    original_question: str,
    legal_intent: str,
    core_keywords_line: str,
    search_query_used: str,
    required_filters: Dict[str, Any],
    rewrite_failed: bool,
    empty_search_query_after_parse: bool,
) -> str:
    filters_json = json.dumps(required_filters, ensure_ascii=False)
    lines = [
        f"原始用户问题：{original_question}",
        f"法律意图：{legal_intent}",
        f"核心关键词：{core_keywords_line}",
        f"实际检索语句（search_query）：{search_query_used}",
        f"检索过滤要求（required_filters）：{filters_json}",
    ]
    if rewrite_failed:
        lines.append(
            "说明：query 改写阶段 JSON 解析失败或模型输出无法解析；已记录 warning 并回退使用原始用户问题作为检索语句。"
        )
    elif empty_search_query_after_parse:
        lines.append(
            "说明：query 改写 JSON 已解析，但 search_query 为空；已记录 warning 并回退使用原始用户问题作为检索语句。"
        )
    return "\n".join(lines)


def _iso_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stream_event(
    *,
    etype: str,
    stage: str,
    title: str,
    message: str,
    data: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    return {
        "type": etype,
        "stage": stage,
        "title": title,
        "message": message,
        "data": data or {},
        "timestamp": _iso_timestamp(),
    }


def _timing_stream_payload(
    *,
    request_id: str,
    stage: str,
    message: str,
    duration_ms: int,
    elapsed_ms: int,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "request_id": request_id,
        "elapsed_ms": elapsed_ms,
        "duration_ms": duration_ms,
    }
    if status:
        data["status"] = status
    return _stream_event(
        etype="timing",
        stage=stage,
        title="耗时统计",
        message=message,
        data=data,
    )


def _emit_timing_event(
    clk: _RequestClock,
    request_id: str,
    stage: str,
    message: str,
    duration_ms: int,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    elapsed_ms = clk.elapsed_ms()
    _log_new_rag_timing(
        request_id,
        stage,
        duration_ms=duration_ms,
        elapsed_ms=elapsed_ms,
        status=status,
    )
    return _timing_stream_payload(
        request_id=request_id,
        stage=stage,
        message=message,
        duration_ms=duration_ms,
        elapsed_ms=elapsed_ms,
        status=status,
    )


def _rewrite_summary_data(qr: Dict[str, Any]) -> Dict[str, Any]:
    """供 ask-stream 展示：仅检索识别相关字段，不含用户原问长文。"""
    ck = qr.get("core_keywords")
    core_keywords = ck if isinstance(ck, list) else []
    lc = qr.get("legal_concepts")
    legal_concepts = lc if isinstance(lc, list) else []
    qv = qr.get("query_variants")
    query_variants = qv if isinstance(qv, list) else []
    rf = qr.get("required_filters")
    required_filters: Dict[str, Any] = rf if isinstance(rf, dict) else {"effective_status": "有效"}
    return {
        "legal_intent": str(qr.get("legal_intent") or "").strip(),
        "core_keywords": [str(x).strip() for x in core_keywords if str(x).strip()],
        "legal_concepts": [str(x).strip() for x in legal_concepts if str(x).strip()],
        "search_query": str(qr.get("search_query") or "").strip(),
        "query_variants": [str(x).strip() for x in query_variants if str(x).strip()],
        "required_filters": required_filters,
    }


def _citation_summary_row(c: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ref_id": c.get("ref_id"),
        "law_name": c.get("law_name"),
        "chapter": c.get("chapter"),
        "article": c.get("article"),
        "effective_status": c.get("effective_status"),
        "publish_date": c.get("publish_date"),
        "effective_date": c.get("effective_date"),
        "source_url": c.get("source_url"),
        "score": c.get("score"),
    }


def _kb_service_from_env():
    """
    RAG 知识库后端（显式选择，无自动 fallback）：
    - 未设置或空：bailian
    - bailian：阿里云百炼
    - local：本地 JSON 开发测试库
    """
    raw = os.getenv("RAG_BACKEND")
    backend = (raw or "bailian").strip().lower()
    if backend == "bailian":
        return AliyunKBService()
    if backend == "local":
        return LocalKBService()
    raise RuntimeError(
        f"Invalid RAG_BACKEND={raw!r} (normalized={backend!r}); expected 'bailian' or 'local'."
    )


class QwenKBRagService:
    """
    Standalone RAG service:
    1) Query rewrite（关键词 / 检索语句）
    2) Retrieve from KB（RAG_BACKEND=bailian 为百炼，RAG_BACKEND=local 为本地 JSON）
    3) Generate answer with Qwen model
    """

    def __init__(self) -> None:
        self.kb = _kb_service_from_env()
        self.reasoning = ReasoningService()
        self.model_name = get_configured_chat_model()

    async def ask(self, question: str) -> Dict[str, Any]:
        request_id = _new_request_id()
        clk = _RequestClock(request_id)
        _log_new_rag_timing(
            request_id,
            "request_start",
            duration_ms=0,
            elapsed_ms=0,
        )

        q = (question or "").strip()
        if not q:
            _log_new_rag_timing(
                request_id,
                "request_done",
                duration_ms=0,
                elapsed_ms=clk.elapsed_ms(),
                status="validation_error",
            )
            raise ValueError("question is required")

        _log_new_rag_timing(
            request_id,
            "query_rewrite_start",
            duration_ms=0,
            elapsed_ms=clk.elapsed_ms(),
        )
        qr_seg = clk.mark()
        rewrite_failed = False
        qr: Dict[str, Any] = {}
        try:
            rewrite_user = LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE.replace("{question}", q)
            rewrite_out = await self.reasoning.generate(
                system_prompt=LEGAL_QUERY_REWRITE_SYSTEM_PROMPT,
                user_prompt=rewrite_user,
                model=self.model_name,
            )
            qr = parse_query_rewrite_result(rewrite_out)
        except Exception as exc:
            rewrite_failed = True
            logger.warning(
                "new_rag query rewrite failed; falling back to original question as search_query. error=%s",
                exc,
                exc_info=True,
            )
            qr = {}

        _log_new_rag_timing(
            request_id,
            "query_rewrite_end",
            duration_ms=_perf_ms(qr_seg),
            elapsed_ms=clk.elapsed_ms(),
        )

        sq_raw = str(qr.get("search_query") or "").strip()
        empty_search_query_after_parse = bool(qr) and not sq_raw
        if empty_search_query_after_parse:
            logger.warning(
                "new_rag query rewrite returned empty search_query after successful JSON parse; "
                "using original question as search_query. keys=%s",
                list(qr.keys()),
            )

        search_query = sq_raw if sq_raw else q

        _log_new_rag_timing(
            request_id,
            "kb_retrieve_start",
            duration_ms=0,
            elapsed_ms=clk.elapsed_ms(),
        )
        kb_seg = clk.mark()
        kb_payload = await self.kb.retrieve(search_query)
        kb_context = str(kb_payload.get("context") or "").strip()
        citations = [item for item in (kb_payload.get("citations") or []) if isinstance(item, dict)]
        _log_new_rag_timing(
            request_id,
            "kb_retrieve_end",
            duration_ms=_perf_ms(kb_seg),
            elapsed_ms=clk.elapsed_ms(),
        )

        legal_intent = str(qr.get("legal_intent") or "").strip() or _MISSING
        ck = qr.get("core_keywords")
        if isinstance(ck, list):
            core_keywords_line = ", ".join(str(x).strip() for x in ck if str(x).strip()) or _MISSING
        else:
            core_keywords_line = _MISSING

        rf = qr.get("required_filters")
        required_filters: Dict[str, Any] = rf if isinstance(rf, dict) else {"effective_status": "有效"}

        retrieval_query_info = _format_retrieval_query_info(
            original_question=q,
            legal_intent=legal_intent,
            core_keywords_line=core_keywords_line,
            search_query_used=search_query,
            required_filters=required_filters,
            rewrite_failed=rewrite_failed,
            empty_search_query_after_parse=empty_search_query_after_parse,
        )

        if not kb_context:
            for st in (
                "filter_start",
                "filter_end",
                "analysis_start",
                "analysis_first_delta",
                "analysis_done",
                "answer_generation_start",
                "answer_first_delta",
                "answer_done",
            ):
                _log_new_rag_timing(
                    request_id,
                    st,
                    duration_ms=0,
                    elapsed_ms=clk.elapsed_ms(),
                    status="skipped",
                )
            _log_new_rag_timing(
                request_id,
                "request_done",
                duration_ms=0,
                elapsed_ms=clk.elapsed_ms(),
            )
            return {
                "answer": "知识库未检索到有效内容，请尝试更具体的问题。",
                "citations": citations,
                "model": self.model_name,
                "retrieved_count": len(citations),
            }

        _log_new_rag_timing(
            request_id,
            "filter_start",
            duration_ms=0,
            elapsed_ms=clk.elapsed_ms(),
        )
        fl_seg = clk.mark()
        effective_only = _filter_effective_citations(citations)
        _log_new_rag_timing(
            request_id,
            "filter_end",
            duration_ms=_perf_ms(fl_seg),
            elapsed_ms=clk.elapsed_ms(),
        )

        if not effective_only:
            for st in (
                "analysis_start",
                "analysis_first_delta",
                "analysis_done",
                "answer_generation_start",
                "answer_first_delta",
                "answer_done",
            ):
                _log_new_rag_timing(
                    request_id,
                    st,
                    duration_ms=0,
                    elapsed_ms=clk.elapsed_ms(),
                    status="skipped",
                )
            _log_new_rag_timing(
                request_id,
                "request_done",
                duration_ms=0,
                elapsed_ms=clk.elapsed_ms(),
            )
            return {
                "answer": _NO_VALID_ANSWER,
                "citations": [],
                "model": self.model_name,
                "retrieved_count": 0,
            }

        for st in ("analysis_start", "analysis_first_delta", "analysis_done"):
            _log_new_rag_timing(
                request_id,
                st,
                duration_ms=0,
                elapsed_ms=clk.elapsed_ms(),
                status="skipped",
            )

        _log_new_rag_timing(
            request_id,
            "answer_generation_start",
            duration_ms=0,
            elapsed_ms=clk.elapsed_ms(),
        )
        renumbered = _renumber_citations(effective_only)
        ref_blocks = [_build_ref_lines_block(c, i) for i, c in enumerate(renumbered, start=1)]
        ref_lines_str = "\n\n".join(ref_blocks)
        kb_context_for_prompt = _build_effective_kb_context(renumbered)

        tpl = LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE
        user_prompt = (
            tpl.replace("{retrieval_query_info}", retrieval_query_info)
            .replace("{kb_context}", kb_context_for_prompt)
            .replace("{ref_lines}", ref_lines_str)
            .replace("{question}", q)
        )

        ans_seg = clk.mark()
        answer = await self.reasoning.generate(
            system_prompt=LEGAL_RAG_ANSWER_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            model=self.model_name,
        )
        dur_ans = _perf_ms(ans_seg)
        _log_new_rag_timing(
            request_id,
            "answer_first_delta",
            duration_ms=0,
            elapsed_ms=clk.elapsed_ms(),
            status="skipped",
        )
        _log_new_rag_timing(
            request_id,
            "answer_done",
            duration_ms=dur_ans,
            elapsed_ms=clk.elapsed_ms(),
        )
        _log_new_rag_timing(
            request_id,
            "request_done",
            duration_ms=0,
            elapsed_ms=clk.elapsed_ms(),
        )
        return {
            "answer": answer,
            "citations": renumbered,
            "model": self.model_name,
            "retrieved_count": len(renumbered),
        }

    async def ask_events(self, question: str) -> AsyncIterator[Dict[str, Any]]:
        """
        与 ask() 相同处理链路，按阶段 yield NDJSON 事件（聚焦检索与依据分析，不含 prompt、密钥、思维链）。
        """
        request_id = _new_request_id()
        clk = _RequestClock(request_id)

        async def _timing_skipped_tail(*, from_stage: str) -> AsyncIterator[Dict[str, Any]]:
            tail = (
                "kb_retrieve_start",
                "kb_retrieve_end",
                "filter_start",
                "filter_end",
                "analysis_start",
                "analysis_first_delta",
                "analysis_done",
                "answer_generation_start",
                "answer_first_delta",
                "answer_done",
                "request_done",
            )
            started = False
            for st in tail:
                if st == from_stage:
                    started = True
                    continue
                if started:
                    yield _emit_timing_event(clk, request_id, st, "skipped", 0, status="skipped")

        try:
            yield _emit_timing_event(clk, request_id, "request_start", "request received", 0)

            q = (question or "").strip()
            if not q:
                for st in (
                    "query_rewrite_start",
                    "query_rewrite_end",
                    "kb_retrieve_start",
                    "kb_retrieve_end",
                    "filter_start",
                    "filter_end",
                    "analysis_start",
                    "analysis_first_delta",
                    "analysis_done",
                    "answer_generation_start",
                    "answer_first_delta",
                    "answer_done",
                ):
                    yield _emit_timing_event(clk, request_id, st, "skipped (empty question)", 0, status="skipped")
                yield _emit_timing_event(
                    clk, request_id, "request_done", "request finished", 0, status="validation_error"
                )
                yield _stream_event(
                    etype="error",
                    stage="error",
                    title="处理失败",
                    message="问题不能为空。",
                    data={},
                )
                return

            yield _emit_timing_event(clk, request_id, "query_rewrite_start", "query rewrite started", 0)

            rewrite_failed = False
            qr: Dict[str, Any] = {}
            qr_seg = clk.mark()
            try:
                rewrite_user = LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE.replace("{question}", q)
                rewrite_out = await self.reasoning.generate(
                    system_prompt=LEGAL_QUERY_REWRITE_SYSTEM_PROMPT,
                    user_prompt=rewrite_user,
                    model=self.model_name,
                )
                qr = parse_query_rewrite_result(rewrite_out)
            except Exception as exc:
                rewrite_failed = True
                logger.warning(
                    "new_rag stream query rewrite failed; falling back to original question as search_query. error=%s",
                    exc,
                    exc_info=True,
                )
                qr = {}

            yield _emit_timing_event(
                clk,
                request_id,
                "query_rewrite_end",
                "query rewrite completed",
                _perf_ms(qr_seg),
            )

            sq_raw = str(qr.get("search_query") or "").strip()
            empty_search_query_after_parse = bool(qr) and not sq_raw
            if empty_search_query_after_parse:
                logger.warning(
                    "new_rag stream query rewrite returned empty search_query after successful JSON parse; "
                    "using original question as search_query. keys=%s",
                    list(qr.keys()),
                )

            search_query = sq_raw if sq_raw else q

            yield _stream_event(
                etype="progress",
                stage="query_rewrite_done",
                title="检索问题识别",
                message="已生成知识库检索关键词与检索语句。",
                data=_rewrite_summary_data(qr),
            )

            yield _emit_timing_event(clk, request_id, "kb_retrieve_start", "knowledge base retrieve started", 0)
            kb_seg = clk.mark()
            kb_payload = await self.kb.retrieve(search_query)
            kb_context = str(kb_payload.get("context") or "").strip()
            citations = [item for item in (kb_payload.get("citations") or []) if isinstance(item, dict)]
            yield _emit_timing_event(
                clk,
                request_id,
                "kb_retrieve_end",
                "knowledge base retrieve completed",
                _perf_ms(kb_seg),
            )

            yield _stream_event(
                etype="retrieval",
                stage="kb_retrieve_done",
                title="知识库检索结果",
                message="已从知识库检索到相关法条片段。",
                data={
                    "retrieved_count": len(citations),
                    "citations_summary": [_citation_summary_row(c) for c in citations],
                },
            )

            yield _emit_timing_event(clk, request_id, "filter_start", "effective citation filter started", 0)
            fl_seg = clk.mark()
            effective_only = _filter_effective_citations(citations)
            removed_count = max(0, len(citations) - len(effective_only))
            yield _emit_timing_event(
                clk,
                request_id,
                "filter_end",
                "effective citation filter completed",
                _perf_ms(fl_seg),
            )

            yield _stream_event(
                etype="retrieval",
                stage="effective_filter_done",
                title="有效法条筛选",
                message="已保留时效性为有效的法条。",
                data={
                    "effective_count": len(effective_only),
                    "removed_count": removed_count,
                },
            )

            legal_intent = str(qr.get("legal_intent") or "").strip() or _MISSING
            ck = qr.get("core_keywords")
            if isinstance(ck, list):
                core_keywords_line = ", ".join(str(x).strip() for x in ck if str(x).strip()) or _MISSING
            else:
                core_keywords_line = _MISSING

            rf = qr.get("required_filters")
            required_filters: Dict[str, Any] = rf if isinstance(rf, dict) else {"effective_status": "有效"}

            retrieval_query_info = _format_retrieval_query_info(
                original_question=q,
                legal_intent=legal_intent,
                core_keywords_line=core_keywords_line,
                search_query_used=search_query,
                required_filters=required_filters,
                rewrite_failed=rewrite_failed,
                empty_search_query_after_parse=empty_search_query_after_parse,
            )

            if not kb_context:
                for st in (
                    "analysis_start",
                    "analysis_first_delta",
                    "analysis_done",
                ):
                    yield _emit_timing_event(clk, request_id, st, "skipped (no kb context)", 0, status="skipped")
                out = {
                    "answer": "知识库未检索到有效内容，请尝试更具体的问题。",
                    "citations": citations,
                    "model": self.model_name,
                    "retrieved_count": len(citations),
                }
                yield _emit_timing_event(clk, request_id, "answer_generation_start", "answer section started", 0)
                yield _stream_event(
                    etype="progress",
                    stage="answer_generation_start",
                    title="正式回答生成中",
                    message="正在生成结论、依据、风险点和建议。",
                    data={},
                )
                yield _emit_timing_event(
                    clk,
                    request_id,
                    "answer_first_delta",
                    "no streaming answer (fixed response)",
                    0,
                    status="skipped",
                )
                yield _emit_timing_event(clk, request_id, "answer_done", "non-stream answer ready", 0)
                yield _stream_event(
                    etype="answer",
                    stage="answer_generation_done",
                    title="回答生成完成",
                    message="",
                    data={
                        "question": q,
                        "answer": out["answer"],
                        "model": out["model"],
                        "retrieved_count": out["retrieved_count"],
                        "citations": out["citations"],
                    },
                )
                yield _emit_timing_event(clk, request_id, "request_done", "request completed", 0)
                yield _stream_event(etype="done", stage="done", title="完成", message="", data={})
                return

            if not effective_only:
                for st in (
                    "analysis_start",
                    "analysis_first_delta",
                    "analysis_done",
                ):
                    yield _emit_timing_event(clk, request_id, st, "skipped (no effective citations)", 0, status="skipped")
                out = {
                    "answer": _NO_VALID_ANSWER,
                    "citations": [],
                    "model": self.model_name,
                    "retrieved_count": 0,
                }
                yield _emit_timing_event(clk, request_id, "answer_generation_start", "answer section started", 0)
                yield _stream_event(
                    etype="progress",
                    stage="answer_generation_start",
                    title="正式回答生成中",
                    message="正在生成结论、依据、风险点和建议。",
                    data={},
                )
                yield _emit_timing_event(
                    clk,
                    request_id,
                    "answer_first_delta",
                    "no streaming answer (fixed response)",
                    0,
                    status="skipped",
                )
                yield _emit_timing_event(clk, request_id, "answer_done", "non-stream answer ready", 0)
                yield _stream_event(
                    etype="answer",
                    stage="answer_generation_done",
                    title="回答生成完成",
                    message="",
                    data={
                        "question": q,
                        "answer": out["answer"],
                        "model": out["model"],
                        "retrieved_count": out["retrieved_count"],
                        "citations": out["citations"],
                    },
                )
                yield _emit_timing_event(clk, request_id, "request_done", "request completed", 0)
                yield _stream_event(etype="done", stage="done", title="完成", message="", data={})
                return

            renumbered = _renumber_citations(effective_only)
            ref_blocks = [_build_ref_lines_block(c, i) for i, c in enumerate(renumbered, start=1)]
            ref_lines_str = "\n\n".join(ref_blocks)
            kb_context_for_prompt = _build_effective_kb_context(renumbered)

            yield _emit_timing_event(clk, request_id, "analysis_start", "public basis analysis started", 0)
            yield _stream_event(
                etype="progress",
                stage="analysis_start",
                title="依据分析生成中",
                message="正在分析法条与用户问题之间的对应关系。",
                data={},
            )

            public_analysis_buf: List[str] = []
            analysis_loop_start = clk.mark()
            analysis_first_delta_seen = False
            try:
                public_user = LEGAL_PUBLIC_ANALYSIS_USER_PROMPT_TEMPLATE.format(
                    question=q,
                    retrieval_query_info=retrieval_query_info,
                    ref_lines=ref_lines_str,
                    kb_context=kb_context_for_prompt,
                )
                async for delta in self.reasoning.generate_stream(
                    system_prompt=LEGAL_PUBLIC_ANALYSIS_SYSTEM_PROMPT,
                    user_prompt=public_user,
                    model=self.model_name,
                ):
                    if not delta:
                        continue
                    if not analysis_first_delta_seen:
                        yield _emit_timing_event(
                            clk,
                            request_id,
                            "analysis_first_delta",
                            "first analysis token",
                            _perf_ms(analysis_loop_start),
                        )
                        analysis_first_delta_seen = True
                    public_analysis_buf.append(delta)
                    yield _stream_event(
                        etype="analysis_delta",
                        stage="analysis_delta",
                        title="依据分析生成中",
                        message="",
                        data={"delta": delta},
                    )
            except Exception:
                logger.exception("new_rag ask_events public basis analysis failed")
                yield _emit_timing_event(
                    clk,
                    request_id,
                    "analysis_done",
                    "analysis stream failed",
                    _perf_ms(analysis_loop_start),
                    status="error",
                )
                async for ev in _timing_skipped_tail(from_stage="analysis_done"):
                    yield ev
                yield _stream_event(
                    etype="error",
                    stage="error",
                    title="处理失败",
                    message="依据分析生成失败，请稍后重试。",
                    data={},
                )
                return

            if not analysis_first_delta_seen:
                yield _emit_timing_event(
                    clk,
                    request_id,
                    "analysis_first_delta",
                    "no analysis tokens",
                    0,
                    status="skipped",
                )

            yield _emit_timing_event(
                clk,
                request_id,
                "analysis_done",
                "public basis analysis completed",
                _perf_ms(analysis_loop_start),
            )

            public_analysis = "".join(public_analysis_buf).strip()
            yield _stream_event(
                etype="analysis",
                stage="analysis_done",
                title="依据分析",
                message="已完成基于有效法条的公开依据分析。",
                data={"analysis": public_analysis},
            )

            tpl = LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE
            user_prompt = (
                tpl.replace("{retrieval_query_info}", retrieval_query_info)
                .replace("{kb_context}", kb_context_for_prompt)
                .replace("{ref_lines}", ref_lines_str)
                .replace("{question}", q)
            )

            yield _emit_timing_event(clk, request_id, "answer_generation_start", "final answer generation started", 0)
            yield _stream_event(
                etype="progress",
                stage="answer_generation_start",
                title="正式回答生成中",
                message="正在生成结论、依据、风险点和建议。",
                data={},
            )

            answer_buf: List[str] = []
            answer_loop_start = clk.mark()
            answer_first_delta_seen = False
            try:
                async for delta in self.reasoning.generate_stream(
                    system_prompt=LEGAL_RAG_ANSWER_SYSTEM_PROMPT,
                    user_prompt=user_prompt,
                    model=self.model_name,
                ):
                    if not delta:
                        continue
                    if not answer_first_delta_seen:
                        yield _emit_timing_event(
                            clk,
                            request_id,
                            "answer_first_delta",
                            "first answer token",
                            _perf_ms(answer_loop_start),
                        )
                        answer_first_delta_seen = True
                    answer_buf.append(delta)
                    yield _stream_event(
                        etype="answer_delta",
                        stage="answer_delta",
                        title="回答生成中",
                        message="",
                        data={"delta": delta},
                    )
            except Exception:
                logger.exception("new_rag ask_events answer generation failed")
                yield _emit_timing_event(
                    clk,
                    request_id,
                    "answer_done",
                    "answer stream failed",
                    _perf_ms(answer_loop_start),
                    status="error",
                )
                yield _emit_timing_event(clk, request_id, "request_done", "request ended with error", 0, status="error")
                yield _stream_event(
                    etype="error",
                    stage="error",
                    title="处理失败",
                    message="正式回答生成失败，请稍后重试。",
                    data={},
                )
                return

            if not answer_first_delta_seen:
                yield _emit_timing_event(
                    clk,
                    request_id,
                    "answer_first_delta",
                    "no answer tokens",
                    0,
                    status="skipped",
                )

            yield _emit_timing_event(
                clk,
                request_id,
                "answer_done",
                "final answer stream completed",
                _perf_ms(answer_loop_start),
            )

            answer = "".join(answer_buf).strip()
            out = {
                "answer": answer,
                "citations": renumbered,
                "model": self.model_name,
                "retrieved_count": len(renumbered),
            }
            yield _stream_event(
                etype="answer",
                stage="answer_generation_done",
                title="回答生成完成",
                message="",
                data={
                    "question": q,
                    "answer": out["answer"],
                    "model": out["model"],
                    "retrieved_count": out["retrieved_count"],
                    "citations": out["citations"],
                },
            )
            yield _emit_timing_event(clk, request_id, "request_done", "request completed", 0)
            yield _stream_event(etype="done", stage="done", title="完成", message="", data={})

        except Exception:
            logger.exception("new_rag ask_events failed")
            yield _emit_timing_event(clk, request_id, "request_done", "request failed", 0, status="error")
            yield _stream_event(
                etype="error",
                stage="error",
                title="处理失败",
                message="请求处理失败，请稍后重试或更换问题。",
                data={},
            )


__all__ = ["QwenKBRagService", "parse_query_rewrite_result"]
