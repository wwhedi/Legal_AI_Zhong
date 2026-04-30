from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config.system_prompts import LEGAL_ASSISTANT_SYSTEM_PROMPT
from new_feature_qwen_kb.service import QwenKBRagService
import json
import os
import time
from typing import Any as _Any


# region agent log
_DEBUG_LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "debug-312446.log")


def _dbg_log(*, hypothesis_id: str, location: str, message: str, data: Dict[str, _Any]) -> None:
    try:
        payload = {
            "sessionId": "312446",
            "runId": "pre-fix",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": int(time.time() * 1000),
        }
        with open(_DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        return


try:
    from services.local_qwen_prompt_service import LocalQwenPromptService
except Exception as exc:
    LocalQwenPromptService = None  # type: ignore
    _dbg_log(
        hypothesis_id="H_local_prompt",
        location="new_feature_qwen_kb/router.py:import",
        message="LocalQwenPromptService import failed",
        data={"error": str(exc), "type": type(exc).__name__},
    )
# endregion agent log

router = APIRouter(prefix="/new-rag", tags=["new-rag"])


class NewRagAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)


class NewRagAskResponse(BaseModel):
    question: str
    answer: str
    model: str
    retrieved_count: int
    citations: List[Dict[str, Any]] = Field(default_factory=list)


class LocalPromptRequest(BaseModel):
    system_prompt: str = Field(default=LEGAL_ASSISTANT_SYSTEM_PROMPT, max_length=12000)
    user_prompt: str = Field(..., min_length=1, max_length=12000)
    model: str | None = Field(default=None, max_length=200)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)


class LocalPromptResponse(BaseModel):
    answer: str
    model: str
    base_url: str


@router.post("/ask", response_model=NewRagAskResponse)
async def ask_new_rag(req: NewRagAskRequest) -> NewRagAskResponse:
    svc = QwenKBRagService()
    try:
        result = await svc.ask(req.question)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"new-rag call failed: {exc}") from exc

    return NewRagAskResponse(
        question=req.question,
        answer=str(result.get("answer") or ""),
        model=str(result.get("model") or "qwen-plus"),
        retrieved_count=int(result.get("retrieved_count") or 0),
        citations=[item for item in (result.get("citations") or []) if isinstance(item, dict)],
    )


@router.post("/local-prompt", response_model=LocalPromptResponse)
async def ask_local_prompt(req: LocalPromptRequest) -> LocalPromptResponse:
    if LocalQwenPromptService is None:
        raise HTTPException(
            status_code=501,
            detail="local-prompt endpoint is unavailable: missing services.local_qwen_prompt_service",
        )
    svc = LocalQwenPromptService()
    try:
        result = await svc.ask(
            system_prompt=req.system_prompt or LEGAL_ASSISTANT_SYSTEM_PROMPT,
            user_prompt=req.user_prompt,
            model=req.model,
            temperature=req.temperature,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"local-qwen call failed: {exc}") from exc

    return LocalPromptResponse(
        answer=str(result.get("answer") or ""),
        model=str(result.get("model") or ""),
        base_url=str(result.get("base_url") or ""),
    )
