from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from agents.legal_qa_agent import legal_qa_graph
from services.aliyun_kb_service import AliyunKBService
from services.reasoning_service import ReasoningService


router = APIRouter(prefix="/qa", tags=["legal-qa"])


class AskQARequest(BaseModel):
    question: str = Field(..., min_length=1)
    user_context: Dict[str, Any] = Field(default_factory=dict)


class AskQAResponse(BaseModel):
    question: str
    intent: Optional[str] = None
    intent_reason: Optional[str] = None
    answer: str
    citations: List[Dict[str, Any]] = Field(default_factory=list)
    verification_details: List[Dict[str, Any]] = Field(default_factory=list)
    agent_debug: Optional[Dict[str, Any]] = None
    answer_needs_human_review: bool = False


class QAPingResponse(BaseModel):
    kb_ok: bool
    kb_message: str
    reasoning_ok: bool
    reasoning_message: str
    agent_app_ok: Optional[bool] = None
    agent_app_message: Optional[str] = None
    agent_app_id: Optional[str] = None


@router.post("/ask", response_model=AskQAResponse)
async def ask_legal_qa(req: AskQARequest) -> AskQAResponse:
    initial_state: Dict[str, Any] = {
        "question": req.question,
        "user_context": req.user_context,
    }
    state = await legal_qa_graph.ainvoke(initial_state)

    return AskQAResponse(
        question=req.question,
        intent=state.get("intent"),
        intent_reason=state.get("intent_reason"),
        answer=state.get("answer") or "未生成回答，请稍后重试。",
        citations=state.get("citations") or [],
        verification_details=state.get("verification_details") or [],
        agent_debug=state.get("agent_debug") if isinstance(state.get("agent_debug"), dict) else None,
        answer_needs_human_review=bool(state.get("answer_needs_human_review", False)),
    )


@router.get("/ping", response_model=QAPingResponse)
async def ping_qa_models() -> QAPingResponse:
    kb = AliyunKBService()
    reasoning = ReasoningService()

    kb_ok = True
    kb_message = "ok"
    try:
        msg = await kb.ping()
        kb_message = msg or "ok"
    except Exception as exc:
        kb_ok = False
        kb_message = str(exc)

    reasoning_ok = True
    reasoning_message = "ok"
    try:
        result = await reasoning.ping()
        reasoning_message = result or "ok"
    except Exception as exc:
        reasoning_ok = False
        reasoning_message = str(exc)

    # Optional: ping Bailian agent application if configured
    agent_app_id = (os.getenv("QA_AGENT_APP_ID") or "").strip()
    agent_app_ok: Optional[bool] = None
    agent_app_message: Optional[str] = None
    if agent_app_id:
        agent_app_ok = True
        agent_app_message = "ok"
        try:
            # Lightweight call to validate app_id + key + network + response shape
            text = await reasoning.generate(
                system_prompt="你是连通性探测助手。",
                user_prompt="请只回复：ok",
                model=f"app:{agent_app_id}",
            )
            agent_app_message = (text or "").strip() or "ok_but_empty"
        except Exception as exc:
            agent_app_ok = False
            agent_app_message = str(exc)

    return QAPingResponse(
        kb_ok=kb_ok,
        kb_message=kb_message,
        reasoning_ok=reasoning_ok,
        reasoning_message=reasoning_message,
        agent_app_ok=agent_app_ok,
        agent_app_message=agent_app_message,
        agent_app_id=agent_app_id or None,
    )


__all__ = ["router"]
