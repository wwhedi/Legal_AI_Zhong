from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from auth.config import AuthSettings, AuthUserRecord, get_auth_settings, user_by_username
from auth.dependencies import _settings_dep, get_current_user, to_public_user
from auth.security import create_session_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=256)


class UserPublic(BaseModel):
    id: str
    username: str
    display_name: str
    role: str = "user"


class LoginResponse(BaseModel):
    user: UserPublic


@router.post("/login", response_model=LoginResponse)
async def login(
    response: Response,
    body: LoginBody,
    settings: Annotated[AuthSettings, Depends(_settings_dep)],
) -> LoginResponse:
    record = user_by_username(settings, body.username)
    if record is None or not verify_password(body.password, record.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    ttl_seconds = settings.session_expire_days * 86400
    token = create_session_token(user_id=record.id, ttl_seconds=ttl_seconds, secret=settings.session_secret)

    response.set_cookie(
        key=settings.cookie_name,
        value=token,
        max_age=ttl_seconds,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )

    pub = to_public_user(record)
    return LoginResponse(user=UserPublic(**pub))


@router.post("/logout")
async def logout(
    response: Response,
    settings: Annotated[AuthSettings, Depends(_settings_dep)],
) -> dict[str, bool]:
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )
    return {"ok": True}


@router.get("/me", response_model=UserPublic)
async def me(user: Annotated[AuthUserRecord, Depends(get_current_user)]) -> UserPublic:
    """Return the authenticated user; 401 if missing or invalid session cookie."""
    return UserPublic(**to_public_user(user))
