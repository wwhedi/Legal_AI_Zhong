from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from new_feature_qwen_kb.service import QwenKBRagService

logger = logging.getLogger(__name__)

# region agent log
_DEBUG_LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "debug-312446.log")


def _dbg_log(*, hypothesis_id: str, location: str, message: str, data: Dict[str, Any]) -> None:
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


_dbg_log(
    hypothesis_id="H_router",
    location="new_feature_qwen_kb/router.py:import",
    message="new_rag router loaded",
    data={},
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


@router.post("/ask-stream")
async def ask_new_rag_stream(req: NewRagAskRequest) -> StreamingResponse:
    svc = QwenKBRagService()

    async def ndjson_body():
        try:
            async for event in svc.ask_events(req.question):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except ValueError as exc:
            err = {
                "type": "error",
                "stage": "error",
                "title": "输入无效",
                "message": str(exc)[:200],
                "data": {},
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            yield json.dumps(err, ensure_ascii=False) + "\n"
        except Exception:
            logger.exception("new_rag ask-stream ndjson_body failed")
            err = {
                "type": "error",
                "stage": "error",
                "title": "处理失败",
                "message": "处理过程中出现异常，请稍后重试或查看后端日志。",
                "data": {},
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            yield json.dumps(err, ensure_ascii=False) + "\n"

    return StreamingResponse(
        ndjson_body(),
        media_type="application/x-ndjson; charset=utf-8",
    )
