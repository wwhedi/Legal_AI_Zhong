from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import bcrypt


def verify_password(plain_password: str, password_hash: str) -> bool:
    """Verify plaintext password against a bcrypt hash ($2b$...)."""
    try:
        return bcrypt.checkpw(
            plain_password.encode("utf-8"),
            password_hash.encode("utf-8"),
        )
    except ValueError:
        return False


def _urlsafe_b64decode_nopad(data: str) -> bytes:
    pad = (-len(data)) % 4
    return base64.urlsafe_b64decode(data + "=" * pad)


def create_session_token(*, user_id: str, ttl_seconds: int, secret: str) -> str:
    """Stateless signed token: base64url(payload).base64url(hmac-sha256)."""
    now = int(time.time())
    payload: dict[str, Any] = {"uid": user_id, "iat": now, "exp": now + ttl_seconds}
    body_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    body_b64 = base64.urlsafe_b64encode(body_json).decode("ascii").rstrip("=")
    sig = hmac.new(secret.encode("utf-8"), body_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")
    return f"{body_b64}.{sig_b64}"


def verify_session_token(token: str, secret: str) -> dict[str, Any] | None:
    """Return payload dict with uid/exp if signature and expiry are valid."""
    if not token or "." not in token:
        return None
    body_b64, sig_b64 = token.split(".", 1)
    if not body_b64 or not sig_b64:
        return None
    try:
        expected_sig = hmac.new(secret.encode("utf-8"), body_b64.encode("ascii"), hashlib.sha256).digest()
        actual_sig = _urlsafe_b64decode_nopad(sig_b64)
    except Exception:
        return None
    if len(actual_sig) != len(expected_sig) or not hmac.compare_digest(expected_sig, actual_sig):
        return None
    try:
        payload_raw = _urlsafe_b64decode_nopad(body_b64)
        payload = json.loads(payload_raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    uid = payload.get("uid")
    exp = payload.get("exp")
    if not isinstance(uid, str) or not uid.strip():
        return None
    if not isinstance(exp, int):
        return None
    if int(time.time()) >= exp:
        return None
    return payload
