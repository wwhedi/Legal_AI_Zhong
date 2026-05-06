"""
知识库切片纯文本解析（仅标准库，供 AliyunKBService 与单测使用）。
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

MISSING = "未提供"

_ARTICLE_NO_RE = re.compile(r"第[0-9零一二三四五六七八九十百千万〇两]+条")

# 来源信息 key → 内部字段（同一字段多个别名；较长标签优先参与正则匹配）
_LABEL_TO_FIELD: Dict[str, str] = {
    # law_name
    "法规名称": "law_name",
    "法规名": "law_name",
    "名称": "law_name",
    # law_type
    "法规类型": "law_type",
    "文件类型": "law_type",
    "类型": "law_type",
    # effective_status
    "效力状态": "effective_status",
    "时效状态": "effective_status",
    "时效性": "effective_status",
    # publish_date
    "公布日期": "publish_date",
    "发布日期": "publish_date",
    # effective_date
    "生效日期": "effective_date",
    "施行日期": "effective_date",
    "实施日期": "effective_date",
    # source_url
    "来源链接": "source_url",
    "链接": "source_url",
    "URL": "source_url",
    "url": "source_url",
}

_LABELS_SORTED: List[str] = sorted(_LABEL_TO_FIELD.keys(), key=len, reverse=True)
_SOURCE_PART_SPLIT_RE = re.compile(r"\s*[\|｜]\s*")
_SOURCE_KV_RE = re.compile(
    "^(" + "|".join(re.escape(k) for k in _LABELS_SORTED) + r")\s*[:：]\s*(.*)$",
    re.DOTALL,
)


def parse_law_chunk_text(text: str) -> Dict[str, Any]:
    """
    从知识库切片纯文本解析结构化字段（不调用外部服务）。

    典型格式：
    【来源信息】法规名：... | 类型：... | ...
    或全角分隔符：法规名称：...｜法规类型：...｜...
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
        for part in _SOURCE_PART_SPLIT_RE.split(seg):
            p = part.strip()
            if not p:
                continue
            m = _SOURCE_KV_RE.match(p)
            if not m:
                continue
            label, val = m.group(1), m.group(2).strip()
            if not val:
                continue
            field = _LABEL_TO_FIELD.get(label)
            if not field:
                continue
            if field == "source_url":
                base["source_url"] = val if val else None
            else:
                base[field] = val

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
