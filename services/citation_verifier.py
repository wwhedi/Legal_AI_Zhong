from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set


class CitationVerifier:
    """
    引用校验器：
    1) 从 LLM 回答中提取引用
    2) 与检索上下文进行匹配校验
    3) 为每条引用输出 verified 标记
    """

    # 例如：根据[1]、见[2]
    BRACKET_REF_RE = re.compile(r"\[(\d+)\]")
    # 例如：《民法典》第617条 / 民法典第617条
    LAW_ARTICLE_RE = re.compile(
        r"(?:《(?P<law1>[^》]{1,40})》|(?P<law2>[\u4e00-\u9fa5A-Za-z0-9]{2,40}))?\s*第(?P<article>\d+)\s*条"
    )

    async def verify_citations(
        self,
        llm_answer: str,
        retrieved_contexts: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        参数：
        - llm_answer: LLM 最终回答文本
        - retrieved_contexts: 检索返回上下文列表（通常来自 RAG pipeline）

        返回：
        - 每条引用的校验结果，核心字段包含 verified
        """

        citations = self._extract_citations(llm_answer)
        if not citations:
            return []

        verified_results: List[Dict[str, Any]] = []
        indexed_contexts = self._build_context_index(retrieved_contexts)

        for citation in citations:
            matched = self._match_in_context(citation, indexed_contexts, retrieved_contexts)
            if matched:
                verified_results.append(
                    {
                        **citation,
                        "verified": True,
                        "verify_source": "retrieved_context",
                        "matched_context_id": matched.get("id"),
                    }
                )
                continue

            verified_results.append(
                {
                    **citation,
                    "verified": False,
                    "verify_source": "unverified",
                }
            )

        return verified_results

    def _extract_citations(self, text: str) -> List[Dict[str, Any]]:
        refs: List[Dict[str, Any]] = []
        seen: Set[str] = set()

        for m in self.BRACKET_REF_RE.finditer(text or ""):
            ref_id = m.group(1)
            key = f"bracket:{ref_id}"
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                {
                    "citation_type": "bracket_ref",
                    "raw": m.group(0),
                    "ref_index": int(ref_id),
                }
            )

        for m in self.LAW_ARTICLE_RE.finditer(text or ""):
            law_name = (m.group("law1") or m.group("law2") or "").strip() or None
            article = m.group("article")
            raw = m.group(0).strip()
            key = f"law_article:{law_name or ''}:{article}"
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                {
                    "citation_type": "law_article",
                    "raw": raw,
                    "law_name": law_name,
                    "article_number": article,
                }
            )

        return refs

    def _build_context_index(self, contexts: List[Dict[str, Any]]) -> Dict[str, Any]:
        id_map: Dict[int, Dict[str, Any]] = {}
        article_map: Dict[str, List[Dict[str, Any]]] = {}

        for i, ctx in enumerate(contexts, start=1):
            id_map[i] = ctx
            metadata = ctx.get("metadata", {}) or {}
            article = metadata.get("article_number")
            if article:
                article_key = self._normalize_article_number(str(article))
                article_map.setdefault(article_key, []).append(ctx)

        return {"id_map": id_map, "article_map": article_map}

    def _match_in_context(
        self,
        citation: Dict[str, Any],
        context_index: Dict[str, Any],
        contexts: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        ctype = citation.get("citation_type")

        if ctype == "bracket_ref":
            return context_index["id_map"].get(citation.get("ref_index"))

        if ctype == "law_article":
            target_article = citation.get("article_number")
            if target_article:
                article_key = self._normalize_article_number(str(target_article))
                matched_list = context_index["article_map"].get(article_key, [])
                if citation.get("law_name"):
                    law_name = citation["law_name"]
                    for item in matched_list:
                        meta = item.get("metadata", {}) or {}
                        if law_name in str(meta.get("law_name", "")):
                            return item
                if matched_list:
                    return matched_list[0]

            # 兜底：在文本内做弱匹配
            raw = citation.get("raw", "")
            for ctx in contexts:
                if raw and raw in str(ctx.get("text", "")):
                    return ctx

        return None

    def _normalize_article_number(self, article: str) -> str:
        return re.sub(r"\D+", "", article or "")


__all__ = ["CitationVerifier"]

