from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from auth.config import AuthSettings, AuthUserRecord, get_auth_settings, user_by_id
from auth.security import verify_session_token


def _settings_dep() -> AuthSettings:
    try:
        return get_auth_settings()
    except RuntimeError as exc:
        # 将 auth 配置错误原样返回给客户端，避免笼统的「Authentication is not configured」
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc) or "Authentication configuration error",
        ) from exc


def session_payload_from_request(
    request: Request,
    settings: Annotated[AuthSettings, Depends(_settings_dep)],
) -> dict | None:
    raw = request.cookies.get(settings.cookie_name)
    if not raw:
        return None
    return verify_session_token(raw, settings.session_secret)


def user_record_from_session(
    request: Request,
    settings: Annotated[AuthSettings, Depends(_settings_dep)],
) -> AuthUserRecord | None:
    payload = session_payload_from_request(request, settings)
    if not payload:
        return None
    uid = payload.get("uid")
    if not isinstance(uid, str):
        return None
    return user_by_id(settings, uid)


def to_public_user(record: AuthUserRecord) -> dict[str, str]:
    return {
        "id": record.id,
        "username": record.username,
        "display_name": record.display_name or record.username,
    }


async def get_current_user_optional(
    request: Request,
    settings: Annotated[AuthSettings, Depends(_settings_dep)],
) -> AuthUserRecord | None:
    return user_record_from_session(request, settings)


async def get_current_user(
    request: Request,
    settings: Annotated[AuthSettings, Depends(_settings_dep)],
) -> AuthUserRecord:
    user = user_record_from_session(request, settings)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user
