from __future__ import annotations

import asyncio
import atexit
import os
from typing import Any, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from services.aliyun_kb_service import AliyunKBService


class ContractReviewState(TypedDict, total=False):
    contract_id: str
    contract_text: str
    user_goal: str

    plan: str
    extracted_clauses: List[Dict[str, Any]]
    cross_clause_dependencies: List[Dict[str, Any]]

    regulation_candidates: List[Dict[str, Any]]
    risk_assessment: Dict[str, Any]

    critique_passed: bool
    critique_notes: List[str]
    retry_count: int
    critique_route: Literal["search", "assess", "done"]

    has_high_risk: bool
    human_decision: Optional[Dict[str, Any]]
    report: Dict[str, Any]


def orchestrator_plan(state: ContractReviewState) -> ContractReviewState:
    contract_text = state.get("contract_text", "")
    user_goal = state.get("user_goal", "审查合同风险并给出修订建议")
    plan = (
        "1) 抽取核心条款与义务边界；"
        "2) 识别跨条款依赖（例外、限制、前置条件）；"
        "3) 检索法规并匹配；"
        "4) 风险评估与修订建议。\n"
        f"输入长度={len(contract_text)}，目标={user_goal}"
    )
    return {"plan": plan, "retry_count": state.get("retry_count", 0)}


def extract_clauses(state: ContractReviewState) -> ContractReviewState:
    text = state.get("contract_text", "")

    # 骨架实现：后续可替换为 LLM + 规则混合抽取
    clause_candidates = [seg.strip() for seg in text.split("\n") if seg.strip()]
    extracted = [
        {
            "clause_id": f"C{i+1}",
            "text": seg,
            "type": "general",
        }
        for i, seg in enumerate(clause_candidates[:30])
    ]

    dependencies: List[Dict[str, Any]] = []
    for i, clause in enumerate(extracted):
        ctext = clause["text"]
        if any(key in ctext for key in ("除外", "例外", "但", "除非", "不得", "限制")) and i > 0:
            dependencies.append(
                {
                    "from_clause_id": clause["clause_id"],
                    "to_clause_id": extracted[i - 1]["clause_id"],
                    "relation": "exception_or_limitation",
                    "evidence": ctext,
                }
            )

    return {
        "extracted_clauses": extracted,
        "cross_clause_dependencies": dependencies,
    }


def search_regulations(state: ContractReviewState) -> ContractReviewState:
    clauses = state.get("extracted_clauses", [])
    if not clauses:
        return {"regulation_candidates": []}

    kb = AliyunKBService()
    query = "；".join(item.get("text", "") for item in clauses[:5])
    try:
        payload = asyncio.run(kb.retrieve(query))
        context = str(payload.get("context") or "")
    except Exception:
        context = ""
    if not context:
        return {"regulation_candidates": []}
    return {
        "regulation_candidates": [
            {
                "id": "kb_context",
                "text": context,
                "metadata": {"source": "aliyun_kb"},
                "source": "aliyun_kb",
                "score": 1.0,
            }
        ]
    }


def assess_risks(state: ContractReviewState) -> ContractReviewState:
    clauses = state.get("extracted_clauses", [])
    regs = state.get("regulation_candidates", [])
    deps = state.get("cross_clause_dependencies", [])

    high_risk_items: List[Dict[str, Any]] = []
    medium_risk_items: List[Dict[str, Any]] = []

    for clause in clauses:
        text = clause.get("text", "")
        if any(k in text for k in ("单方解除", "免责", "无限责任", "自动续约")):
            high_risk_items.append(
                {
                    "clause_id": clause.get("clause_id"),
                    "reason": "包含高风险责任或权利失衡表达",
                    "suggestion": "补充限制条件、责任上限与触发边界",
                }
            )
        elif any(k in text for k in ("应当", "可以", "通知", "违约")):
            medium_risk_items.append(
                {
                    "clause_id": clause.get("clause_id"),
                    "reason": "义务或违约条款表述可能不完整",
                    "suggestion": "明确时限、责任主体与救济路径",
                }
            )

    assessment = {
        "summary": "合同风险评估（骨架结果）",
        "high_risks": high_risk_items,
        "medium_risks": medium_risk_items,
        "regulation_match_count": len(regs),
        "cross_dependency_count": len(deps),
    }
    return {
        "risk_assessment": assessment,
        "has_high_risk": len(high_risk_items) > 0,
    }


def critique_check(state: ContractReviewState) -> ContractReviewState:
    """
    交叉验证：
    - 条款抽取是否覆盖关键风险点
    - 条款逻辑与引用法条是否一致
    - 不严密时按重试次数（最多 2 次）选择打回 search 或 assess
    """

    retry = state.get("retry_count", 0)
    notes: List[str] = []

    clauses = state.get("extracted_clauses", [])
    regs = state.get("regulation_candidates", [])
    assessment = state.get("risk_assessment", {})
    dep_count = len(state.get("cross_clause_dependencies", []))

    if not clauses:
        notes.append("未抽取到条款，无法完成审查。")
    if not regs:
        notes.append("未命中法规候选，法条支撑不足。")
    if dep_count == 0:
        notes.append("未识别到跨条款依赖，需复查例外/限制条件。")
    if not assessment:
        notes.append("缺少风险评估结果。")

    critique_passed = len(notes) == 0
    route: Literal["search", "assess", "done"] = "done"

    if not critique_passed:
        retry += 1
        # 最多 2 次重试：第一次优先补检索，第二次优先补评估，之后放行并附告警
        if retry == 1:
            route = "search"
        elif retry == 2:
            route = "assess"
        else:
            critique_passed = True
            notes.append("达到最大重试次数，流程继续并标记人工重点复核。")
            route = "done"

    return {
        "critique_passed": critique_passed,
        "critique_notes": notes,
        "retry_count": retry,
        "critique_route": route,
    }


def _route_after_critique(state: ContractReviewState) -> str:
    route = state.get("critique_route", "done")
    if route == "search":
        return "search_regulations"
    if route == "assess":
        return "assess_risks"
    return "human_review_gate"


def human_review_gate(state: ContractReviewState) -> ContractReviewState:
    """
    高风险条款触发人工审核闸门：
    - 有高风险 -> interrupt 挂起，等待人工输入
    - 无高风险 -> 直接放行到 END
    """

    if state.get("has_high_risk", False):
        decision = interrupt(
            {
                "type": "human_review_required",
                "reason": "检测到高风险条款，需人工确认后继续。",
                "risk_assessment": state.get("risk_assessment", {}),
                "critique_notes": state.get("critique_notes", []),
            }
        )
        return {"human_decision": decision}
    return {"human_decision": {"approved": True, "message": "no_high_risk_auto_pass"}}


def _route_after_human_review(state: ContractReviewState) -> str:
    decision = state.get("human_decision") or {}
    approved = bool(decision.get("approved", False))
    # 人工驳回或要求重审时，打回风险评估节点
    return "generate_report" if approved else "assess_risks"


def generate_report(state: ContractReviewState) -> ContractReviewState:
    assessment = state.get("risk_assessment", {})
    decision = state.get("human_decision", {})
    report = {
        "summary": "合同审查报告（骨架）",
        "risk_assessment": assessment,
        "critique_notes": state.get("critique_notes", []),
        "human_decision": decision,
        "final_recommendation": (
            "通过（建议按审查意见修订后签署）"
            if decision.get("approved", False)
            else "需进一步修订后重新评估"
        ),
    }
    return {"report": report}


def _build_checkpointer():
    """
    优先 PostgresSaver，失败时降级 SqliteSaver。
    """

    global _CHECKPOINTER_CM

    postgres_dsn = os.getenv("LANGGRAPH_POSTGRES_DSN")
    if postgres_dsn:
        try:
            from langgraph.checkpoint.postgres import PostgresSaver

            _CHECKPOINTER_CM = PostgresSaver.from_conn_string(postgres_dsn)
            return _CHECKPOINTER_CM.__enter__()
        except Exception:
            pass

    sqlite_path = os.getenv("LANGGRAPH_SQLITE_PATH", "langgraph_review.db")
    from langgraph.checkpoint.sqlite import SqliteSaver

    # langgraph's SqliteSaver expects a sqlite3 file path (not a sqlite:/// URL).
    _CHECKPOINTER_CM = SqliteSaver.from_conn_string(sqlite_path)
    return _CHECKPOINTER_CM.__enter__()


_CHECKPOINTER_CM = None


def _close_checkpointer() -> None:
    global _CHECKPOINTER_CM
    if _CHECKPOINTER_CM is None:
        return
    try:
        _CHECKPOINTER_CM.__exit__(None, None, None)
    finally:
        _CHECKPOINTER_CM = None


atexit.register(_close_checkpointer)


def build_contract_review_graph():
    graph = StateGraph(ContractReviewState)

    graph.add_node("orchestrator_plan", orchestrator_plan)
    graph.add_node("extract_clauses", extract_clauses)
    graph.add_node("search_regulations", search_regulations)
    graph.add_node("assess_risks", assess_risks)
    graph.add_node("critique_check", critique_check)
    graph.add_node("human_review_gate", human_review_gate)
    graph.add_node("generate_report", generate_report)

    graph.add_edge(START, "orchestrator_plan")
    graph.add_edge("orchestrator_plan", "extract_clauses")
    graph.add_edge("extract_clauses", "search_regulations")
    graph.add_edge("search_regulations", "assess_risks")
    graph.add_edge("assess_risks", "critique_check")

    graph.add_conditional_edges(
        "critique_check",
        _route_after_critique,
        {
            "search_regulations": "search_regulations",
            "assess_risks": "assess_risks",
            "human_review_gate": "human_review_gate",
        },
    )
    graph.add_conditional_edges(
        "human_review_gate",
        _route_after_human_review,
        {
            "generate_report": "generate_report",
            "assess_risks": "assess_risks",
        },
    )
    graph.add_edge("generate_report", END)
    return graph.compile(checkpointer=_build_checkpointer())


contract_review_graph = build_contract_review_graph()


__all__ = [
    "ContractReviewState",
    "build_contract_review_graph",
    "contract_review_graph",
    "orchestrator_plan",
    "extract_clauses",
    "search_regulations",
    "assess_risks",
    "critique_check",
    "human_review_gate",
    "generate_report",
]

