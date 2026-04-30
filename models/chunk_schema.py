from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class EffectiveStatus(str, Enum):
    """
    生效状态
    """

    VALID = "valid"  # 现行有效
    REVISED = "revised"  # 已被修订（有后续版本）
    REPEALED = "repealed"  # 已废止
    INVALID = "invalid"  # 其他无效状态（如被宣告违宪）


class LawLevel(str, Enum):
    """
    法律层级
    """

    CONSTITUTION = "constitution"  # 宪法
    LAW = "law"  # 法律
    ADMIN_REGULATION = "administrative_regulation"  # 行政法规
    JUDICIAL_INTERPRETATION = "judicial_interpretation"  # 司法解释
    LOCAL_REGULATION = "local_regulation"  # 地方性法规
    NORMATIVE_DOCUMENT = "normative_document"  # 规范性文件 / 部门规章


class ChangeType(str, Enum):
    """
    变更类型（用于知识库版本管理与审核）
    """

    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    MERGE = "merge"
    SPLIT = "split"


class RegulationChunk(BaseModel):
    """
    法规切片（Chunk）基础结构
    """

    id: UUID = Field(default_factory=uuid4)
    regulation_id: str = Field(..., description="所属法规的唯一标识，例如法典 ID")
    law_level: LawLevel = Field(..., description="法规层级")
    effective_status: EffectiveStatus = Field(..., description="生效状态")
    change_type: Optional[ChangeType] = Field(
        default=None, description="该 Chunk 最近一次操作的变更类型"
    )

    article_number: Optional[str] = Field(
        default=None, description="条文号，例如 '第十条'、'第 20 条'"
    )
    clause_path: Optional[str] = Field(
        default=None,
        description="在法规结构树中的路径，如 '总则/第一章/第十条'",
    )
    title: Optional[str] = Field(default=None, description="本条/本款的小标题（如有）")
    text: str = Field(..., description="法规原文切片内容")

    tokens: Optional[int] = Field(
        default=None, description="文本 token 数，便于控制上下文长度"
    )
    embedding_id: Optional[str] = Field(
        default=None, description="向量在向量库中的主键 ID"
    )

    source: Optional[str] = Field(
        default=None,
        description="数据来源（官方/第三方/自建等），用于溯源审计",
    )
    source_url: Optional[str] = Field(
        default=None,
        description="法规原始链接或数据源地址",
    )

    version: int = Field(default=1, description="法规切片版本号")
    is_deleted: bool = Field(default=False, description="软删除标记，用于逻辑删除")

    created_at: datetime = Field(
        default_factory=datetime.utcnow, description="记录创建时间（UTC）"
    )
    updated_at: datetime = Field(
        default_factory=datetime.utcnow, description="记录最近更新时间（UTC）"
    )

    tags: List[str] = Field(
        default_factory=list,
        description="与本 Chunk 相关的标签，如适用领域/行业/关键词等",
    )


__all__ = [
    "EffectiveStatus",
    "LawLevel",
    "ChangeType",
    "RegulationChunk",
]

