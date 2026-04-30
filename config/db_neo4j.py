from __future__ import annotations

import os
from functools import lru_cache

from neo4j import AsyncGraphDatabase, AsyncDriver


NEO4J_URI_ENV = "NEO4J_URI"
NEO4J_USERNAME_ENV = "NEO4J_USERNAME"
NEO4J_PASSWORD_ENV = "NEO4J_PASSWORD"

DEFAULT_NEO4J_URI = "bolt://localhost:7687"


@lru_cache(maxsize=1)
def get_neo4j_driver() -> AsyncDriver:
    """
    获取 Neo4j AsyncDriver 单例。

    - 实际的图查询均应通过 async/await 执行，确保不会阻塞事件循环。
    - 关闭连接可以在应用生命周期结束时统一处理。
    """

    uri = os.getenv(NEO4J_URI_ENV, DEFAULT_NEO4J_URI)
    username = os.getenv(NEO4J_USERNAME_ENV, "neo4j")
    password = os.getenv(NEO4J_PASSWORD_ENV, "password")

    return AsyncGraphDatabase.driver(uri, auth=(username, password))


__all__ = [
    "get_neo4j_driver",
]

