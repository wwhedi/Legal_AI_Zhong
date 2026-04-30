from __future__ import annotations

import os
from functools import lru_cache
from typing import AsyncIterator, Optional
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy import Boolean, DateTime, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

POSTGRES_DSN_ENV = "POSTGRES_DSN"
DEFAULT_POSTGRES_DSN = "postgresql+asyncpg://user:password@localhost:5432/legal_ai"


class Base(DeclarativeBase):
    pass


class RegulationChangeRecord(Base):
    """
    PostgreSQL 持久化表：法规变更检测记录（待审核列表数据源）。
    """

    __tablename__ = "regulation_change_records"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    regulation_id: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    regulation_title: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    changed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    old_md5: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    new_md5: Mapped[str] = mapped_column(String(32), nullable=False)
    old_sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    new_sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending_review", index=True)

    new_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)  # type: ignore[type-arg]
    old_payload: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)  # type: ignore[type-arg]

    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[object] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        Index("ix_reg_change_status_created_at", "status", "created_at"),
        Index("ix_reg_change_regid_created_at", "regulation_id", "created_at"),
    )


@lru_cache(maxsize=1)
def get_async_engine() -> AsyncEngine:
    """
    创建全局复用的 AsyncEngine。

    注意：
    - 所有数据库 I/O 必须通过 async Session 完成，遵守项目的 async/await 规范。
    - 具体的表模型与 CRUD 逻辑将在后续阶段补充。
    """

    dsn = os.getenv(POSTGRES_DSN_ENV, DEFAULT_POSTGRES_DSN)
    return create_async_engine(
        dsn,
        echo=False,
        future=True,
        pool_pre_ping=True,
    )


@lru_cache(maxsize=1)
def get_async_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind=get_async_engine(),
        expire_on_commit=False,
        autoflush=False,
        autocommit=False,
    )


async def get_db_session() -> AsyncIterator[AsyncSession]:
    """
    FastAPI 依赖中使用的 Session 提供器示例：

    async def some_endpoint(session: AsyncSession = Depends(get_db_session)):
        ...
    """

    session_maker = get_async_sessionmaker()
    async with session_maker() as session:
        yield session


async def init_postgres_models() -> None:
    """
    在应用启动时创建缺失的数据表（轻量模式，后续可替换为 Alembic 迁移）。
    """

    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


__all__ = [
    "get_async_engine",
    "get_async_sessionmaker",
    "get_db_session",
    "init_postgres_models",
    "Base",
    "RegulationChangeRecord",
]

