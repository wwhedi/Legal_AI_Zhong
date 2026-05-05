"""最小测试：parse_law_chunk_text 对典型切片格式的解析。"""

from __future__ import annotations

import unittest

from services.law_chunk_parse import parse_law_chunk_text


class TestParseLawChunkText(unittest.TestCase):
    def test_typical_chunk(self) -> None:
        sample = (
            "【来源信息】法规名：中华人民共和国劳动合同法 | 类型：法律 | 时效性：有效 | "
            "公布日期：2007-06-29 | 生效日期：2008-01-01 | 链接：https://example.com/law/123\n"
            "【章节】第四章 劳动合同的解除和终止 第三十七条\n"
            "【法规正文】劳动者提前三十日以书面形式通知用人单位，可以解除劳动合同。"
        )
        d = parse_law_chunk_text(sample)
        self.assertEqual(d["law_name"], "中华人民共和国劳动合同法")
        self.assertEqual(d["law_type"], "法律")
        self.assertEqual(d["effective_status"], "有效")
        self.assertEqual(d["publish_date"], "2007-06-29")
        self.assertEqual(d["effective_date"], "2008-01-01")
        self.assertEqual(d["source_url"], "https://example.com/law/123")
        self.assertIn("第三十七条", d["chapter"])
        self.assertIn("劳动者提前三十日", d["text"])

    def test_missing_fields_and_url(self) -> None:
        sample = "【来源信息】法规名：测试条例 | 类型：\n【章节】\n【法规正文】正文仅有此句。"
        d = parse_law_chunk_text(sample)
        self.assertEqual(d["law_name"], "测试条例")
        self.assertEqual(d["law_type"], "未提供")
        self.assertEqual(d["effective_status"], "未提供")
        self.assertIsNone(d["source_url"])
        self.assertEqual(d["text"], "正文仅有此句。")

    def test_empty(self) -> None:
        d = parse_law_chunk_text("")
        self.assertEqual(d["law_name"], "未提供")
        self.assertIsNone(d["source_url"])


if __name__ == "__main__":
    unittest.main()
