from __future__ import annotations

from pathlib import Path

# 在读取 os.environ 之前加载项目根 .env（与进程 cwd 无关；供 uvicorn 及 `import auth.*` 场景使用）
try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None  # type: ignore[assignment,misc]

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if load_dotenv is not None:
    load_dotenv(_PROJECT_ROOT / ".env", encoding="utf-8")

import json
import logging
import os
from functools import lru_cache

from pydantic import BaseModel, Field, ValidationError, field_validator

log = logging.getLogger(__name__)


class AuthUserRecord(BaseModel):
    """Single row from AUTH_USERS_JSON (includes hash; never exposed in API responses)."""

    id: str = Field(..., min_length=1)
    username: str = Field(..., min_length=1)
    password_hash: str = Field(..., min_length=1)
    display_name: str = Field(default="")
    #: `admin` | `user`; omitted or unknown values default to `user`
    role: str = Field(default="user")

    @field_validator("role", mode="before")
    @classmethod
    def normalize_role(cls, v: object) -> str:
        if v is None or v == "":
            return "user"
        s = str(v).strip().lower()
        if s in ("admin", "user"):
            return s
        return "user"


class AuthSettings(BaseModel):
    users: list[AuthUserRecord]
    session_secret: str
    cookie_name: str
    cookie_secure: bool
    session_expire_days: int


def _parse_bool(raw: str | None, default: bool = False) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@lru_cache
def get_auth_settings() -> AuthSettings:
    raw = os.environ.get("AUTH_USERS_JSON", "").strip()
    if not raw:
        raise RuntimeError("AUTH_USERS_JSON missing or empty: set AUTH_USERS_JSON in Legal_AI/.env")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"AUTH_USERS_JSON invalid JSON ({exc.msg} at line {exc.lineno}, column {exc.colno})"
        ) from exc
    if not isinstance(data, list):
        raise RuntimeError("AUTH_USERS_JSON must be a JSON array of user objects")
    if len(data) != 6:
        raise RuntimeError(f"AUTH_USERS_JSON must contain exactly 6 users (found {len(data)})")
    users: list[AuthUserRecord] = []
    for i, item in enumerate(data):
        try:
            users.append(AuthUserRecord.model_validate(item))
        except ValidationError as exc:
            raise RuntimeError(
                f"AUTH_USERS_JSON user at index {i} failed validation ({exc.error_count()} error(s); check id, username, password_hash, display_name, role)"
            ) from exc

    usernames = [u.username for u in users]
    if len(set(usernames)) != len(usernames):
        raise RuntimeError("AUTH_USERS_JSON: duplicate username")
    ids = [u.id for u in users]
    if len(set(ids)) != len(ids):
        raise RuntimeError("AUTH_USERS_JSON: duplicate id")

    secret = os.environ.get("AUTH_SESSION_SECRET", "").strip()
    if len(secret) < 32:
        raise RuntimeError(
            "AUTH_SESSION_SECRET missing or too short: must be at least 32 characters (set in Legal_AI/.env)"
        )

    cookie_name = os.environ.get("AUTH_COOKIE_NAME", "legal_ai_session").strip() or "legal_ai_session"
    cookie_secure = _parse_bool(os.environ.get("AUTH_COOKIE_SECURE"), default=False)

    try:
        expire_days = int(os.environ.get("AUTH_SESSION_EXPIRE_DAYS", "7"))
    except ValueError as exc:
        raise RuntimeError("AUTH_SESSION_EXPIRE_DAYS must be an integer") from exc
    if expire_days < 1 or expire_days > 365:
        raise RuntimeError("AUTH_SESSION_EXPIRE_DAYS must be between 1 and 365")

    return AuthSettings(
        users=users,
        session_secret=secret,
        cookie_name=cookie_name,
        cookie_secure=cookie_secure,
        session_expire_days=expire_days,
    )


def user_by_username(settings: AuthSettings, username: str) -> AuthUserRecord | None:
    uname = username.strip()
    for u in settings.users:
        if u.username == uname:
            return u
    return None


def user_by_id(settings: AuthSettings, user_id: str) -> AuthUserRecord | None:
    uid = user_id.strip()
    for u in settings.users:
        if u.id == uid:
            return u
    return None


def _emit_auth_env_diagnostics() -> None:
    """启动时诊断：不打印密码或 password_hash 全文。"""
    env_path = _PROJECT_ROOT / ".env"
    exists = env_path.is_file()
    raw = os.environ.get("AUTH_USERS_JSON", "").strip()
    sec_raw = os.environ.get("AUTH_SESSION_SECRET", "").strip()
    raw_present = bool(raw)
    sec_present = bool(sec_raw)
    parse_ok = False
    user_count = 0
    usernames: list[str] = []
    if raw:
        try:
            d = json.loads(raw)
            if isinstance(d, list):
                parse_ok = True
                user_count = len(d)
                for item in d:
                    if isinstance(item, dict):
                        u = item.get("username")
                        if isinstance(u, str) and u.strip():
                            usernames.append(u.strip())
        except json.JSONDecodeError:
            pass
    log.info(
        "auth env diagnostics: .env_path=%s .env_exists=%s AUTH_USERS_JSON_set=%s "
        "AUTH_SESSION_SECRET_set=%s json_parse_ok=%s users_count=%s usernames=%s",
        env_path,
        exists,
        raw_present,
        sec_present,
        parse_ok,
        user_count,
        usernames,
    )


_emit_auth_env_diagnostics()
