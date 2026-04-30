from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from http import HTTPStatus
from typing import Dict, List, Optional

import httpx
from openai import OpenAI

# region agent log
_DEBUG_LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "debug-312446.log")


def _dbg_log(*, hypothesis_id: str, location: str, message: str, data: Dict[str, object]) -> None:
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
    hypothesis_id="H_import",
    location="dashscope_config.py:import",
    message="Import module entered",
    data={"python": sys.version.split()[0], "executable": sys.executable},
)
# endregion agent log


def _require_dashscope():
    """
    Lazy import dashscope so the app can start even if the package is missing.
    """
    try:
        import dashscope  # type: ignore
    except ModuleNotFoundError as exc:
        # region agent log
        _dbg_log(
            hypothesis_id="H_import",
            location="dashscope_config.py:_require_dashscope",
            message="dashscope import failed",
            data={"error": str(exc), "python": sys.version.split()[0], "executable": sys.executable},
        )
        # endregion agent log
        raise RuntimeError(
            "Python 运行环境缺少依赖包 dashscope，导致模型接口无法调用。"
            "请在当前环境安装：pip install dashscope"
        ) from exc
    return dashscope


class ModelRegistry:
    """
    统一管理项目中使用到的大模型标识，避免在代码中散落硬编码字符串。
    """

    @classmethod
    def reasoning(cls) -> str:
        return os.getenv("REASONING_MODEL_NAME", "qwen-max")

    @classmethod
    def legal_retriever(cls) -> str:
        return os.getenv("FARUI_MODEL_NAME", "tongyi-farui")

    @classmethod
    def core_reasoning(cls) -> str:
        # Backward compatibility: 历史命名对齐到 reasoning()
        return os.getenv("DASHSCOPE_CORE_REASONING_MODEL", cls.reasoning())

    @classmethod
    def text_router(cls) -> str:
        return os.getenv("DASHSCOPE_TEXT_ROUTER_MODEL", "qwen-plus")

    @classmethod
    def embedding(cls) -> str:
        return os.getenv("DASHSCOPE_EMBEDDING_MODEL", "text-embedding-v4")

    @classmethod
    def local_qwen(cls) -> str:
        return os.getenv("LOCAL_QWEN_MODEL_NAME", cls.reasoning())

    # Rerank 目前仅接入 DashScope HTTP endpoint；保留为常量供 RerankerService 使用
    RERANKER = "gte-rerank"

    @classmethod
    def as_dict(cls) -> Dict[str, str]:
        return {
            "reasoning": cls.reasoning(),
            "legal_retriever": cls.legal_retriever(),
            "core_reasoning": cls.core_reasoning(),
            "text_router": cls.text_router(),
            "embedding": cls.embedding(),
            "reranker": cls.RERANKER,
        }


def get_farui_temperature() -> float:
    return float(os.getenv("FARUI_TEMPERATURE", "0.01"))


def get_reasoning_temperature() -> float:
    return float(os.getenv("REASONING_TEMPERATURE", "0.3"))


def get_local_qwen_temperature() -> float:
    return float(os.getenv("LOCAL_QWEN_TEMPERATURE", str(get_reasoning_temperature())))


def _extract_openai_text(resp: object) -> str:
    status = getattr(resp, "status", None)
    if isinstance(status, str) and status and status.lower() != "completed":
        err = getattr(resp, "error", None)
        raise RuntimeError(f"OpenAI-compatible response failed: status={status} error={err}")

    text = getattr(resp, "output_text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()

    raw = getattr(resp, "output", None)
    try:
        data = raw if isinstance(raw, list) else json.loads(json.dumps(raw))
        for item in data or []:
            content = item.get("content") if isinstance(item, dict) else None
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and isinstance(c.get("text"), str) and c["text"].strip():
                        return c["text"].strip()
    except Exception:
        pass

    return str(resp).strip()


def _call_openai_compatible_completion(
    *,
    api_key: str,
    base_url: str,
    messages: List[Dict[str, str]],
    model: str,
    temperature: float,
    timeout_seconds: float,
    trust_env: bool,
) -> str:
    with httpx.Client(trust_env=trust_env, timeout=timeout_seconds) as http_client:
        client = OpenAI(api_key=api_key, base_url=base_url, http_client=http_client)
        resp = client.responses.create(
            model=model,
            input=messages,
            temperature=temperature,
        )
    return _extract_openai_text(resp)


async def create_chat_completion(
    *,
    model: str,
    system_prompt: Optional[str],
    user_prompt: str,
    temperature: float = 0.1,
) -> str:
    """
    统一的 Chat Completion 调用封装（双通道）：
    - farui-*：DashScope SDK 原生 Generation.call
    - qwen*：OpenAI SDK + DashScope compatible-mode
    - app:APP_ID：DashScope Application.call（调用百炼智能体应用）
    - 返回模型输出文本（string）
    """

    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("Environment variable `DASHSCOPE_API_KEY` is required.")

    messages: List[Dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    is_farui_model = model.lower().startswith("farui")
    model_lower = (model or "").strip().lower()
    is_app_model = model_lower.startswith("app:") or model_lower.startswith("application:")
    app_id = ""
    if is_app_model:
        app_id = (model.split(":", 1)[1] if ":" in model else "").strip()
        if not app_id:
            raise RuntimeError("Agent application call requires `model` like `app:APP_ID`.")

    def _call_sync() -> str:
        if is_app_model:
            # Use HTTP API directly to get clearer errors/timeouts than SDK wrappers.
            # Ref: POST https://dashscope.aliyuncs.com/api/v1/apps/{APP_ID}/completion
            prompt = (
                (system_prompt.strip() + "\n\n" if system_prompt and system_prompt.strip() else "")
                + user_prompt.strip()
            ).strip()
            base = (os.getenv("DASHSCOPE_APP_BASE_URL") or "https://dashscope.aliyuncs.com").strip().rstrip("/")
            url = f"{base}/api/v1/apps/{app_id}/completion"
            timeout_s = float(os.getenv("DASHSCOPE_APP_TIMEOUT_SECONDS", "60"))
            trust_env = os.getenv("DASHSCOPE_TRUST_ENV", "").strip().lower() in ("1", "true", "yes")

            payload = {
                "input": {"prompt": prompt},
                "parameters": {},
                "debug": {},
            }
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }

            with httpx.Client(timeout=httpx.Timeout(timeout_s), trust_env=trust_env) as client:
                resp = client.post(url, headers=headers, json=payload)
                if resp.status_code != HTTPStatus.OK:
                    body = (resp.text or "").strip()
                    raise RuntimeError(
                        "DashScope Application HTTP failed: "
                        f"status_code={resp.status_code} body={body[:800]}"
                    )
                data = resp.json()
                output = data.get("output") if isinstance(data, dict) else None
                text = output.get("text") if isinstance(output, dict) else None
                if isinstance(text, str) and text.strip():
                    return text.strip()
                raise RuntimeError(f"DashScope Application unexpected response: {str(data)[:800]}")

        if is_farui_model:
            ds = _require_dashscope()
            ds.api_key = api_key
            resp = ds.Generation.call(
                model,
                messages=messages,
                result_format="message",
                temperature=temperature,
            )
            if getattr(resp, "status_code", None) != HTTPStatus.OK:
                raise RuntimeError(
                    "DashScope request failed: "
                    f"status_code={getattr(resp, 'status_code', None)} "
                    f"code={getattr(resp, 'code', None)} "
                    f"message={getattr(resp, 'message', None)} "
                    f"request_id={getattr(resp, 'request_id', None)}"
                )

            output = getattr(resp, "output", None) or {}
            choices = output.get("choices") or []
            if choices and isinstance(choices[0], dict):
                msg = choices[0].get("message") or {}
                content = msg.get("content")
                if isinstance(content, str):
                    return content.strip()
            return str(resp).strip()

        base_url = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        return _call_openai_compatible_completion(
            api_key=api_key,
            base_url=base_url,
            messages=messages,
            model=model,
            temperature=temperature,
            timeout_seconds=120.0,
            trust_env=False,
        )

    return await asyncio.to_thread(_call_sync)


async def create_local_qwen_completion(
    *,
    system_prompt: Optional[str],
    user_prompt: str,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
) -> str:
    base_url = (os.getenv("LOCAL_QWEN_BASE_URL") or "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("Environment variable `LOCAL_QWEN_BASE_URL` is required.")

    api_key = (os.getenv("LOCAL_QWEN_API_KEY") or "EMPTY").strip()
    model_name = (model or ModelRegistry.local_qwen()).strip()
    if not model_name:
        raise RuntimeError("Local Qwen model name is required.")

    timeout_seconds = float(os.getenv("LOCAL_QWEN_TIMEOUT_SECONDS", "120"))
    trust_env = os.getenv("LOCAL_QWEN_TRUST_ENV", "").strip().lower() in ("1", "true", "yes")

    messages: List[Dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    return await asyncio.to_thread(
        _call_openai_compatible_completion,
        api_key=api_key,
        base_url=base_url,
        messages=messages,
        model=model_name,
        temperature=temperature if temperature is not None else get_local_qwen_temperature(),
        timeout_seconds=timeout_seconds,
        trust_env=trust_env,
    )


__all__ = [
    "ModelRegistry",
    "create_chat_completion",
    "create_local_qwen_completion",
    "get_farui_temperature",
    "get_local_qwen_temperature",
    "get_reasoning_temperature",
]

