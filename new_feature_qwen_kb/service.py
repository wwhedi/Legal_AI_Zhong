from __future__ import annotations

import os
from typing import Any, Dict, List

from services.aliyun_kb_service import AliyunKBService
from services.reasoning_service import ReasoningService


class QwenKBRagService:
    """
    Standalone RAG service:
    1) Retrieve from Aliyun KB for every question.
    2) Generate answer with Qwen model.
    """

    def __init__(self) -> None:
        self.kb = AliyunKBService()
        self.reasoning = ReasoningService()
        self.model_name = os.getenv("NEW_QWEN_MODEL_NAME", os.getenv("REASONING_MODEL_NAME", "qwen-plus"))

    async def ask(self, question: str) -> Dict[str, Any]:
        q = (question or "").strip()
        if not q:
            raise ValueError("question is required")

        kb_payload = await self.kb.retrieve(q)
        kb_context = str(kb_payload.get("context") or "").strip()
        citations = [item for item in (kb_payload.get("citations") or []) if isinstance(item, dict)]

        if not kb_context:
            return {
                "answer": "知识库未检索到有效内容，请尝试更具体的问题。",
                "citations": citations,
                "model": self.model_name,
                "retrieved_count": len(citations),
            }

        ref_lines: List[str] = []
        for idx, item in enumerate(citations[:8], start=1):
            law_name = str(item.get("law_name") or "知识库文档").strip()
            article = str(item.get("article") or "KB").strip()
            ref_lines.append(f"[{idx}] {law_name}（{article}）")

        system_prompt = (
            "你是一名专业法律助手。"
            "你必须优先依据提供的知识库内容作答，不得编造法规。"
            "输出结构：1) 结论 2) 依据 3) 建议。"
            "若依据不足，明确告知“信息不足，建议人工复核”。"
        )
        user_prompt = (
            f"用户问题：{q}\n\n"
            "知识库检索结果：\n"
            f"{kb_context}\n\n"
            "可引用来源：\n"
            + ("\n".join(ref_lines) if ref_lines else "- 无")
        )

        answer = await self.reasoning.generate(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            model=self.model_name,
        )
        return {
            "answer": answer,
            "citations": citations,
            "model": self.model_name,
            "retrieved_count": len(citations),
        }
