from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from alibabacloud_bailian20231229 import models as bailian_models
from alibabacloud_bailian20231229.client import Client as BailianClient
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_tea_util import models as util_models

logger = logging.getLogger(__name__)


class AliyunKBService:
    """
    阿里云百炼（Model Studio / Bailian）知识库 Retrieve API 封装。

    参考：Retrieve API（OpenAPI Bailian 2023-12-29）
    - 通过 AK/SK（ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET）鉴权
    - 通过 BAILIAN_WORKSPACE_ID / BAILIAN_INDEX_ID 指定知识库
    """

    def __init__(self) -> None:
        # Official Retrieve OpenAPI uses AK/SK.
        # Keep FARUI_* as fallback to remain compatible with existing project env files.
        self.access_key_id = (
            os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
        ).strip()
        self.access_key_secret = (
            os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        ).strip()
        self.endpoint = (os.getenv("BAILIAN_ENDPOINT") or "bailian.cn-beijing.aliyuncs.com").strip()
        self.workspace_id = (os.getenv("BAILIAN_WORKSPACE_ID") or "").strip()
        self.index_id = (os.getenv("BAILIAN_INDEX_ID") or "").strip()
        self.timeout_seconds = float(os.getenv("BAILIAN_TIMEOUT_SECONDS", "25"))

        self.rerank_top_n = int(os.getenv("BAILIAN_RERANK_TOP_N", "6"))

    def _create_client(self) -> BailianClient:
        config = open_api_models.Config(
            access_key_id=self.access_key_id,
            access_key_secret=self.access_key_secret,
        )
        config.endpoint = self.endpoint
        return BailianClient(config)

    def _validate(self) -> None:
        missing: List[str] = []
        if not self.access_key_id:
            missing.append("ALIBABA_CLOUD_ACCESS_KEY_ID")
        if not self.access_key_secret:
            missing.append("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        if not self.workspace_id:
            missing.append("BAILIAN_WORKSPACE_ID")
        if not self.index_id:
            missing.append("BAILIAN_INDEX_ID")
        if missing:
            raise RuntimeError("Missing required env vars for Bailian KB: " + ", ".join(missing))

    def retrieve_index(
        self,
        client: BailianClient,
        workspace_id: str,
        index_id: str,
        query: str,
        search_filters: Optional[List[Dict[str, Any]]] = None,
    ) -> Any:
        """
        在指定知识库中检索信息（与阿里云 Retrieve 示例保持一致）。

        参数:
            client: 阿里云百炼客户端。
            workspace_id: 业务空间 ID。
            index_id: 知识库 ID。
            query: 原始输入 prompt。
            search_filters: 可选检索过滤条件（例如标签过滤）。

        返回:
            百炼 Retrieve API 响应对象。
        """
        headers: Dict[str, str] = {}
        retrieve_request = bailian_models.RetrieveRequest(
            index_id=index_id,
            query=query,
            search_filters=search_filters,
        )
        runtime = util_models.RuntimeOptions(
            read_timeout=int(self.timeout_seconds * 1000),
            connect_timeout=5000,
        )
        return client.retrieve_with_options(workspace_id, retrieve_request, headers, runtime)

    def _extract_nodes(self, data: Any) -> List[Dict[str, Any]]:
        if not isinstance(data, dict):
            return []
        d = data.get("Data")
        if not isinstance(d, dict):
            return []
        nodes = d.get("Nodes")
        return nodes if isinstance(nodes, list) else []

    def _short_query(self, query: str, limit: int = 120) -> str:
        text = (query or "").strip().replace("\n", " ")
        if len(text) <= limit:
            return text
        return text[:limit] + "..."

    def _log_retrieve_response(self, body: Dict[str, Any], query: str) -> None:
        data = body.get("Data") if isinstance(body.get("Data"), dict) else {}
        nodes = data.get("Nodes") if isinstance(data, dict) else []
        node_count = len(nodes) if isinstance(nodes, list) else 0
        logger.info(
            (
                "Bailian retrieve response: workspace_id=%s index_id=%s success=%s "
                "code=%s message=%s request_id=%s node_count=%s query=%s"
            ),
            self.workspace_id,
            self.index_id,
            body.get("Success"),
            body.get("Code"),
            body.get("Message"),
            body.get("RequestId"),
            node_count,
            self._short_query(query),
        )

    def _node_to_citation(self, node: Dict[str, Any], ref_id: str) -> Dict[str, Any]:
        meta = node.get("Metadata") if isinstance(node.get("Metadata"), dict) else {}
        title = str(meta.get("title") or meta.get("hier_title") or meta.get("doc_name") or "知识库文档").strip()
        doc_id = str(meta.get("doc_id") or meta.get("nid") or meta.get("_id") or "").strip()
        score = node.get("Score")
        try:
            score_f = float(score)
        except Exception:
            score_f = 0.0
        return {
            "ref_id": ref_id,
            "law_name": title,
            "article": (doc_id or "KB"),
            "status": "valid",
            "status_display": "【阿里云知识库】",
            "score": max(0.0, min(score_f, 1.0)),
            "verified": True,
            "verify_source": "kb_retrieved",
        }

    def _format_context(self, query: str, nodes: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
        citations: List[Dict[str, Any]] = []
        ref_lines: List[str] = []
        snippets: List[str] = []

        for idx, node in enumerate(nodes[: max(1, self.rerank_top_n)], start=1):
            if not isinstance(node, dict):
                continue
            text = str(node.get("Text") or "").strip()
            if not text:
                continue

            ref_id = f"[{idx}]"
            citation = self._node_to_citation(node, ref_id=ref_id)
            citations.append(citation)

            display_name = str(citation.get("law_name") or "知识库文档").strip()
            ref_lines.append(f"{ref_id} {display_name}")
            snippets.append(f"{ref_id} {text}")

        context = (
            "[阿里云知识库检索背景]\n"
            f"用户问题：{query}\n\n"
            "召回片段（可引用编号）：\n"
            + ("\n".join(snippets) if snippets else "- 暂无可用召回片段。")
        )
        return context, citations, ref_lines

    async def retrieve(self, query: str) -> Dict[str, Any]:
        self._validate()
        q = (query or "").strip()
        if not q:
            return {"context": "", "citations": [], "ref_lines": []}
        logger.info(
            "Bailian retrieve request: workspace_id=%s index_id=%s query=%s",
            self.workspace_id,
            self.index_id,
            self._short_query(q),
        )

        async def _call() -> Dict[str, Any]:
            client = self._create_client()
            response = await asyncio.to_thread(
                self.retrieve_index,
                client,
                self.workspace_id,
                self.index_id,
                q,
            )
            data = response.to_map() if hasattr(response, "to_map") else response
            body = data.get("body") if isinstance(data, dict) else None
            if isinstance(body, dict):
                self._log_retrieve_response(body, q)
            if isinstance(body, dict) and body.get("Success") is False:
                raise RuntimeError(
                    f"Bailian retrieve failed: Code={body.get('Code')} Message={body.get('Message')}"
                )
            if isinstance(body, dict):
                return body
            logger.info(
                "Bailian retrieve response (non-standard): workspace_id=%s index_id=%s query=%s",
                self.workspace_id,
                self.index_id,
                self._short_query(q),
            )
            return data if isinstance(data, dict) else {"raw": str(data)}

        try:
            raw = await asyncio.wait_for(_call(), timeout=self.timeout_seconds + 5.0)
        except Exception:
            logger.exception(
                "Bailian retrieve error: workspace_id=%s index_id=%s query=%s",
                self.workspace_id,
                self.index_id,
                self._short_query(q),
            )
            raise
        nodes = self._extract_nodes(raw)
        context, citations, ref_lines = self._format_context(q, nodes)
        logger.info(
            "Bailian retrieve parsed result: workspace_id=%s index_id=%s citations=%s nodes=%s",
            self.workspace_id,
            self.index_id,
            len(citations),
            len(nodes),
        )
        return {
            "context": context,
            "citations": citations,
            "ref_lines": ref_lines,
            "nodes": nodes,
        }

    async def ping(self) -> str:
        """
        轻量连通性检查：对固定 query 做一次检索。
        """
        result = await self.retrieve("请返回一条可用的知识库片段示例。")
        if not (result.get("citations") or []) and not (result.get("context") or "").strip():
            return "ok_but_empty"
        return "ok"


__all__ = ["AliyunKBService"]

