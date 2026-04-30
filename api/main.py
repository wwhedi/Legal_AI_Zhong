from __future__ import annotations

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.kb_update_api import router as kb_update_router
import json
import os
import time
from typing import Any, Dict


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


_dbg_log(hypothesis_id="H_router", location="api/main.py:import", message="api.main import started", data={})
# endregion agent log

try:
    from new_feature_qwen_kb import router as new_rag_router
except Exception as exc:  # pragma: no cover - allow partial startup
    new_rag_router = None
    # region agent log
    _dbg_log(
        hypothesis_id="H_router",
        location="api/main.py:new_feature_qwen_kb_import",
        message="new_feature_qwen_kb router import failed",
        data={"error": str(exc), "type": type(exc).__name__},
    )
    # endregion agent log

try:
    from api.qa_api import router as qa_router
except Exception:  # pragma: no cover - allow partial startup for kb-update APIs
    qa_router = None


load_dotenv()
app = FastAPI(title="Legal Contract Review API", version="0.1.0")

# Frontend calls this API directly from the browser (Next.js on :3000),
# so CORS must be enabled for local dev and configurable deployments.
allowed_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(kb_update_router)
if new_rag_router is not None:
    app.include_router(new_rag_router)
if qa_router is not None:
    app.include_router(qa_router)

