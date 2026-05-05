from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import AsyncIterator, Dict, List, Optional

import httpx
from openai import AsyncOpenAI, OpenAI

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


class ModelRegistry:
    """
    统一管理项目中使用到的大模型标识，避免在代码中散落硬编码字符串。
    """

    @classmethod
    def reasoning(cls) -> str:
        return os.getenv("REASONING_MODEL_NAME", "qwen-max")

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

    # Rerank 目前仅接入 DashScope HTTP endpoint；保留为常量供 RerankerService 使用
    RERANKER = "gte-rerank"

    @classmethod
    def as_dict(cls) -> Dict[str, str]:
        return {
            "reasoning": cls.reasoning(),
            "core_reasoning": cls.core_reasoning(),
            "text_router": cls.text_router(),
            "embedding": cls.embedding(),
            "reranker": cls.RERANKER,
        }


def get_reasoning_temperature() -> float:
    return float(os.getenv("REASONING_TEMPERATURE", "0.3"))


def normalize_model_backend() -> str:
    """
    文本推理后端（显式选择，不在 DashScope 失败后自动切换）：
    - 未设置或空：dashscope
    - dashscope：DashScope OpenAI 兼容模式（responses.create）
    - ollama：本地 Ollama OpenAI 兼容 API（chat.completions）
    """
    raw = os.getenv("MODEL_BACKEND")
    b = (raw or "dashscope").strip().lower()
    if not b:
        b = "dashscope"
    if b == "dashscope":
        return "dashscope"
    if b == "ollama":
        return "ollama"
    raise RuntimeError(
        f"Invalid MODEL_BACKEND={raw!r} (normalized={b!r}); expected 'dashscope' or 'ollama'."
    )


def get_configured_chat_model() -> str:
    """供 ReasoningService / QwenKBRagService 默认模型名与响应 `model` 字段一致。"""
    if normalize_model_backend() == "ollama":
        return (os.getenv("LOCAL_MODEL_NAME") or "qwen2.5:7b").strip()
    return (
        (os.getenv("NEW_QWEN_MODEL_NAME") or "").strip()
        or (os.getenv("REASONING_MODEL_NAME") or "").strip()
        or "qwen-plus"
    )


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


def _call_openai_chat_completion(
    *,
    api_key: str,
    base_url: str,
    messages: List[Dict[str, str]],
    model: str,
    temperature: float,
    timeout_seconds: float,
    trust_env: bool,
) -> str:
    """OpenAI 兼容 `POST .../chat/completions`（Ollama 等）；与 DashScope 的 responses.create 路径分离。"""
    with httpx.Client(trust_env=trust_env, timeout=timeout_seconds) as http_client:
        client = OpenAI(api_key=api_key, base_url=base_url, http_client=http_client)
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
        )
    if not resp.choices:
        raise RuntimeError("OpenAI-compatible chat completion returned no choices.")
    msg = resp.choices[0].message
    content = getattr(msg, "content", None) if msg else None
    if isinstance(content, str) and content.strip():
        return content.strip()
    raise RuntimeError("OpenAI-compatible chat completion returned empty content.")


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
    文本生成：由 `MODEL_BACKEND` 显式选择后端（无 DashScope 失败后的自动 fallback）。

    - **dashscope**：DashScope OpenAI 兼容模式，经 `responses.create`；需 `DASHSCOPE_API_KEY`，
      `model` 须为非空（调用方传入的模型名）。
    - **ollama**：本地 Ollama `.../v1/chat/completions`；使用 `OLLAMA_BASE_URL`、`OLLAMA_API_KEY`，
      实际请求模型固定为 `LOCAL_MODEL_NAME`（忽略传入的 `model` 参数）。
    """

    messages: List[Dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    backend = normalize_model_backend()

    def _call_sync() -> str:
        if backend == "ollama":
            model_name = (os.getenv("LOCAL_MODEL_NAME") or "qwen2.5:7b").strip()
            if not model_name:
                raise RuntimeError("LOCAL_MODEL_NAME is empty under MODEL_BACKEND=ollama.")
            api_key = (os.getenv("OLLAMA_API_KEY") or "ollama").strip()
            base_raw = (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434/v1").strip()
            base_url = base_raw.rstrip("/")
            if not base_url:
                raise RuntimeError("OLLAMA_BASE_URL is empty; set it to e.g. http://127.0.0.1:11434/v1")
            return _call_openai_chat_completion(
                api_key=api_key,
                base_url=base_url,
                messages=messages,
                model=model_name,
                temperature=temperature,
                timeout_seconds=120.0,
                trust_env=False,
            )

        api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
        if not api_key:
            raise RuntimeError("Environment variable `DASHSCOPE_API_KEY` is required when MODEL_BACKEND=dashscope.")

        model_name = (model or "").strip()
        if not model_name:
            raise RuntimeError("Model name is required (`model` must be non-empty).")

        base_url = (os.getenv("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1").strip()
        if not base_url:
            raise RuntimeError("OpenAI-compatible base URL is empty; set `DASHSCOPE_BASE_URL` to a valid URL.")
        return _call_openai_compatible_completion(
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            messages=messages,
            model=model_name,
            temperature=temperature,
            timeout_seconds=120.0,
            trust_env=False,
        )

    return await asyncio.to_thread(_call_sync)


def _delta_public_text_only(delta: object) -> str:
    """
    只取对用户可见的正文增量（delta.content）；不读取、不转发 reasoning/thinking 等内部字段。
    """
    if delta is None:
        return ""
    content = getattr(delta, "content", None)
    if isinstance(content, str) and content:
        return content
    return ""


async def create_chat_completion_stream(
    *,
    model: str,
    system_prompt: Optional[str],
    user_prompt: str,
    temperature: float = 0.1,
) -> AsyncIterator[str]:
    """
    文本流式生成（显式 chat.completions + stream=True），按后端分支：

    - **ollama**：经本地 Ollama OpenAI 兼容 `chat.completions`。
    - **dashscope**：经 DashScope **OpenAI 兼容** `chat.completions` 流式接口
      （与 `create_chat_completion` 使用的 `responses.create` 非流式路径不同；
      若需流式 token，统一走本函数的 chat.completions）。

    每次 yield 一段可见正文 delta（可能为空字符串的 chunk 会被调用方跳过）。
    """
    messages: List[Dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    backend = normalize_model_backend()

    if backend == "ollama":
        model_name = (os.getenv("LOCAL_MODEL_NAME") or "qwen2.5:7b").strip()
        if not model_name:
            raise RuntimeError("LOCAL_MODEL_NAME is empty under MODEL_BACKEND=ollama.")
        api_key = (os.getenv("OLLAMA_API_KEY") or "ollama").strip()
        base_raw = (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434/v1").strip()
        base_url = base_raw.rstrip("/")
        if not base_url:
            raise RuntimeError("OLLAMA_BASE_URL is empty; set it to e.g. http://127.0.0.1:11434/v1")
        async with httpx.AsyncClient(trust_env=False, timeout=120.0) as http_client:
            client = AsyncOpenAI(api_key=api_key, base_url=base_url, http_client=http_client)
            stream = await client.chat.completions.create(
                model=model_name,
                messages=messages,
                temperature=temperature,
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                piece = _delta_public_text_only(chunk.choices[0].delta)
                if piece:
                    yield piece
        return

    if backend == "dashscope":
        api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
        if not api_key:
            raise RuntimeError("Environment variable `DASHSCOPE_API_KEY` is required when MODEL_BACKEND=dashscope.")

        model_name = (model or "").strip()
        if not model_name:
            raise RuntimeError("Model name is required (`model` must be non-empty).")

        base_url = (os.getenv("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1").strip()
        if not base_url:
            raise RuntimeError("OpenAI-compatible base URL is empty; set `DASHSCOPE_BASE_URL` to a valid URL.")
        # DashScope 兼容模式的流式输出：chat.completions（SSE）。若服务端或模型不支持，将抛错由上层转为 error 事件。
        async with httpx.AsyncClient(trust_env=False, timeout=120.0) as http_client:
            client = AsyncOpenAI(api_key=api_key, base_url=base_url.rstrip("/"), http_client=http_client)
            stream = await client.chat.completions.create(
                model=model_name,
                messages=messages,
                temperature=temperature,
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                piece = _delta_public_text_only(chunk.choices[0].delta)
                if piece:
                    yield piece
        return

    raise RuntimeError(f"Streaming not implemented for MODEL_BACKEND={backend!r}.")


__all__ = [
    "ModelRegistry",
    "create_chat_completion",
    "create_chat_completion_stream",
    "get_configured_chat_model",
    "get_reasoning_temperature",
    "normalize_model_backend",
]
