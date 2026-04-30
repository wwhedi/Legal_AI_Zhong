from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List
from urllib.parse import quote, urlencode, urlparse

import requests

from config.dashscope_config import (
    get_farui_temperature,
)


logger = logging.getLogger(__name__)


def _rfc3986_encode(str_value: str) -> str:
    """RFC3986 编码（与 Farui 官方示例一致）。"""
    return quote(str_value, safe="-._~")


def _ali_sign(
    url: str,
    method: str,
    headers: Dict[str, str],
    body: Dict[str, Any],
    access_key_id: str,
    access_key_secret: str,
) -> str:
    """生成阿里云 ACS3-HMAC-SHA256 签名（与 Farui 官方示例一致）。"""
    url_object = urlparse(url)
    canonical_uri = url_object.path if url_object.path else "/"

    query_params: Dict[str, str] = {}
    if url_object.query:
        query_params = dict([part.split("=") for part in url_object.query.split("&")])
    canonical_query_string = urlencode(
        {_rfc3986_encode(k): _rfc3986_encode(v) for k, v in sorted(query_params.items())}
    )

    headers1 = {k.lower(): v for k, v in headers.items()}
    canonical_headers = "".join(
        f"{k}:{v.strip()}\n"
        for k, v in sorted(headers1.items())
        if k.startswith("x-acs-") or k in ["host", "content-type"]
    )
    signed_headers = ";".join(
        sorted([k for k in headers1.keys() if k.startswith("x-acs-") or k in ["host", "content-type"]])
    )

    # 必须与 POST body 使用同一套 json.dumps（默认 ensure_ascii），否则签名校验失败
    hashed_request_payload = hashlib.sha256(json.dumps(body).encode()).hexdigest()

    canonical_request = "\n".join(
        [
            method,
            canonical_uri,
            canonical_query_string,
            canonical_headers,
            signed_headers,
            hashed_request_payload,
        ]
    )

    signature_algorithm = "ACS3-HMAC-SHA256"
    hashed_canonical_request = hashlib.sha256(canonical_request.encode()).hexdigest()
    string_to_sign = f"{signature_algorithm}\n{hashed_canonical_request}"

    signature = hmac.new(
        access_key_secret.encode(),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()

    return (
        f"{signature_algorithm} Credential={access_key_id},"
        f"SignedHeaders={signed_headers},Signature={signature}"
    )


class FaruiLegalService:
    """
    通义法睿法律背景检索服务：
    - 输入：用户自然语言问题
    - 输出：结构化法律背景字符串（可直接作为下游推理模型 context）
    """

    def __init__(self) -> None:
        self.temperature = get_farui_temperature()
        self.timeout_seconds = float(os.getenv("FARUI_TIMEOUT_SECONDS", "20"))
        # If these are configured, use official Farui signed retrieval API first.
        self.farui_access_key_id = (os.getenv("FARUI_ACCESS_KEY_ID") or "").strip()
        self.farui_access_key_secret = (os.getenv("FARUI_ACCESS_KEY_SECRET") or "").strip()
        self.farui_workspace_id = (os.getenv("FARUI_WORKSPACE_ID") or "").strip()
        self.farui_host = (os.getenv("FARUI_HOST") or "farui.cn-beijing.aliyuncs.com").strip()

    async def search_legal_context(self, query: str) -> str:
        payload = await self.search_legal_payload(query)
        return payload["context"]

    async def search_legal_payload(self, query: str) -> Dict[str, Any]:
        raw = await asyncio.wait_for(
            self._call_farui(query=query),
            timeout=self.timeout_seconds,
        )
        parsed = self._parse_farui_response(raw)
        return {
            "context": self._format_context(parsed),
            "statutes": parsed.get("statutes") or [],
        }

    async def _call_farui(self, query: str) -> str:
        if not (
            self.farui_access_key_id
            and self.farui_access_key_secret
            and self.farui_workspace_id
        ):
            raise RuntimeError(
                "Farui signed retrieval is required. Missing one or more env vars: "
                "FARUI_ACCESS_KEY_ID, FARUI_ACCESS_KEY_SECRET, FARUI_WORKSPACE_ID."
            )
        return await asyncio.to_thread(self._call_farui_search_api, query)

    def _call_farui_search_api(self, query: str) -> str:
        host = self.farui_host
        workspace_id = self.farui_workspace_id
        url = f"https://{host}/{workspace_id}/farui/search/law/query"
        body = {
            "appId": "farui",
            "workspaceId": workspace_id,
            "query": query,
            "pageParam": {"pageSize": 10, "pageNumber": 1},
        }

        timestamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        headers = {
            "host": host,
            "Content-Type": "application/json",
            "x-acs-action": "RunSearchLawQuery",
            "x-acs-version": "2024-06-28",
            "x-acs-date": timestamp,
        }
        headers["Authorization"] = _ali_sign(
            url,
            "POST",
            headers,
            body,
            self.farui_access_key_id,
            self.farui_access_key_secret,
        )

        body_json = json.dumps(body)
        # 与示例一致：stream=True；timeout 为工程需要额外增加
        # 若需走系统代理，设置 FARUI_USE_SYSTEM_PROXY=1
        post_kw: Dict[str, Any] = {
            "url": url,
            "headers": headers,
            "data": body_json,
            "stream": True,
            "timeout": self.timeout_seconds,
        }
        if os.getenv("FARUI_USE_SYSTEM_PROXY", "").strip().lower() not in ("1", "true", "yes"):
            post_kw["proxies"] = {"http": None, "https": None}

        resp = requests.post(**post_kw)
        if resp.status_code != 200:
            raise RuntimeError(f"Farui search API HTTP {resp.status_code}: {resp.text}")

        payload = resp.json()
        converted = self._convert_farui_api_payload(payload)
        return json.dumps(converted, ensure_ascii=False)

    def _convert_farui_api_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        law_results = data.get("lawResult") if isinstance(data.get("lawResult"), list) else []
        statutes: List[Dict[str, Any]] = []
        for item in law_results:
            if not isinstance(item, dict):
                continue
            law_domain = item.get("lawDomain") if isinstance(item.get("lawDomain"), dict) else {}
            name = str(law_domain.get("lawName") or "").strip()
            article = str(law_domain.get("lawOrder") or "").strip()
            quote_text = str(law_domain.get("lawSourceContent") or "").strip()
            law_title = str(law_domain.get("lawTitle") or "").strip()
            timeliness = str(law_domain.get("timeliness") or "").strip()
            if not name and not quote_text:
                continue
            statutes.append(
                {
                    "name": name or "未标注法规",
                    "article": article or "未标注条款",
                    "quote": quote_text,
                    "title": law_title,
                    "timeliness": timeliness,
                }
            )

        analysis: List[str] = []
        if statutes:
            analysis.append("已基于 Farui 法规检索结果提取候选法条。")
        else:
            analysis.append("Farui 已调用成功，但未解析到可用法条字段，建议检查 workspace 与检索权限。")

        return {
            "statutes": statutes,
            "cases": [],
            "analysis": analysis,
            "confidence_note": "以上法条来自 Farui 法规检索接口，建议结合法务人工复核。",
        }

    def _parse_farui_response(self, raw: str) -> Dict[str, Any]:
        text = (raw or "").strip()
        if not text:
            return {
                "statutes": [],
                "cases": [],
                "analysis": ["法睿未返回可解析内容。"],
                "confidence_note": "证据不足，建议结合本地法规库复核。",
            }
        try:
            data = json.loads(text)
            return {
                "statutes": data.get("statutes") or [],
                "cases": data.get("cases") or [],
                "analysis": data.get("analysis") or [],
                "confidence_note": data.get("confidence_note") or "请结合具体案情进行适用性审查。",
            }
        except Exception:
            logger.warning("Farui response is not valid JSON, fallback to raw text parsing.")
            return {
                "statutes": [],
                "cases": [],
                "analysis": [text],
                "confidence_note": "法睿返回为非结构化文本，已按原文作为初步分析纳入。",
            }

    def _format_context(self, data: Dict[str, Any]) -> str:
        statutes = self._format_statutes(data.get("statutes") or [])
        cases = self._format_cases(data.get("cases") or [])
        analysis = self._format_list(data.get("analysis") or [], default="暂无初步法理分析。")
        confidence_note = str(data.get("confidence_note") or "请结合具体事实与证据补充判断。").strip()

        return (
            "[法睿法律背景]\n"
            "一、法条引用\n"
            f"{statutes}\n\n"
            "二、类案参考\n"
            f"{cases}\n\n"
            "三、初步法理分析\n"
            f"{analysis}\n\n"
            "四、法睿置信提示\n"
            f"- {confidence_note}"
        )

    def _format_statutes(self, statutes: List[Any]) -> str:
        lines: List[str] = []
        for item in statutes:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "未标注法规")
            article = str(item.get("article") or "未标注条款")
            quote = str(item.get("quote") or "").strip()
            if quote:
                lines.append(f"- 《{name}》{article}：{quote}")
            else:
                lines.append(f"- 《{name}》{article}")
        return "\n".join(lines) if lines else "- 暂无法条引用。"

    def _format_cases(self, cases: List[Any]) -> str:
        lines: List[str] = []
        for item in cases:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "未标注案例")
            gist = str(item.get("gist") or "").strip()
            relevance = str(item.get("relevance") or "").strip()
            payload = "；".join(part for part in [gist, relevance] if part)
            lines.append(f"- {name}" + (f"：{payload}" if payload else ""))
        return "\n".join(lines) if lines else "- 暂无类案参考。"

    def _format_list(self, items: List[Any], default: str) -> str:
        lines = [f"- {str(item).strip()}" for item in items if str(item).strip()]
        return "\n".join(lines) if lines else f"- {default}"


__all__ = ["FaruiLegalService"]
