from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# 优先加载 Legal_AI/.env（与 uvicorn 启动时的 cwd 无关）；其次加载 cwd 下的 .env（默认 override=False，不覆盖已由项目根注入的变量）
_LEGAL_AI_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_LEGAL_AI_ROOT / ".env", encoding="utf-8")
load_dotenv(encoding="utf-8")

from api.kb_update_api import router as kb_update_router
from auth.router import router as auth_router
from chat_store.db import init_db as init_chat_db
from chat_store.router import router as chat_router
from new_feature_qwen_kb import router as new_rag_router


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


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    init_chat_db()
    yield


app = FastAPI(title="Legal AI API", version="0.1.0", lifespan=_app_lifespan)

# Frontend calls this API directly from the browser (Next.js on :3000),
# so CORS must be enabled for local dev and configurable deployments.
_DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)


def _parse_cors_allow_origins() -> list[str]:
    raw = os.environ.get("CORS_ALLOW_ORIGINS", "").strip()
    if not raw:
        return list(_DEFAULT_CORS_ORIGINS)
    parts = [p.strip() for p in raw.split(",")]
    origins = [p for p in parts if p]
    return origins if origins else list(_DEFAULT_CORS_ORIGINS)


allowed_origins = _parse_cors_allow_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(chat_router)
app.include_router(kb_update_router)
app.include_router(new_rag_router)
