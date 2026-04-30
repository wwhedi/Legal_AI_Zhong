from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Optional

from config.dashscope_config import create_local_qwen_completion


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
    hypothesis_id="H_local_prompt_module",
    location="local_qwen_prompt_service.py:import",
    message="LocalQwenPromptService module loaded",
    data={},
)
# endregion agent log


class LocalQwenPromptService:
    """
    为 /new-rag/local-prompt 提供本地 OpenAI-compatible 形式的调用封装。
    """

    async def ask(
        self,
        *,
        system_prompt: Optional[str],
        user_prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
    ) -> Dict[str, Any]:
        text = await create_local_qwen_completion(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            model=model,
            temperature=temperature,
        )
        base_url = (os.getenv("LOCAL_QWEN_BASE_URL") or "").strip().rstrip("/")
        return {
            "answer": text,
            "model": model or "",
            "base_url": base_url,
        }


__all__ = ["LocalQwenPromptService"]

