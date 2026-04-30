from __future__ import annotations

from config.dashscope_config import (
    ModelRegistry,
    create_chat_completion,
    get_reasoning_temperature,
)


class ReasoningService:
    """
    推理模型（Qwen）调用适配层。
    """

    def __init__(self) -> None:
        self.model_name = ModelRegistry.reasoning()
        self.temperature = get_reasoning_temperature()

    async def generate(self, *, system_prompt: str, user_prompt: str, model: str | None = None) -> str:
        return await create_chat_completion(
            model=model or self.model_name,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=self.temperature,
        )

    async def ping(self) -> str:
        return await create_chat_completion(
            model=self.model_name,
            system_prompt="你是连通性探测助手。",
            user_prompt="请只回复：ok",
            temperature=0.0,
        )


__all__ = ["ReasoningService"]
