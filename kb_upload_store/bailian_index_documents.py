"""
只读：调用百炼 ListIndexDocuments，分页拉取索引文档列表。
不提供 Delete / Submit / Upload。
"""

from __future__ import annotations

import inspect
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

def model_to_dict(obj: Any) -> Dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    to_map = getattr(obj, "to_map", None)
    if callable(to_map):
        try:
            m = to_map()
            if isinstance(m, dict):
                return m
        except Exception:
            pass
    if hasattr(obj, "__dict__"):
        out: Dict[str, Any] = {}
        for k, v in obj.__dict__.items():
            if k.startswith("_"):
                continue
            if isinstance(v, (str, int, float, bool, list, dict, type(None))):
                out[k] = v
            else:
                out[k] = model_to_dict(v)
        return out
    return {}


def normalize_openapi_response(resp_obj: Any) -> Dict[str, Any]:
    outer = model_to_dict(resp_obj)
    body_obj = getattr(resp_obj, "body", None)
    body = model_to_dict(body_obj) if body_obj is not None else {}
    payload = body if isinstance(body, dict) and body else outer
    status_code = getattr(resp_obj, "status_code", None)
    headers = getattr(resp_obj, "headers", None)
    if not isinstance(payload, dict):
        payload = {}
    payload["_meta"] = {
        "status_code": status_code,
        "headers": headers,
    }
    return payload


def _ci_get(d: Dict[str, Any], *keys: str) -> Any:
    if not isinstance(d, dict):
        return None
    lowers = {k.lower(): k for k in d}
    for want in keys:
        w = want.lower()
        if w in lowers:
            return d[lowers[w]]
        for dk, dv in d.items():
            if str(dk).lower() == w:
                return dv
    return None


def create_bailian_client():
    try:
        from alibabacloud_tea_openapi import models as open_api_models
        from alibabacloud_bailian20231229.client import Client as BailianClient
        from alibabacloud_credentials.client import Client as CredentialClient
    except Exception as e:
        raise RuntimeError(
            "缺少阿里云百炼 Python SDK，请先安装：pip install alibabacloud-bailian20231229 "
            "alibabacloud-tea-openapi alibabacloud-tea-util alibabacloud-credentials\n"
            f"导入错误：{e}"
        ) from e

    credential = CredentialClient()
    config = open_api_models.Config(credential=credential)
    config.endpoint = "bailian.cn-beijing.aliyuncs.com"
    return BailianClient(config)


def list_index_documents_page(
    client: Any,
    workspace_id: str,
    index_id: str,
    *,
    page_number: int,
    page_size: int,
) -> Dict[str, Any]:
    """
    调用 list_index_documents_with_options；返回 normalize_openapi_response 字典。
    """
    if not hasattr(client, "list_index_documents_with_options"):
        raise RuntimeError(
            "当前 alibabacloud-bailian SDK Client 缺少 list_index_documents_with_options，"
            "请升级：pip install -U alibabacloud-bailian20231229"
        )

    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK 模型导入失败：{e}") from e

    request = bailian_models.ListIndexDocumentsRequest()
    request.index_id = index_id
    request.page_number = page_number
    request.page_size = page_size

    runtime = util_models.RuntimeOptions()
    method = client.list_index_documents_with_options
    sig = inspect.signature(method)
    kwargs: Dict[str, Any] = {}
    for name, p in sig.parameters.items():
        n = name.lower()
        if "workspace" in n:
            kwargs[name] = workspace_id
        elif "request" in n:
            kwargs[name] = request
        elif n == "headers":
            kwargs[name] = {}
        elif n == "runtime":
            kwargs[name] = runtime
        elif p.default is inspect._empty:
            raise RuntimeError(f"list_index_documents_with_options 未知必填参数：{name}")
    resp = method(**kwargs)
    return normalize_openapi_response(resp)


def flatten_remote_documents(norm: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Optional[int]]:
    """从单次响应中取出文档列表与 TotalCount（若有）。"""
    data = _ci_get(norm, "data", "Data")
    if not isinstance(data, dict):
        data = {}
    docs_raw = _ci_get(data, "documents", "Documents")
    total = _ci_get(data, "total_count", "TotalCount")
    total_i: Optional[int] = None
    if total is not None:
        try:
            total_i = int(total)
        except (TypeError, ValueError):
            total_i = None

    out: List[Dict[str, Any]] = []
    if not isinstance(docs_raw, list):
        return out, total_i

    for item in docs_raw:
        d = model_to_dict(item) if not isinstance(item, dict) else dict(item)
        rid = str(_ci_get(d, "id", "Id") or "").strip()
        name = str(_ci_get(d, "name", "Name") or "").strip()
        sid = str(_ci_get(d, "source_id", "SourceId") or "").strip()
        st = str(_ci_get(d, "status", "Status") or "").strip()
        doc_id = str(_ci_get(d, "doc_id", "DocId", "document_id", "DocumentId") or "").strip()
        out.append(
            {
                "_raw": d,
                "remote_document_id": rid,
                "remote_document_name": name,
                "remote_source_id": sid,
                "remote_doc_id_field": doc_id,
                "remote_status": st,
            }
        )
    return out, total_i


def list_all_index_documents(
    workspace_id: str,
    index_id: str,
    *,
    page_size: int = 50,
    max_documents: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    分页拉取索引文档，直到无更多数据或达到 max_documents。
    返回 (documents_flat, meta)。
    """
    client = create_bailian_client()
    merged: List[Dict[str, Any]] = []
    meta: Dict[str, Any] = {"pages_fetched": 0, "last_page_empty": False}
    page = 1
    reported_total: Optional[int] = None

    while True:
        if max_documents is not None and len(merged) >= max_documents:
            break
        norm = list_index_documents_page(
            client,
            workspace_id,
            index_id,
            page_number=page,
            page_size=page_size,
        )
        succ = _ci_get(norm, "success", "Success")
        code = str(_ci_get(norm, "code", "Code") or "").strip()
        if succ is False:
            raise RuntimeError(
                f"ListIndexDocuments 业务失败：Code={code} Message={_ci_get(norm, 'message', 'Message')} "
                f"RequestId={_ci_get(norm, 'request_id', 'RequestId')}"
            )
        if code and code.casefold() not in ("success", "200", "ok"):
            raise RuntimeError(
                f"ListIndexDocuments 业务失败：Code={code} Message={_ci_get(norm, 'message', 'Message')} "
                f"RequestId={_ci_get(norm, 'request_id', 'RequestId')}"
            )

        batch, total_i = flatten_remote_documents(norm)
        meta["pages_fetched"] = page
        if reported_total is None and total_i is not None:
            reported_total = total_i
            meta["total_count_reported"] = reported_total

        if not batch:
            meta["last_page_empty"] = True
            break

        for doc in batch:
            if max_documents is not None and len(merged) >= max_documents:
                break
            merged.append(doc)

        if len(batch) < page_size:
            break
        page += 1

    meta["total_fetched"] = len(merged)
    return merged, meta


def _export_name_candidates(export_file_name: str, export_file_path: str) -> Set[str]:
    out: Set[str] = set()
    for s in (export_file_name or "",):
        t = str(s).strip()
        if not t:
            continue
        out.add(t)
        out.add(Path(t).name)
        stem = Path(t).stem
        if stem:
            out.add(stem)
    p = str(export_file_path or "").strip()
    if p:
        out.add(Path(p).name)
        stem = Path(p).stem
        if stem:
            out.add(stem)
    return {x for x in out if x}


def _remote_name_candidates(remote_name: str) -> Set[str]:
    t = str(remote_name or "").strip()
    if not t:
        return set()
    return {t, Path(t).name, Path(t).stem} - {""}


def _metadata_kv_match(raw: Dict[str, Any], law_id: str, version_hash: str) -> bool:
    """若远端 raw 中存在 metadata 类节点且包含 law_id / version_hash 精确字段命中。"""
    lid = str(law_id or "").strip()
    vid = str(version_hash or "").strip()
    if not lid and not vid:
        return False

    def check_obj(obj: Any) -> bool:
        if isinstance(obj, dict):
            for k, v in obj.items():
                kn = str(k).lower().replace("_", "")
                if kn in ("lawid", "law_id") and lid and str(v).strip() == lid:
                    return True
                if kn in ("versionhash", "version_hash", "contentsha256", "content_sha256"):
                    if vid and str(v).strip() == vid:
                        return True
                if kn in ("metadata", "metadatas", "custommeta", "tags") or "meta" in kn:
                    if check_obj(v):
                        return True
                if check_obj(v):
                    return True
        elif isinstance(obj, list):
            for x in obj:
                if check_obj(x):
                    return True
        return False

    return check_obj(raw)


def try_match_local_remote(local: Dict[str, Any], remote: Dict[str, Any]) -> Optional[str]:
    """
    返回匹配规则标签；优先级 A > B > C > D > E（调用方按此顺序尝试）。
    """
    fid = str(local.get("bailian_file_id") or "").strip()
    rid = str(remote.get("remote_document_id") or "").strip()
    rsid = str(remote.get("remote_source_id") or "").strip()
    rdoc = str(remote.get("remote_doc_id_field") or "").strip()
    rname = str(remote.get("remote_document_name") or "").strip()
    raw = remote.get("_raw") if isinstance(remote.get("_raw"), dict) else {}

    if fid:
        if rid and rid == fid:
            return "A_remote.Id_eq_local.bailian_file_id"
        if rsid and rsid == fid:
            return "B_remote.SourceId_eq_local.bailian_file_id"
        if rdoc and rdoc == fid:
            return "C_remote.DocId_eq_local.bailian_file_id"

    lcands = _export_name_candidates(
        str(local.get("export_file_name") or ""),
        str(local.get("export_file_path") or ""),
    )
    rcands = _remote_name_candidates(rname)
    if lcands and rcands:
        lf = {x.casefold() for x in lcands}
        rf = {x.casefold() for x in rcands}
        if lf & rf:
            return "D_remote.Name_eq_export_file_name_or_stem"

    lid = str(local.get("law_id") or "").strip()
    vid = str(local.get("version_hash") or "").strip()
    if raw and _metadata_kv_match(raw, lid, vid):
        return "E_remote.metadata_law_id_or_version_hash"

    return None


def compute_document_matches(
    local_rows: List[Dict[str, Any]],
    remote_documents: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[int], List[str]]:
    """
    贪心地为每条本地记录最多匹配一条远端文档；每条远端文档最多匹配一条本地记录。
    本地按 updated_at DESC（字符串排序兜底）。
    """
    sorted_locals = sorted(
        local_rows,
        key=lambda r: str(r.get("updated_at") or ""),
        reverse=True,
    )
    used_remote: Set[int] = set()
    used_local_id: Set[str] = set()
    matches: List[Dict[str, Any]] = []

    for loc in sorted_locals:
        pk = str(loc.get("id") or "").strip()
        if pk in used_local_id:
            continue
        for ri, rem in enumerate(remote_documents):
            if ri in used_remote:
                continue
            chosen = try_match_local_remote(loc, rem)
            if not chosen:
                continue
            matches.append(
                {
                    "law_id": loc.get("law_id"),
                    "version_hash": loc.get("version_hash"),
                    "local_bailian_file_id": loc.get("bailian_file_id"),
                    "local_bailian_job_id": loc.get("bailian_job_id"),
                    "remote_document_id": rem.get("remote_document_id"),
                    "remote_document_name": rem.get("remote_document_name"),
                    "remote_status": rem.get("remote_status"),
                    "match_method": chosen,
                }
            )
            used_remote.add(ri)
            used_local_id.add(pk)
            break

    unmatched_remote = [i for i in range(len(remote_documents)) if i not in used_remote]
    unmatched_local = [str(r.get("id") or "") for r in local_rows if str(r.get("id") or "").strip() not in used_local_id]
    return matches, unmatched_remote, unmatched_local


def parse_bbbs_from_law_id(law_id: str) -> Optional[str]:
    """若 law_id 为 bbbs:xxx，返回 xxx；否则 None。"""
    s = str(law_id or "").strip()
    if not s:
        return None
    if s.lower().startswith("bbbs:"):
        tail = s.split(":", 1)[1].strip()
        return tail or None
    return None


_NON_DELETE_REMOTE_STATUSES = frozenset(
    {
        "RUNNING",
        "PENDING",
        "PROCESSING",
        "INSERT_ERROR",
        "DELETED",
        "TIMEOUT",
    }
)


def plan_old_version_delete_dry_run(
    local_rows: List[Dict[str, Any]],
    remote_documents: List[Dict[str, Any]],
    *,
    keep_latest: int = 1,
    managed_only: bool = True,
) -> Dict[str, Any]:
    """
    仅生成删除预览（dry-run），不调用 DeleteIndexDocument，不写库。
    managed_only=True：仅处理 kb_upload_records 中出现的 law_id，并按 bbbs / file_id 收敛远端子集。
    """
    if not managed_only:
        raise ValueError("当前仅实现 scope=managed-only；请勿关闭 managed-only。")

    k = max(1, int(keep_latest))

    by_law: Dict[str, List[Dict[str, Any]]] = {}
    for row in local_rows:
        lid = str(row.get("law_id") or "").strip()
        if not lid:
            continue
        by_law.setdefault(lid, []).append(dict(row))

    law_groups: List[Dict[str, Any]] = []
    total_delete = 0
    total_blocked = 0
    total_keep = 0

    for law_id in sorted(by_law.keys()):
        locals_for_law = by_law[law_id]
        bbbs = parse_bbbs_from_law_id(law_id)
        local_fids: Set[str] = set()
        for r in locals_for_law:
            fid = str(r.get("bailian_file_id") or "").strip()
            if fid:
                local_fids.add(fid)

        remotes_for_law: List[Dict[str, Any]] = []
        for rem in remote_documents:
            rid = str(rem.get("remote_document_id") or "").strip()
            rsid = str(rem.get("remote_source_id") or "").strip()
            rdoc = str(rem.get("remote_doc_id_field") or "").strip()
            name = str(rem.get("remote_document_name") or "").strip()
            if rid and rid in local_fids:
                remotes_for_law.append(rem)
                continue
            if rsid and rsid in local_fids:
                remotes_for_law.append(rem)
                continue
            if rdoc and rdoc in local_fids:
                remotes_for_law.append(rem)
                continue
            if bbbs and bbbs in name:
                remotes_for_law.append(rem)
                continue

        finish_locals = [
            r
            for r in locals_for_law
            if str(r.get("upload_status") or "").strip().upper() == "FINISH"
            and str(r.get("index_status") or "").strip().upper() == "FINISH"
        ]
        finish_locals.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
        keep_locals = finish_locals[:k]
        keep_remote_ids: Set[str] = set()
        for r in keep_locals:
            fid = str(r.get("bailian_file_id") or "").strip()
            if fid:
                keep_remote_ids.add(fid)

        keep_docs: List[Dict[str, Any]] = []
        delete_cands: List[Dict[str, Any]] = []
        blocked: List[Dict[str, Any]] = []

        seen_keep_rid: Set[str] = set()
        for rem in remotes_for_law:
            rid = str(rem.get("remote_document_id") or "").strip()
            name = str(rem.get("remote_document_name") or "").strip()
            st_raw = str(rem.get("remote_status") or "").strip()
            st = st_raw.upper()

            matched_bbbs = (bbbs or "") if (bbbs and bbbs in name) else (bbbs or "")

            base_doc = {
                "remote_document_id": rid,
                "remote_document_name": name,
                "remote_status": st_raw,
            }

            if st == "FINISH":
                if rid in keep_remote_ids:
                    if rid not in seen_keep_rid:
                        keep_docs.append({**base_doc, "matched_bbbs": matched_bbbs or bbbs or ""})
                        seen_keep_rid.add(rid)
                    else:
                        blocked.append(
                            {
                                **base_doc,
                                "matched_bbbs": matched_bbbs or bbbs or "",
                                "reason": "重复出现的同一 remote_document_id（保留首条，其余不删除）",
                            }
                        )
                else:
                    delete_cands.append(
                        {
                            **base_doc,
                            "matched_bbbs": matched_bbbs or bbbs or "",
                            "reason": "FINISH 且不在保留集合（旧版本或重复索引文档；对应本地 keep_latest 策略）",
                        }
                    )
            elif st in _NON_DELETE_REMOTE_STATUSES or st == "":
                blocked.append(
                    {
                        **base_doc,
                        "matched_bbbs": matched_bbbs or bbbs or "",
                        "reason": f"远端状态 {st_raw or '<空>'} 不列为自动删除候选",
                    }
                )
            else:
                blocked.append(
                    {
                        **base_doc,
                        "matched_bbbs": matched_bbbs or bbbs or "",
                        "reason": f"未识别远端状态 {st_raw}，保守列入 blocked",
                    }
                )

        reason_parts = [
            f"managed law_id；远端收敛：bbbs 命中文档名 或 document Id/SourceId 落在本地该 law 的 bailian_file_id 集合",
            f"保留本地 FINISH 且 updated_at 最新的前 {k} 条对应的 bailian_file_id（远端 Id）",
        ]
        if not finish_locals:
            reason_parts.append("警告：该 law 无 FINISH 本地锚点，保留集合可能为空，删除候选仍仅限 FINISH 且非保留")

        law_groups.append(
            {
                "law_id": law_id,
                "bbbs": bbbs,
                "local_records": locals_for_law,
                "remote_documents_for_law": remotes_for_law,
                "keep_documents": keep_docs,
                "delete_candidates": delete_cands,
                "blocked_candidates": blocked,
                "reason": "；".join(reason_parts),
            }
        )
        total_delete += len(delete_cands)
        total_blocked += len(blocked)
        total_keep += len(keep_docs)

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "keep_latest": k,
        "scope": "managed-only",
        "dry_run": True,
        "managed_law_count": len(law_groups),
        "delete_candidate_count": total_delete,
        "blocked_candidate_count": total_blocked,
        "keep_count": total_keep,
        "law_groups": law_groups,
        "notes": [
            "本报告仅为 dry-run，未调用 DeleteIndexDocument，未修改 kb_upload_records，未修改远端",
            "删除候选仅包含 managed law 范围内、远端 FINISH 且非保留的文档",
            "生产使用前必须人工审查 JSON",
        ],
    }

