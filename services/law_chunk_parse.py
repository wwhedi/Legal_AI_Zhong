"""
知识库切片纯文本解析（仅标准库，供 AliyunKBService 与单测使用）。
"""

from __future__ import annotations

import re
from typing import Any, Dict

MISSING = "未提供"

_ARTICLE_NO_RE = re.compile(r"第[0-9零一二三四五六七八九十百千万〇两]+条")


def parse_law_chunk_text(text: str) -> Dict[str, Any]:
    """
    从知识库切片纯文本解析结构化字段（不调用外部服务）。

    典型格式：
    【来源信息】法规名：... | 类型：... | 时效性：... | 公布日期：... | 生效日期：... | 链接：...
    【章节】...
    【法规正文】...

    缺失的字符串类字段返回「未提供」；source_url 缺失返回 None。不编造内容。
    """
    raw = (text or "").strip()
    base: Dict[str, Any] = {
        "law_name": MISSING,
        "law_type": MISSING,
        "effective_status": MISSING,
        "publish_date": MISSING,
        "effective_date": MISSING,
        "source_url": None,
        "chapter": MISSING,
        "text": MISSING,
    }
    if not raw:
        return base

    def _parse_source_kv(segment: str) -> None:
        seg = (segment or "").strip()
        if not seg:
            return
        for part in re.split(r"\s*\|\s*", seg):
            p = part.strip()
            if not p:
                continue
            m = re.match(r"^(法规名|类型|时效性|公布日期|生效日期|链接)\s*[:：]\s*(.*)$", p, re.DOTALL)
            if not m:
                continue
            key, val = m.group(1), m.group(2).strip()
            if not val:
                continue
            if key == "法规名":
                base["law_name"] = val
            elif key == "类型":
                base["law_type"] = val
            elif key == "时效性":
                base["effective_status"] = val
            elif key == "公布日期":
                base["publish_date"] = val
            elif key == "生效日期":
                base["effective_date"] = val
            elif key == "链接":
                base["source_url"] = val if val else None

    m_src = re.search(r"【来源信息】\s*(.*?)(?=【(?:章节|法规正文)】)", raw, re.DOTALL)
    if m_src:
        _parse_source_kv(m_src.group(1))
    elif "【来源信息】" in raw:
        tail = raw.split("【来源信息】", 1)[-1].strip()
        _parse_source_kv(tail)

    m_ch = re.search(r"【章节】\s*(.*?)(?=【法规正文】|$)", raw, re.DOTALL)
    if m_ch:
        ch = m_ch.group(1).strip()
        if ch:
            base["chapter"] = ch

    m_body = re.search(r"【法规正文】\s*(.*)$", raw, re.DOTALL)
    if m_body:
        body = m_body.group(1).strip()
        if body:
            base["text"] = body

    return base


def extract_article_number(chapter: str, body: str) -> str:
    """从章节或正文抽取条文号；抽不到则「未提供」。"""
    for src in (chapter, body):
        if not src or src == MISSING:
            continue
        m = _ARTICLE_NO_RE.search(src)
        if m:
            return m.group(0).strip()
    return MISSING


def effective_status_to_status(effective: str) -> str:
    """仅当明确为「有效」时返回 valid，否则不伪装为 valid。"""
    s = (effective or "").strip()
    if not s or s == MISSING:
        return "unknown"
    if s == "有效":
        return "valid"
    return "non_valid"


__all__ = [
    "MISSING",
    "parse_law_chunk_text",
    "extract_article_number",
    "effective_status_to_status",
]
