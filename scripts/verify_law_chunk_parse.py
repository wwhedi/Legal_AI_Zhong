"""
本地验证 parse_law_chunk_text（无需 pytest）。
用法（在 Legal_AI 目录下）:
  python scripts/verify_law_chunk_parse.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from services.law_chunk_parse import MISSING, parse_law_chunk_text  # noqa: E402

_SAMPLE_STANDARD = """【来源信息】法规名：中华人民共和国民法典 | 类型：法律 | 时效性：有效 | 公布日期：2020-05-28 | 生效日期：2021-01-01 | 链接：https://example.com/x
【章节】第十四章 租赁合同 第七百二十二条
【法规正文】承租人无正当理由未支付或者迟延支付租金的，出租人可以请求承租人在合理期限内支付；承租人逾期不支付的，出租人可以解除合同。"""

_SAMPLE_ALT_SEP = """【来源信息】法规名称：中华人民共和国民法典｜法规类型：法律｜效力状态：有效｜公布日期：2020-05-28｜生效日期：2021-01-01｜来源链接：https://example.com/x
【章节】第十四章 租赁合同 第七百二十二条
【法规正文】承租人无正当理由未支付或者迟延支付租金的，出租人可以请求承租人在合理期限内支付；承租人逾期不支付的，出租人可以解除合同。"""


def _dump(title: str, text: str) -> None:
    out = parse_law_chunk_text(text)
    # JSON 便于对比；source_url 可能为 null
    print(title)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    print()


if __name__ == "__main__":
    _dump("标准样例（半角 | ）", _SAMPLE_STANDARD)
    _dump("兼容样例（全角 ｜ + 法规名称/法规类型/效力状态/来源链接）", _SAMPLE_ALT_SEP)
