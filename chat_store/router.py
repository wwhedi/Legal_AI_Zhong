from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from auth.config import AuthUserRecord
from auth.dependencies import get_current_user
from chat_store import service as chat_svc
from chat_store.models import (
    AppendMessageBody,
    ChatMessagePublic,
    ChatSessionDetail,
    ChatSessionSummary,
    CreateSessionBody,
    PatchSessionBody,
)

router = APIRouter(prefix="/chat", tags=["chat"])


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")


@router.get("/sessions", response_model=list[ChatSessionSummary])
async def list_sessions(user: Annotated[AuthUserRecord, Depends(get_current_user)]) -> list[ChatSessionSummary]:
    rows = chat_svc.list_sessions(user_id=user.id)
    return [ChatSessionSummary(**r) for r in rows]


@router.post("/sessions", response_model=ChatSessionSummary, status_code=status.HTTP_201_CREATED)
async def create_session(
    user: Annotated[AuthUserRecord, Depends(get_current_user)],
    body: CreateSessionBody = CreateSessionBody(),
) -> ChatSessionSummary:
    title = body.title
    row = chat_svc.create_session(user_id=user.id, title=title)
    return ChatSessionSummary(**row)


@router.get("/sessions/{session_id}", response_model=ChatSessionDetail)
async def get_session(
    session_id: str,
    user: Annotated[AuthUserRecord, Depends(get_current_user)],
) -> ChatSessionDetail:
    result = chat_svc.get_session_with_messages(session_id=session_id, user_id=user.id)
    if result is None:
        raise _not_found()
    summary, msgs = result
    return ChatSessionDetail(
        session=ChatSessionSummary(**summary),
        messages=[ChatMessagePublic(**m) for m in msgs],
    )


@router.patch("/sessions/{session_id}", response_model=ChatSessionSummary)
async def patch_session(
    session_id: str,
    body: PatchSessionBody,
    user: Annotated[AuthUserRecord, Depends(get_current_user)],
) -> ChatSessionSummary:
    row = chat_svc.patch_session_title(session_id=session_id, user_id=user.id, title=body.title)
    if row is None:
        raise _not_found()
    return ChatSessionSummary(**row)


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    user: Annotated[AuthUserRecord, Depends(get_current_user)],
) -> Response:
    ok = chat_svc.delete_session(session_id=session_id, user_id=user.id)
    if not ok:
        raise _not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/sessions/{session_id}/messages",
    response_model=ChatMessagePublic,
    status_code=status.HTTP_201_CREATED,
)
async def append_message(
    session_id: str,
    body: AppendMessageBody,
    user: Annotated[AuthUserRecord, Depends(get_current_user)],
) -> ChatMessagePublic:
    row = chat_svc.append_message(
        session_id=session_id,
        user_id=user.id,
        role=body.role,
        content=body.content,
        answer_card=body.answer_card,
        process_events=body.process_events,
        created_at=body.created_at,
    )
    if row is None:
        raise _not_found()
    return ChatMessagePublic(**row)
