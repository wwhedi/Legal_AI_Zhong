from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatSessionSummary(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class ChatMessagePublic(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str | None = None
    answer_card: Any | None = None
    process_events: Any | None = None
    created_at: str


class ChatSessionDetail(BaseModel):
    session: ChatSessionSummary
    messages: list[ChatMessagePublic]


class CreateSessionBody(BaseModel):
    title: str | None = Field(default=None, max_length=512)


class PatchSessionBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=512)


class AppendMessageBody(BaseModel):
    role: Literal["user", "assistant"]
    content: str | None = Field(default=None, max_length=2_000_000)
    answer_card: Any | None = None
    process_events: Any | None = None
    created_at: str | None = Field(default=None, max_length=64)
