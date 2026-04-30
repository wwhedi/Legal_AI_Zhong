from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agents.contract_review_graph import contract_review_graph


router = APIRouter(prefix="/review", tags=["contract-review"])


class ReviewSubmitRequest(BaseModel):
    contract_id: str | None = None
    contract_text: str = Field(..., min_length=1)
    user_goal: str = "审查合同风险并给出修订建议"


class ReviewApproveRequest(BaseModel):
    approved: bool
    comment: str | None = None
    action: Literal["approve", "revise"] | None = None


class ReviewStatusResponse(BaseModel):
    thread_id: str
    status: Literal["not_found", "waiting_human_review", "in_progress", "completed"]
    waiting_human_review: bool = False
    interrupt_payload: Optional[Dict[str, Any]] = None
    risk_assessment: Dict[str, Any] = Field(default_factory=dict)
    report: Optional[Dict[str, Any]] = None
    critique_notes: list[str] = Field(default_factory=list)


async def _run_stream(initial_input: Dict[str, Any] | None, thread_id: str) -> list[Dict[str, Any]]:
    config = {"configurable": {"thread_id": thread_id}}

    def _collect() -> list[Dict[str, Any]]:
        return list(contract_review_graph.stream(initial_input, config=config))

    return await asyncio.to_thread(_collect)


@router.post("/submit")
async def submit_review(req: ReviewSubmitRequest) -> Dict[str, Any]:
    thread_id = f"review_{uuid.uuid4().hex[:12]}"
    initial_state = {
        "contract_id": req.contract_id or thread_id,
        "contract_text": req.contract_text,
        "user_goal": req.user_goal,
    }

    events = await _run_stream(initial_state, thread_id=thread_id)
    state_snapshot = await asyncio.to_thread(
        contract_review_graph.get_state, {"configurable": {"thread_id": thread_id}}
    )
    state_values = getattr(state_snapshot, "values", {}) or {}
    waiting_human = bool(state_values.get("has_high_risk", False)) and not bool(
        state_values.get("report")
    )

    return {
        "thread_id": thread_id,
        "status": "waiting_human_review" if waiting_human else "completed",
        "event_count": len(events),
        "risk_assessment": state_values.get("risk_assessment", {}),
        "interrupt_payload": state_values.get("human_decision"),
    }


@router.get("/status/{thread_id}", response_model=ReviewStatusResponse)
async def get_review_status(thread_id: str) -> ReviewStatusResponse:
    """
    前端轮询状态接口：
    - waiting_human_review: 已触发 human_review_gate interrupt，等待人工审批
    - completed: 已生成 report
    - in_progress: 流程存在但未完成且未到人工闸门
    """

    config = {"configurable": {"thread_id": thread_id}}
    state_snapshot = await asyncio.to_thread(contract_review_graph.get_state, config)
    state_values = getattr(state_snapshot, "values", None)
    if not state_values:
        return ReviewStatusResponse(thread_id=thread_id, status="not_found")

    values: Dict[str, Any] = state_values or {}
    report = values.get("report")
    human_decision = values.get("human_decision")
    has_high_risk = bool(values.get("has_high_risk", False))

    waiting_human = False
    interrupt_payload: Optional[Dict[str, Any]] = None
    if isinstance(human_decision, dict) and human_decision.get("type") == "human_review_required":
        waiting_human = True
        interrupt_payload = human_decision
    elif has_high_risk and not report and not human_decision:
        # 兼容：若中断载荷未被序列化回填，也视为等待人工审核
        waiting_human = True

    if report:
        status: Literal["waiting_human_review", "in_progress", "completed"] = "completed"
    elif waiting_human:
        status = "waiting_human_review"
    else:
        status = "in_progress"

    return ReviewStatusResponse(
        thread_id=thread_id,
        status=status,
        waiting_human_review=waiting_human,
        interrupt_payload=interrupt_payload,
        risk_assessment=values.get("risk_assessment", {}) or {},
        report=report,
        critique_notes=values.get("critique_notes", []) or [],
    )


@router.post("/approve/{thread_id}")
async def approve_review(thread_id: str, req: ReviewApproveRequest) -> Dict[str, Any]:
    config = {"configurable": {"thread_id": thread_id}}
    state_snapshot = await asyncio.to_thread(contract_review_graph.get_state, config)
    if not getattr(state_snapshot, "values", None):
        raise HTTPException(status_code=404, detail="thread_id not found")

    human_decision = {
        "approved": req.approved,
        "comment": req.comment,
        "action": req.action or ("approve" if req.approved else "revise"),
    }

    await asyncio.to_thread(
        contract_review_graph.update_state,
        config,
        {"human_decision": human_decision},
    )

    # 从 interrupt 点恢复执行
    events = await _run_stream(None, thread_id=thread_id)
    latest_state = await asyncio.to_thread(contract_review_graph.get_state, config)
    values = getattr(latest_state, "values", {}) or {}

    return {
        "thread_id": thread_id,
        "status": "completed" if values.get("report") else "in_progress",
        "event_count": len(events),
        "report": values.get("report"),
        "risk_assessment": values.get("risk_assessment", {}),
    }


@router.get("/stat")
async def review_stat() -> Dict[str, Any]:
    # 轻量占位统计：真实统计可接 PostgreSQL 审核表
    return {
        "service": "contract-review",
        "graph_checkpointer": "enabled",
        "note": "当前为基础统计接口，后续可接入持久化审计指标。",
    }

