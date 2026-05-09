#!/usr/bin/env python3
"""
本地一次性工具：从标准输入读取密码（不回显），打印 bcrypt 哈希供填入 AUTH_USERS_JSON。

请勿将生成的哈希与明文密码提交到版本库；不要修改本脚本嵌入真实密码。
"""

from __future__ import annotations

import getpass
import sys


def main() -> None:
    try:
        import bcrypt
    except ImportError:
        print(
            "错误：未安装 bcrypt。\n"
            "请安装：pip install bcrypt\n"
            "（或与项目一致：pip install -r requirements.txt）",
            file=sys.stderr,
        )
        sys.exit(1)

    password = getpass.getpass("请输入密码（不回显）: ")

    if not password:
        print("错误：密码不能为空。", file=sys.stderr)
        sys.exit(1)

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
    # 立刻丢弃明文引用，便于 GC（无法防止终端/内存交换区残留，请勿在共享环境输入生产密码）
    del password

    print(hashed.decode("ascii"))


if __name__ == "__main__":
    main()
