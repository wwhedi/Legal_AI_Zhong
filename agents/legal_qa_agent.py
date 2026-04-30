from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from services.aliyun_kb_service import AliyunKBService
from services.reasoning_service import ReasoningService


logger = logging.getLogger(__name__)


LegalIntent = Literal[
    "PRECISE_LOOKUP",
    "CONCEPT_EXPLAIN",
    "COMPLIANCE_CHECK",
    "PROCEDURE_GUIDE",
    "UNKNOWN",
]


class LegalQAState(TypedDict, total=False):
    question: str
    user_context: Dict[str, Any]

    intent: LegalIntent
    intent_reason: str

    kb_context: str
    kb_citations: List[Dict[str, Any]]
    kb_error: str
    answer: str
    citations: List[Dict[str, Any]]
    verification_details: List[Dict[str, Any]]
    answer_needs_human_review: bool


async def classify_intent(state: LegalQAState) -> LegalQAState:
    await asyncio.sleep(0)
    q = (state.get("question") or "").strip()

    # 轻量规则分流，后续可替换为 LLM 分类器
    if any(k in q for k in ("第", "条", "法条", "依据", "哪一条", "具体规定")):
        intent: LegalIntent = "PRECISE_LOOKUP"
        reason = "问题包含法条定位信号词。"
    elif any(k in q for k in ("是什么", "含义", "区别", "概念", "如何理解")):
        intent = "CONCEPT_EXPLAIN"
        reason = "问题偏向概念解释。"
    elif any(k in q for k in ("合规", "是否违法", "风险", "处罚", "责任")):
        intent = "COMPLIANCE_CHECK"
        reason = "问题偏向合规与责任判断。"
    elif any(k in q for k in ("流程", "步骤", "怎么办理", "如何申请", "程序")):
        intent = "PROCEDURE_GUIDE"
        reason = "问题偏向程序性指引。"
    else:
        intent = "UNKNOWN"
        reason = "未命中明确意图特征。"

    return {"intent": intent, "intent_reason": reason}


async def retrieve_knowledge(state: LegalQAState) -> LegalQAState:
    question = state.get("question", "")
    user_context = state.get("user_context") or {}
    agent_app_id = str(user_context.get("agent_app_id") or "").strip()
    disable_retrieve = os.getenv("QA_DISABLE_RETRIEVE", "").strip().lower() in ("1", "true", "yes")
    require_agent_app = os.getenv("QA_REQUIRE_AGENT_APP", "").strip().lower() in ("1", "true", "yes")

    # If the request is routed to a Bailian agent application, it may already have a KB toolchain
    # configured in the app. In that case we skip external Retrieve API to avoid double-retrieval.
    if agent_app_id or disable_retrieve:
        return {
            "kb_context": "",
            "kb_citations": [],
            "kb_error": "skipped_external_retrieve",
        }

    if require_agent_app:
        return {
            "kb_context": "",
            "kb_citations": [],
            "kb_error": "agent_app_required",
        }

    kb = AliyunKBService()

    kb_context = ""
    kb_citations: List[Dict[str, Any]] = []
    kb_error = ""
    try:
        kb_payload = await kb.retrieve(question)
        kb_context = str(kb_payload.get("context") or "")
        kb_citations = [item for item in (kb_payload.get("citations") or []) if isinstance(item, dict)]
    except Exception as exc:
        kb_error = str(exc)
        logger.exception("Aliyun KB retrieve failed.")

    return {
        "kb_context": kb_context,
        "kb_citations": kb_citations,
        "kb_error": kb_error,
    }


async def generate_answer(state: LegalQAState) -> LegalQAState:
    question = state.get("question", "")
    intent = state.get("intent", "UNKNOWN")
    kb_context = (state.get("kb_context") or "").strip()
    kb_citations = state.get("kb_citations") or []
    user_context = state.get("user_context") or {}
    kb_error = (state.get("kb_error") or "").strip()

    agent_app_id = str(user_context.get("agent_app_id") or "").strip()
    model_override = f"app:{agent_app_id}" if agent_app_id else None
    disable_retrieve = os.getenv("QA_DISABLE_RETRIEVE", "").strip().lower() in ("1", "true", "yes")
    require_agent_app = os.getenv("QA_REQUIRE_AGENT_APP", "").strip().lower() in ("1", "true", "yes")

    if require_agent_app and not agent_app_id:
        return {
            "answer": "当前服务已配置为仅允许调用智能体应用。请在请求中提供 user_context.agent_app_id。",
            "citations": [],
            "verification_details": [
                {
                    "raw": "backend_debug",
                    "used_agent_app": False,
                    "disable_retrieve": disable_retrieve,
                    "require_agent_app": True,
                    "kb_error": kb_error or "missing_agent_app_id",
                }
            ],
            "answer_needs_human_review": True,
        }

    # When NOT using agent app, KB context is required before calling the model.
    # When using agent app, we rely on the app's integrated KB/toolchain.
    if not kb_context and not agent_app_id and not disable_retrieve:
        return {
            "answer": "未获取到可用法律背景，建议补充问题上下文后重试。",
            "citations": [],
            "verification_details": [
                {
                    "raw": "backend_debug",
                    "kb_error": kb_error or "empty_kb_context",
                    "used_agent_app": False,
                    "disable_retrieve": False,
                }
            ],
        }

    # Direct-model path (no external retrieval). Caller can set REASONING_MODEL_NAME or pass agent_app_id.
    if disable_retrieve and not agent_app_id:
        if require_agent_app:
            return {
                "answer": "当前服务已配置为仅允许调用智能体应用（agent_app_id 必填）。",
                "citations": [],
                "verification_details": [
                    {
                        "raw": "backend_debug",
                        "used_agent_app": False,
                        "disable_retrieve": True,
                        "require_agent_app": True,
                        "kb_error": kb_error,
                    }
                ],
                "answer_needs_human_review": True,
            }
        reasoning = ReasoningService()
        system_prompt = (
            "你是企业法律问答助手。"
            "直接基于你的知识与常识回答用户问题；若涉及具体法条，请明确说明仅供参考并建议复核。"
        )
        user_prompt = f"用户问题: {question}\n\n请输出：\n1) 简明结论\n2) 关键依据点\n3) 实务建议"
        try:
            answer = await reasoning.generate(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=None,
            )
        except Exception as exc:
            err_msg = str(exc).strip() or repr(exc)
            return {
                "answer": f"模型调用失败：{err_msg}",
                "citations": [],
                "verification_details": [
                    {
                        "raw": "backend_debug",
                        "kb_error": kb_error,
                        "used_agent_app": False,
                        "disable_retrieve": True,
                        "model": reasoning.model_name,
                        "error": err_msg,
                    }
                ],
                "answer_needs_human_review": True,
            }
        return {
            "answer": answer,
            "citations": [],
            "verification_details": [
                {
                    "raw": "backend_debug",
                    "kb_error": kb_error,
                    "used_agent_app": False,
                    "disable_retrieve": True,
                    "model": reasoning.model_name,
                }
            ],
            "answer_needs_human_review": False,
        }

    # Agent-app path: always call the app, do not depend on external retrieve/citations.
    if agent_app_id:
        reasoning = ReasoningService()
        system_prompt = (
            "你是企业法律问答助手。"
            "请优先使用你已接入的知识库/工具进行检索与核验，再给出回答。"
            "若无法找到依据，请明确说明不确定性与建议补充的事实。"
        )
        user_prompt = (
            f"问题意图: {intent}\n"
            f"用户问题: {question}\n\n"
            "请输出：\n"
            "1) 简明结论\n"
            "2) 依据说明（若可提供出处/条款编号请列出）\n"
            "3) 实务建议\n"
        )
        try:
            answer = await reasoning.generate(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=model_override,
            )
        except Exception as exc:
            err_msg = str(exc).strip() or repr(exc)
            return {
                "answer": (
                    "智能体应用调用失败，请检查后端日志与智能体 APP 配置。\n"
                    f"错误信息：{err_msg}"
                ),
                "citations": [],
                "verification_details": [
                    {
                        "raw": "backend_debug",
                        "kb_error": kb_error,
                        "used_agent_app": True,
                        "agent_app_id": agent_app_id,
                        "model": model_override,
                        "error": err_msg,
                        "disable_retrieve": disable_retrieve,
                    }
                ],
                "answer_needs_human_review": True,
            }

        return {
            "answer": answer,
            "citations": [],
            "verification_details": [
                {
                    "raw": "backend_debug",
                    "kb_error": kb_error,
                    "used_agent_app": True,
                    "agent_app_id": agent_app_id,
                    "model": model_override,
                    "disable_retrieve": disable_retrieve,
                }
            ],
            "answer_needs_human_review": False,
        }

    citations: List[Dict[str, Any]] = []
    ref_lines: List[str] = []
    for idx, item in enumerate(kb_citations[:6], start=1):
        if not isinstance(item, dict):
            continue
        ref_id = f"[{idx}]"
        law_name = str(item.get("law_name") or "知识库文档").strip()
        article = str(item.get("article") or "KB").strip()
        citations.append(
            {
                "ref_id": ref_id,
                "law_name": law_name,
                "article": article,
                "status": str(item.get("status") or "valid"),
                "status_display": str(item.get("status_display") or "【阿里云知识库】"),
                "score": float(item.get("score") or 0.0),
                "verified": bool(item.get("verified", True)),
                "verify_source": str(item.get("verify_source") or "kb_retrieved"),
            }
        )
        ref_lines.append(f"{ref_id} {law_name}（{article}）")

    # Evidence gate: no legal references, no legal conclusion.
    if not citations:
        return {
            "answer": (
                "未检索到可引用的法条依据，当前不输出法律结论。\n"
                "请更换或细化检索问题后重试。"
            ),
            "citations": [],
            "verification_details": [],
            "answer_needs_human_review": True,
        }

    reasoning = ReasoningService()
    system_prompt = (
        "你是企业法律问答助手。回答必须严格基于给定法律背景，不得编造法条。"
        "每条结论后都必须添加至少一个法规引用编号（如 [1]、[2]）。"
        "若无法引用法规编号，请明确写“无法给出法律结论”。"
    )
    user_prompt = (
        f"问题意图: {intent}\n"
        f"用户问题: {question}\n\n"
        "知识库背景:\n"
        + kb_context
        + "\n\n可用法规引用编号：\n"
        + "\n".join(ref_lines)
        + "\n\n请输出：\n1) 简明结论（每条结论后必须附 [n]）\n2) 法律依据（按 [n] 展开）\n3) 实务建议（涉及法律判断时附 [n]）"
    )

    try:
        answer = await reasoning.generate(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            model=model_override,
        )
    except Exception:
        answer = (
            "根据知识库检索到的背景，暂时无法稳定生成最终答复。\n"
            "- 建议稍后重试。\n"
            "- 如用于正式法律意见，请由法务人工复核。"
        )

    answer += "\n\n法律依据参考：\n" + "\n".join(ref_lines)

    return {
        "answer": answer,
        "citations": citations,
        "verification_details": [
            {
                "raw": "backend_debug",
                "kb_error": kb_error,
                "used_agent_app": False,
                "model": model_override or reasoning.model_name,
                "disable_retrieve": disable_retrieve,
            }
        ],
        "answer_needs_human_review": False,
    }


def build_legal_qa_graph():
    graph = StateGraph(LegalQAState)
    graph.add_node("classify_intent", classify_intent)
    graph.add_node("retrieve_knowledge", retrieve_knowledge)
    graph.add_node("generate_answer", generate_answer)

    graph.add_edge(START, "classify_intent")
    graph.add_edge("classify_intent", "retrieve_knowledge")
    graph.add_edge("retrieve_knowledge", "generate_answer")
    graph.add_edge("generate_answer", END)
    return graph.compile()


legal_qa_graph = build_legal_qa_graph()


__all__ = [
    "LegalQAState",
    "LegalIntent",
    "classify_intent",
    "retrieve_knowledge",
    "generate_answer",
    "build_legal_qa_graph",
    "legal_qa_graph",
]

