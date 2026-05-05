from __future__ import annotations

from collections.abc import AsyncIterator

from config.dashscope_config import (
    create_chat_completion,
    create_chat_completion_stream,
    get_configured_chat_model,
    get_reasoning_temperature,
)


class ReasoningService:
    """
    推理模型调用适配层（DashScope 或显式 Ollama，由 MODEL_BACKEND 决定）。
    """

    def __init__(self) -> None:
        self.model_name = get_configured_chat_model()
        self.temperature = get_reasoning_temperature()

    async def generate(self, *, system_prompt: str, user_prompt: str, model: str | None = None) -> str:
        return await create_chat_completion(
            model=model or self.model_name,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=self.temperature,
        )

    async def generate_stream(
        self, *, system_prompt: str, user_prompt: str, model: str | None = None
    ) -> AsyncIterator[str]:
        async for delta in create_chat_completion_stream(
            model=model or self.model_name,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=self.temperature,
        ):
            yield delta

    async def ping(self) -> str:
        return await create_chat_completion(
            model=self.model_name,
            system_prompt="你是连通性探测助手。",
            user_prompt="请只回复：ok",
            temperature=0.0,
        )


__all__ = ["ReasoningService"]
