from __future__ import annotations

from typing import Any, Dict, List

from mcp.server.fastmcp import FastMCP

from services.citation_verifier import CitationVerifier
from services.farui_service import FaruiLegalService


mcp = FastMCP("legal-ai-mcp")


@mcp.tool()
async def search_regulations(query: str, top_k: int = 10) -> Dict[str, Any]:
    """
    检索相关法规条文。
    """

    top_k = max(1, min(top_k, 50))
    farui = FaruiLegalService()
    context = await farui.search_legal_context(query)
    results = [
        {
            "id": "farui_context",
            "text": context,
            "metadata": {"source": "farui"},
            "source": "farui",
            "score": 1.0,
        }
    ]
    return {
        "query": query,
        "top_k": top_k,
        "results": results,
    }


@mcp.tool()
async def check_clause_compliance(
    clause_text: str,
    references: str = "",
    top_k: int = 12,
) -> Dict[str, Any]:
    """
    对单条合同条款进行合规性快速检查：
    1) 召回相关法规；
    2) 校验条款中显式引用是否可在上下文/知识库中验证。
    """

    top_k = max(1, min(top_k, 50))
    farui = FaruiLegalService()
    verifier = CitationVerifier()

    # 将条款正文与可选引用串联，提升召回准确度
    query = clause_text if not references.strip() else f"{clause_text}\n引用:{references}"
    context_text = await farui.search_legal_context(query)
    contexts = [
        {
            "id": "farui_context",
            "text": context_text,
            "metadata": {"source": "farui"},
            "source": "farui",
            "score": 1.0,
        }
    ]

    answer_like_text = f"{clause_text}\n{references}".strip()
    citation_checks = await verifier.verify_citations(
        llm_answer=answer_like_text,
        retrieved_contexts=contexts,
    )

    has_unverified = any(not item.get("verified", False) for item in citation_checks)
    risk_level = "medium" if has_unverified else "low"
    if any(k in clause_text for k in ("免责", "无限责任", "单方解除", "自动续约")):
        risk_level = "high"

    compliance_summary = {
        "risk_level": risk_level,
        "has_unverified_citations": has_unverified,
        "advice": (
            "建议法务复核未验证引用，并确认条款是否与最新有效法条一致。"
            if has_unverified
            else "未发现明显引用失配，建议继续进行人工语义审查。"
        ),
    }

    return {
        "input": {
            "clause_text": clause_text,
            "references": references,
            "top_k": top_k,
        },
        "compliance_summary": compliance_summary,
        "citation_checks": citation_checks,
        "retrieved_contexts": contexts,
    }


def main() -> None:
    # 启动 MCP over SSE
    mcp.run(transport="sse")


if __name__ == "__main__":
    main()

