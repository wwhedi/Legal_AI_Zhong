import hashlib
import inspect
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

_LEGAL_AI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _LEGAL_AI_ROOT not in sys.path:
    sys.path.insert(0, _LEGAL_AI_ROOT)

from kb_upload_store.db import get_kb_upload_db_path, init_kb_upload_db
from kb_upload_store.service import (
    classify_upload_skip,
    compute_law_id,
    compute_version_hash,
    extract_bailian_job_id,
    fetch_record,
    law_name_from_row,
    update_after_index_error,
    update_after_index_submitted,
    update_after_parse_failure,
    update_after_parse_success_terminal,
    update_record_index_finish,
    update_record_index_timeout,
    update_record_index_unknown,
    update_records_index_running,
    upsert_after_add_file,
    upsert_after_upload_failure,
)

# 避免 Windows/GBK 控制台在打印生僻字时抛出 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    # 某些运行环境可能不支持 reconfigure
    pass


DIC = {
    "xf": "宪法",
    "flfg": "法律",
    "xzfg": "行政法规",
    "jcfg": "监察法规",
    "sfjs": "司法解释",
    "dfxfg": "地方法规",
}


def load_env_file(env_path: str) -> Dict[str, str]:
    """
    Lightweight .env loader (no third-party dependency).
    Also injects keys into os.environ if not already present.
    """
    out: Dict[str, str] = {}
    if not os.path.exists(env_path):
        return out
    with open(env_path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            key = k.strip()
            val = v.strip().strip('"').strip("'")
            if not key:
                continue
            out[key] = val
            if key not in os.environ:
                os.environ[key] = val
    return out


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def md5_file(file_path: str) -> str:
    md5_hash = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            md5_hash.update(chunk)
    return md5_hash.hexdigest()


def model_to_dict(obj: Any) -> Dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    to_map = getattr(obj, "to_map", None)
    if callable(to_map):
        try:
            return to_map()
        except Exception:
            pass
    body = getattr(obj, "body", None)
    if body is not None and body is not obj:
        b = model_to_dict(body)
        if b:
            return b
    if hasattr(obj, "__dict__"):
        out = {}
        for k, v in obj.__dict__.items():
            if k.startswith("_"):
                continue
            if isinstance(v, (str, int, float, bool, list, dict, type(None))):
                out[k] = v
            else:
                out[k] = model_to_dict(v)
        return out
    return {}


def _get_case_insensitive(d: Dict[str, Any], key: str, default=None):
    if key in d:
        return d[key]
    key_low = key.lower()
    key_norm = re.sub(r"[_\-\s]", "", key_low)
    for k, v in d.items():
        k_low = str(k).lower()
        k_norm = re.sub(r"[_\-\s]", "", k_low)
        if k_low == key_low or k_norm == key_norm:
            return v
    return default


def normalize_openapi_response(resp_obj: Any) -> Dict[str, Any]:
    """
    Normalize Alibaba OpenAPI SDK response:
    prefer business payload from resp.body, keep a small _meta.
    """
    outer = model_to_dict(resp_obj)
    body_obj = getattr(resp_obj, "body", None)
    body = model_to_dict(body_obj) if body_obj is not None else {}
    payload = body if isinstance(body, dict) and body else outer

    status_code = getattr(resp_obj, "status_code", None)
    headers = getattr(resp_obj, "headers", None)
    request_id = _get_case_insensitive(payload if isinstance(payload, dict) else {}, "RequestId", "")
    code = _get_case_insensitive(payload if isinstance(payload, dict) else {}, "Code", "")
    message = _get_case_insensitive(payload if isinstance(payload, dict) else {}, "Message", "")
    success = _get_case_insensitive(payload if isinstance(payload, dict) else {}, "Success", "")

    if not isinstance(payload, dict):
        payload = {}
    payload["_meta"] = {
        "status_code": status_code,
        "request_id": request_id,
        "code": code,
        "message": message,
        "success": success,
        "headers": headers,
    }
    return payload


def create_bailian_client():
    """
    与官方示例一致：使用 CredentialClient 初始化账号 Client。
    优先使用阿里云凭证链（环境变量/配置文件/角色等），不在代码中硬编码AK。
    """
    try:
        from alibabacloud_tea_openapi import models as open_api_models
        from alibabacloud_bailian20231229.client import Client as BailianClient
        from alibabacloud_credentials.client import Client as CredentialClient
    except Exception as e:
        print("缺少阿里云百炼Python SDK，请先安装：")
        print("pip install alibabacloud-bailian20231229 alibabacloud-tea-openapi alibabacloud-tea-util alibabacloud-credentials")
        raise RuntimeError(f"SDK导入失败：{e}")

    credential = CredentialClient()
    config = open_api_models.Config(credential=credential)
    config.endpoint = "bailian.cn-beijing.aliyuncs.com"
    return BailianClient(config)


def update_index_name(client, workspace_id: str, index_id: str, index_name: str) -> Dict[str, Any]:
    """
    Update knowledge base(Index) name via UpdateIndex API.
    This is separate from file upload category_id.
    """
    if not index_id or not index_name:
        return {"skipped": True, "reason": "missing index_id or index_name"}
    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")

    req = bailian_models.UpdateIndexRequest(
        id=index_id,
        name=index_name,
    )
    runtime = util_models.RuntimeOptions()
    resp = client.update_index_with_options(workspace_id, req, {}, runtime)
    return normalize_openapi_response(resp)


def apply_upload_lease(client, category_id: str, file_path: str, workspace_id: str):
    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")

    file_name = os.path.basename(file_path)
    file_md5 = md5_file(file_path)
    file_size = os.path.getsize(file_path)
    request = bailian_models.ApplyFileUploadLeaseRequest(
        file_name=file_name,
        md_5=file_md5,
        size_in_bytes=file_size,
    )
    runtime = util_models.RuntimeOptions()
    resp = client.apply_file_upload_lease_with_options(category_id, workspace_id, request, {}, runtime)
    return normalize_openapi_response(resp)


def upload_file_to_presigned_url(lease_dict: Dict[str, Any], file_path: str):
    data = _get_case_insensitive(lease_dict, "data", {}) or {}
    if not isinstance(data, dict):
        data = model_to_dict(data)
    param = _get_case_insensitive(data, "param", {}) or {}
    if not isinstance(param, dict):
        param = model_to_dict(param)
    url = _get_case_insensitive(param, "url", "")
    method = (_get_case_insensitive(param, "method", "PUT") or "PUT").upper()
    headers_raw = _get_case_insensitive(param, "headers", {}) or {}
    headers: Dict[str, str] = {}
    if isinstance(headers_raw, dict):
        headers = {str(k): str(v) for k, v in headers_raw.items()}
    elif isinstance(headers_raw, str):
        # 官方返回中 Headers 可能是字符串（含换行、转义双引号），优先按 JSON-ish 文本解析。
        raw = headers_raw.strip()
        parsed: Dict[str, Any] = {}
        candidates = [
            raw,
            "{" + raw + "}",
            raw.replace('\\"', '"'),
            "{" + raw.replace('\\"', '"') + "}",
        ]
        for cand in candidates:
            try:
                obj = json.loads(cand)
                if isinstance(obj, dict):
                    parsed = obj
                    break
            except Exception:
                continue
        if parsed:
            headers = {str(k): "" if v is None else str(v) for k, v in parsed.items()}
        else:
            # 兜底：尽可能提取形如 "Key":"Value" 的任意头，避免遗漏签名头。
            kv_pairs = re.findall(r'["\']?([A-Za-z0-9\-_.]+)["\']?\s*:\s*["\']([^"\']*)["\']', raw)
            if kv_pairs:
                headers = {k: v for k, v in kv_pairs}
            else:
                x_match = re.search(r'X-bailian-extra["\']?\s*[:=]\s*["\']([^"\']+)["\']', raw)
                c_match = re.search(r'Content-Type["\']?\s*[:=]\s*["\']([^"\']*)["\']', raw)
                if x_match:
                    headers["X-bailian-extra"] = x_match.group(1)
                if c_match:
                    headers["Content-Type"] = c_match.group(1)

    if not url:
        raise RuntimeError("上传租约缺少URL（Data.Param.Url）。")
    with open(file_path, "rb") as f:
        if method == "PUT":
            resp = requests.put(url, data=f, headers=headers, timeout=120)
        elif method == "POST":
            resp = requests.post(url, data=f, headers=headers, timeout=120)
        else:
            raise RuntimeError(f"不支持的上传方法：{method}")
    if resp.status_code not in {200, 201, 204}:
        raise RuntimeError(f"上传到预签名URL失败，HTTP {resp.status_code}")


def add_file_by_lease(client, workspace_id: str, category_id: str, lease_id: str, parser: str):
    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")
    request = bailian_models.AddFileRequest(
        lease_id=lease_id,
        parser=parser,
        category_id=category_id,
    )
    runtime = util_models.RuntimeOptions()
    resp = client.add_file_with_options(workspace_id, request, {}, runtime)
    return normalize_openapi_response(resp)


def describe_file(client, workspace_id: str, file_id: str):
    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")
    runtime = util_models.RuntimeOptions()
    request = bailian_models.DescribeFileRequest()
    # 兼容不同字段命名
    for key in ("file_id", "fileId", "id"):
        try:
            setattr(request, key, file_id)
        except Exception:
            pass
    # SDK versions may have different signatures. Build kwargs by parameter names.
    try:
        method = client.describe_file_with_options
        sig = inspect.signature(method)
        kwargs: Dict[str, Any] = {}
        for name, p in sig.parameters.items():
            n = name.lower()
            if "workspace" in n:
                kwargs[name] = workspace_id
            elif "request" in n:
                kwargs[name] = request
            elif n in {"fileid", "file_id", "id"}:
                kwargs[name] = file_id
            elif n == "headers":
                kwargs[name] = {}
            elif n == "runtime":
                kwargs[name] = runtime
            elif p.default is inspect._empty:
                # unknown required parameter
                raise RuntimeError(f"describe_file_with_options存在未知必填参数：{name}")
        resp = method(**kwargs)
        return normalize_openapi_response(resp)
    except Exception as e:
        # fallback legacy attempts
        attempts = [
            lambda: client.describe_file_with_options(workspace_id, request, {}, runtime),
            lambda: client.describe_file_with_options(workspace_id, file_id, {}, runtime),
            lambda: client.describe_file_with_options(workspace_id, file_id, runtime),
        ]
        last_err = e
        for call in attempts:
            try:
                resp = call()
                return normalize_openapi_response(resp)
            except Exception as ee:
                last_err = ee
                continue
        raise RuntimeError(f"describe_file_with_options签名不兼容：{last_err}")


def submit_index_add_documents_job(
    client,
    workspace_id: str,
    index_id: str,
    file_ids: List[str],
    source_type: str = "DATA_CENTER_FILE",
    chunk_mode: str = "",
    separator: str = "",
    chunk_size: int = 0,
    overlap_size: int = 0,
) -> Dict[str, Any]:
    """
    按官方示例风格调用 submit_index_add_documents_job_with_options。
    说明：不同SDK版本请求字段命名可能有差异，这里做多字段兼容赋值。
    """
    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")

    req = bailian_models.SubmitIndexAddDocumentsJobRequest()
    # 兼容字段名：id / index_id，documents / file_ids / file_ids_list
    for key in ("id", "index_id"):
        try:
            setattr(req, key, index_id)
        except Exception:
            pass
    for key in ("file_ids", "file_id_list", "document_ids"):
        try:
            setattr(req, key, file_ids)
        except Exception:
            pass
    for key in ("documentIds", "DocumentIds"):
        try:
            setattr(req, key, file_ids)
        except Exception:
            pass
    for key in ("source_type", "sourceType", "SourceType"):
        try:
            setattr(req, key, source_type)
        except Exception:
            pass
    if chunk_mode:
        for key in ("chunk_mode", "chunkMode", "ChunkMode"):
            try:
                setattr(req, key, chunk_mode)
            except Exception:
                pass
    if separator:
        for key in ("separator", "Separator"):
            try:
                setattr(req, key, separator)
            except Exception:
                pass
    if chunk_size and chunk_size > 0:
        for key in ("chunk_size", "chunkSize", "ChunkSize"):
            try:
                setattr(req, key, chunk_size)
            except Exception:
                pass
    if overlap_size and overlap_size >= 0:
        for key in ("overlap_size", "overlapSize", "OverlapSize"):
            try:
                setattr(req, key, overlap_size)
            except Exception:
                pass

    runtime = util_models.RuntimeOptions()
    resp = client.submit_index_add_documents_job_with_options(workspace_id, req, {}, runtime)
    return normalize_openapi_response(resp)


def _submit_index_add_documents_job_response_succeeded(job_resp: Dict[str, Any]) -> bool:
    """
    判断 SubmitIndexAddDocumentsJob 业务是否成功。
    百炼常见形态：HTTP 200 + Code=Success + Message=success；不可把「存在 Code 字符串」一律当失败。
    """
    meta = _get_case_insensitive(job_resp, "_meta", {}) or {}
    http_raw = _get_case_insensitive(meta, "status_code", None)
    if http_raw is not None:
        try:
            hi = int(http_raw)
            if hi < 200 or hi >= 300:
                return False
        except (TypeError, ValueError):
            pass

    if _get_case_insensitive(job_resp, "Success", None) is True:
        return True
    data = _get_case_insensitive(job_resp, "data", None)
    if isinstance(data, dict) and _get_case_insensitive(data, "Success", None) is True:
        return True

    code = (
        _get_case_insensitive(job_resp, "Code", "")
        or _get_case_insensitive(meta, "code", "")
        or ""
    )
    code_s = str(code).strip()
    if code_s:
        return code_s.casefold() in ("success", "ok", "200")

    msg = str(
        _get_case_insensitive(job_resp, "Message", "")
        or _get_case_insensitive(meta, "message", "")
        or ""
    ).strip().casefold()
    if msg == "success":
        return True

    # 部分版本仅返回 data 中的任务 Id，无顶层 Code
    if extract_bailian_job_id(job_resp):
        return True

    return False


def get_index_job_status(client, workspace_id: str, index_id: str, job_id: str) -> Dict[str, Any]:
    """调用百炼 GetIndexJobStatus；返回 normalize_openapi_response 字典。"""
    try:
        from alibabacloud_bailian20231229 import models as bailian_models
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")

    if not hasattr(client, "get_index_job_status_with_options"):
        raise RuntimeError(
            "SDK 缺少 get_index_job_status_with_options，请升级：pip install -U alibabacloud-bailian20231229"
        )

    request = bailian_models.GetIndexJobStatusRequest()
    try:
        request.index_id = index_id
        request.job_id = job_id
    except Exception:
        for key in ("index_id", "indexId"):
            try:
                setattr(request, key, index_id)
            except Exception:
                pass
        for key in ("job_id", "jobId"):
            try:
                setattr(request, key, job_id)
            except Exception:
                pass

    runtime = util_models.RuntimeOptions()
    try:
        method = client.get_index_job_status_with_options
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
                raise RuntimeError(f"get_index_job_status_with_options存在未知必填参数：{name}")
        resp = method(**kwargs)
        return normalize_openapi_response(resp)
    except Exception as e:
        attempts = [
            lambda: client.get_index_job_status_with_options(workspace_id, request, {}, runtime),
        ]
        last_err = e
        for call in attempts:
            try:
                resp = call()
                return normalize_openapi_response(resp)
            except Exception as ee:
                last_err = ee
                continue
        raise RuntimeError(f"get_index_job_status_with_options调用失败：{last_err}")


def resolve_clean_output_paths(base_path: str, law_type: str) -> Dict[str, str]:
    """
    与法规爬虫4保持一致，兼容两种 base_path 传法：
    1) 数据库根目录（其下包含“法规爬虫”目录）
    2) 已经是“法规爬虫”目录本身
    """
    law_name = DIC[law_type]
    candidates = [
        os.path.join(base_path, "法规爬虫", law_name, "清洗产物"),
        os.path.join(base_path, law_name, "清洗产物"),
    ]
    for out_root in candidates:
        if os.path.isdir(out_root):
            upload_dir = os.path.join(out_root, "aliyun_upload", law_name)
            return {
                "out_root": out_root,
                "upload_dir": upload_dir,
                "master_path": os.path.join(out_root, "law_master.jsonl"),
            }
    # 默认返回第一候选，便于报错信息可读
    out_root = candidates[0]
    return {
        "out_root": out_root,
        "upload_dir": os.path.join(out_root, "aliyun_upload", law_name),
        "master_path": os.path.join(out_root, "law_master.jsonl"),
    }


def load_upload_files_from_master(master_path: str) -> List[str]:
    """
    优先使用法规爬虫4生成的 law_master.jsonl 中 upload_file_path，
    避免把 aliyun_upload 目录里历史残留文件一起上传。
    """
    files: List[str] = []
    if not os.path.isfile(master_path):
        raise RuntimeError(
            f"未找到清洗主清单文件：{master_path}\n"
            "为避免误上传历史残留文件，已禁止目录扫描回退。\n"
            "请先运行 法规爬虫4-清洗与知识库导出.py 生成 law_master.jsonl 后重试。"
        )
    with open(master_path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            p = str(row.get("upload_file_path", "")).strip()
            if p and os.path.isfile(p):
                files.append(p)
    if not files:
        raise RuntimeError(
            f"清洗主清单为空或无有效 upload_file_path：{master_path}\n"
            "为避免误上传非最终清洗文件，已禁止目录扫描回退。\n"
            "请重新运行 法规爬虫4-清洗与知识库导出.py 后重试。"
        )
    # 去重并稳定排序，保证可复现
    files = sorted(set(files))
    return files


def load_upload_entries_from_master(master_path: str) -> List[Tuple[str, Dict[str, Any]]]:
    """
    读取 law_master.jsonl，返回 (upload_file_path, 行 JSON 对象) 列表，路径存在且去重后按路径排序。
    供 law_id / version_hash 幂等与上传报告使用。
    """
    by_path: Dict[str, Dict[str, Any]] = {}
    if not os.path.isfile(master_path):
        raise RuntimeError(
            f"未找到清洗主清单文件：{master_path}\n"
            "为避免误上传历史残留文件，已禁止目录扫描回退。\n"
            "请先运行 法规爬虫4-清洗与知识库导出.py 生成 law_master.jsonl 后重试。"
        )
    with open(master_path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            p = str(row.get("upload_file_path", "")).strip()
            if p and os.path.isfile(p):
                by_path[p] = row
    if not by_path:
        raise RuntimeError(
            f"清洗主清单为空或无有效 upload_file_path：{master_path}\n"
            "为避免误上传非最终清洗文件，已禁止目录扫描回退。\n"
            "请重新运行 法规爬虫4-清洗与知识库导出.py 后重试。"
        )
    return [(path, by_path[path]) for path in sorted(by_path.keys())]


def upload_cleaned_files_to_bailian(
    upload_dir: str,
    workspace_id: str,
    category_id: str = "default",
    parser: str = "DASHSCOPE_DOCMIND",
    knowledge_base_name: str = "",
    poll_interval_sec: int = 15,
    poll_timeout_sec: int = 7200,
    file_paths: Optional[List[str]] = None,
    max_retry_per_file: int = 1,
    file_master_entries: Optional[List[Tuple[str, Dict[str, Any]]]] = None,
    upload_records_db_path: Optional[str] = None,
    will_submit_index: bool = False,
) -> Dict[str, Any]:
    client = create_bailian_client()
    effective_category_id = category_id
    use_store = bool(upload_records_db_path and file_master_entries)
    path_to_row: Dict[str, Dict[str, Any]] = {}
    skipped_records: List[Dict[str, Any]] = []
    if use_store:
        init_kb_upload_db(upload_records_db_path)
        path_to_row = {p: dict(r) for p, r in file_master_entries}

    if file_paths is not None:
        files = [p for p in file_paths if os.path.isfile(p)]
    else:
        files = [
            os.path.join(upload_dir, fn)
            for fn in os.listdir(upload_dir)
            if os.path.isfile(os.path.join(upload_dir, fn))
        ]
    files.sort()
    total_master_files = len(file_master_entries) if file_master_entries else len(files)
    if not files:
        return {
            "uploaded": 0,
            "parse_success": 0,
            "failed": 0,
            "details": [],
            "uploaded_file_ids": [],
            "total_master_files": total_master_files,
            "uploaded_count": 0,
            "skipped_count": 0,
            "failed_count": 0,
            "skipped_records": [],
            "reused_for_index_count": 0,
            "upload_records_db_path": upload_records_db_path or "",
        }

    details: List[Dict[str, Any]] = []
    uploaded = 0
    parse_success = 0
    failed = 0
    reused_for_index_count = 0
    uploaded_file_ids: List[str] = []
    pending_parse_indices: List[int] = []

    for idx, file_path in enumerate(files, start=1):
        file_name = os.path.basename(file_path)
        print(f"[{_now()}] ({idx}/{len(files)}) 上传开始：{file_name}")
        master_row: Dict[str, Any] = path_to_row.get(file_path, {}) if use_store else {}
        law_id = ""
        version_hash = ""
        if use_store:
            law_id = compute_law_id(master_row, file_path)
            version_hash = compute_version_hash(master_row, file_path)
            rec = fetch_record(law_id, version_hash, db_path=upload_records_db_path)
            skip_mode, reuse_fid = classify_upload_skip(rec, require_index_submission=will_submit_index)
            if skip_mode == "full_skip":
                if rec and str(rec["upload_status"] or "").strip() == "INDEX_SUBMITTED" and not str(
                    rec["bailian_job_id"] or ""
                ).strip():
                    print(
                        f"[{_now()}] 提示：{file_name}（law_id={law_id}）已为 INDEX_SUBMITTED 但 bailian_job_id 为空，"
                        "本次不执行 AddFile / SubmitIndexAddDocumentsJob。请人工核对百炼任务或在测试环境修正/删除对应 "
                        "kb_upload_records 行后重试；脚本不会自动重传。"
                    )
                print(f"[{_now()}] 幂等跳过（已存在同 law_id+version_hash 且状态为终态）：{file_name} law_id={law_id}")
                skip_entry: Dict[str, Any] = {
                    "law_id": law_id,
                    "version_hash": version_hash,
                    "law_name": law_name_from_row(master_row),
                    "export_file_path": file_path,
                    "upload_status": str(rec["upload_status"]) if rec else "",
                    "bailian_file_id": str(rec["bailian_file_id"] or "") if rec else "",
                    "reason": "idempotent_skip",
                }
                skipped_records.append(skip_entry)
                details.append(
                    {
                        "file_name": file_name,
                        "file_path": file_path,
                        "knowledge_base_name": knowledge_base_name,
                        "workspace_id": workspace_id,
                        "category_id": effective_category_id,
                        "parser": parser,
                        "skipped": True,
                        "law_id": law_id,
                        "version_hash": version_hash,
                        "idempotent_skip": True,
                    }
                )
                continue
            if skip_mode == "reuse_file" and reuse_fid:
                print(
                    f"[{_now()}] 复用已有 bailian_file_id 参与索引（跳过重复 AddFile）：{file_name} "
                    f"law_id={law_id} file_id={reuse_fid}"
                )
                reused_for_index_count += 1
                uploaded_file_ids.append(reuse_fid)
                details.append(
                    {
                        "file_name": file_name,
                        "file_path": file_path,
                        "knowledge_base_name": knowledge_base_name,
                        "workspace_id": workspace_id,
                        "category_id": effective_category_id,
                        "parser": parser,
                        "file_id": reuse_fid,
                        "success": True,
                        "parse_status": "PARSE_SUCCESS",
                        "reuse_for_index": True,
                        "law_id": law_id,
                        "version_hash": version_hash,
                    }
                )
                continue

        item: Dict[str, Any] = {
            "file_name": file_name,
            "file_path": file_path,
            "knowledge_base_name": knowledge_base_name,
            "workspace_id": workspace_id,
            "category_id": effective_category_id,
            "parser": parser,
        }
        if use_store:
            item["law_id"] = law_id
            item["version_hash"] = version_hash
        upload_ok = False
        last_upload_error = ""
        for attempt in range(max_retry_per_file + 1):
            try:
                lease_resp = apply_upload_lease(client, effective_category_id, file_path, workspace_id)
                data = _get_case_insensitive(lease_resp, "data", {}) or {}
                if not isinstance(data, dict):
                    data = model_to_dict(data)
                lease_id = _get_case_insensitive(data, "file_upload_lease_id", "") or _get_case_insensitive(
                    data, "FileUploadLeaseId", ""
                )
                if not lease_id:
                    meta = _get_case_insensitive(lease_resp, "_meta", {}) or {}
                    resp_code = _get_case_insensitive(lease_resp, "code", "") or _get_case_insensitive(meta, "code", "")
                    resp_msg = _get_case_insensitive(lease_resp, "message", "") or _get_case_insensitive(meta, "message", "")
                    resp_status = _get_case_insensitive(meta, "status_code", "")
                    req_id = _get_case_insensitive(meta, "request_id", "")
                    snippet = json.dumps(lease_resp, ensure_ascii=False)[:800]
                    lease_err = RuntimeError(
                        f"ApplyFileUploadLease返回中缺少FileUploadLeaseId，code={resp_code}, status={resp_status}, request_id={req_id}, message={resp_msg}, resp={snippet}"
                    )
                    # 自动兜底：category_id 无效时，切换到 default 并重试当前文件一次。
                    if effective_category_id != "default" and is_category_not_found_error(lease_err):
                        print(f"[{_now()}] category_id={effective_category_id} 无效，自动切换为 default 并重试当前文件。")
                        effective_category_id = "default"
                        item["category_id"] = effective_category_id
                        lease_resp = apply_upload_lease(client, effective_category_id, file_path, workspace_id)
                        data = _get_case_insensitive(lease_resp, "data", {}) or {}
                        if not isinstance(data, dict):
                            data = model_to_dict(data)
                        lease_id = _get_case_insensitive(data, "file_upload_lease_id", "") or _get_case_insensitive(
                            data, "FileUploadLeaseId", ""
                        )
                        if not lease_id:
                            raise lease_err
                    else:
                        raise lease_err

                upload_file_to_presigned_url(lease_resp, file_path)

                add_resp = add_file_by_lease(client, workspace_id, effective_category_id, lease_id, parser)
                add_data = _get_case_insensitive(add_resp, "data", {}) or {}
                if not isinstance(add_data, dict):
                    add_data = model_to_dict(add_data)
                file_id = _get_case_insensitive(add_data, "file_id", "") or _get_case_insensitive(add_data, "FileId", "")
                if not file_id:
                    raise RuntimeError("AddFile返回中缺少FileId")

                uploaded += 1
                item["lease_id"] = lease_id
                item["file_id"] = file_id
                uploaded_file_ids.append(file_id)
                if use_store:
                    try:
                        upsert_after_add_file(
                            law_id=law_id,
                            law_name=law_name_from_row(master_row),
                            version_hash=version_hash,
                            export_file_path=file_path,
                            bailian_file_id=file_id,
                            db_path=upload_records_db_path,
                        )
                    except Exception as db_exc:
                        print(f"[{_now()}] 写入本地上传记录失败（不影响百炼上传）：{db_exc}")
                item["upload_attempts"] = attempt + 1
                # 上传阶段成功后，进入统一轮询队列（避免每个文件串行等待解析）。
                item["success"] = None
                item["parse_status"] = "PENDING"
                item["_parse_deadline_ts"] = time.time() + poll_timeout_sec
                item["_parse_retry_used"] = 0
                upload_ok = True
                break
            except Exception as e:
                last_upload_error = str(e)
                if attempt < max_retry_per_file:
                    print(
                        f"[{_now()}] 上传失败准备重试：{file_name}，"
                        f"第{attempt + 1}/{max_retry_per_file + 1}次失败，错误：{e}"
                    )
                    continue
                failed += 1
                item["success"] = False
                item["error"] = last_upload_error
                item["upload_attempts"] = attempt + 1
                print(f"[{_now()}] 上传失败：{file_name}，错误：{e}")
                if use_store and law_id and version_hash:
                    try:
                        upsert_after_upload_failure(
                            law_id=law_id,
                            law_name=law_name_from_row(master_row),
                            version_hash=version_hash,
                            export_file_path=file_path,
                            message=last_upload_error,
                            db_path=upload_records_db_path,
                        )
                    except Exception as db_exc:
                        print(f"[{_now()}] 更新本地上传记录失败：{db_exc}")
        details.append(item)
        if upload_ok and item.get("success") is None and item.get("file_id"):
            pending_parse_indices.append(len(details) - 1)

    # 统一轮询所有待解析文件，减少串行阻塞带来的总耗时。
    if pending_parse_indices:
        print(f"[{_now()}] 上传阶段完成，开始统一轮询解析状态（待解析 {len(pending_parse_indices)} 个文件）。")
    pending = set(pending_parse_indices)
    while pending:
        now_ts = time.time()
        done_this_round: List[int] = []
        for idx in list(pending):
            item = details[idx]
            file_id = str(item.get("file_id", "")).strip()
            file_name = str(item.get("file_name", "")).strip()
            deadline = float(item.get("_parse_deadline_ts", now_ts))
            if now_ts >= deadline:
                item["parse_status"] = str(item.get("parse_status") or "TIMEOUT")
                item["success"] = False
                item["error"] = f"解析超时（>{poll_timeout_sec}s），最后状态={item['parse_status']}"
                failed += 1
                print(f"[{_now()}] 解析超时：{file_name} -> {file_id}，最后状态={item['parse_status']}")
                if use_store and item.get("law_id") and item.get("version_hash"):
                    try:
                        update_after_parse_failure(
                            law_id=str(item["law_id"]),
                            version_hash=str(item["version_hash"]),
                            message=str(item.get("error") or "TIMEOUT"),
                            db_path=upload_records_db_path,
                        )
                    except Exception as db_exc:
                        print(f"[{_now()}] 更新本地上传记录失败：{db_exc}")
                done_this_round.append(idx)
                continue
            try:
                desc = describe_file(client, workspace_id, file_id)
                d = _get_case_insensitive(desc, "data", {}) or {}
                if not isinstance(d, dict):
                    d = model_to_dict(d)
                status = (_get_case_insensitive(d, "status", "") or _get_case_insensitive(d, "Status", "")).upper()
                if status:
                    item["parse_status"] = status
                if status == "PARSE_SUCCESS":
                    item["success"] = True
                    parse_success += 1
                    print(f"[{_now()}] 解析完成：{file_name} -> {file_id}")
                    if use_store and item.get("law_id") and item.get("version_hash"):
                        try:
                            if not will_submit_index:
                                update_after_parse_success_terminal(
                                    law_id=str(item["law_id"]),
                                    version_hash=str(item["version_hash"]),
                                    db_path=upload_records_db_path,
                                )
                        except Exception as db_exc:
                            print(f"[{_now()}] 更新本地上传记录失败：{db_exc}")
                    done_this_round.append(idx)
                    continue
                if status in {"PARSE_FAILED", "FAILED"}:
                    retry_used = int(item.get("_parse_retry_used", 0) or 0)
                    if retry_used < max_retry_per_file:
                        item["_parse_retry_used"] = retry_used + 1
                        item["_parse_deadline_ts"] = time.time() + poll_timeout_sec
                        print(
                            f"[{_now()}] 解析失败触发重试轮询：{file_name} -> {file_id}，"
                            f"状态={status}，重试{item['_parse_retry_used']}/{max_retry_per_file}"
                        )
                    else:
                        item["success"] = False
                        item["error"] = f"解析失败，状态={status}"
                        failed += 1
                        print(f"[{_now()}] 解析失败：{file_name} -> {file_id}，状态={status}")
                        if use_store and item.get("law_id") and item.get("version_hash"):
                            try:
                                update_after_parse_failure(
                                    law_id=str(item["law_id"]),
                                    version_hash=str(item["version_hash"]),
                                    message=str(item.get("error") or status),
                                    db_path=upload_records_db_path,
                                )
                            except Exception as db_exc:
                                print(f"[{_now()}] 更新本地上传记录失败：{db_exc}")
                        done_this_round.append(idx)
                    continue
            except Exception as e:
                # 轮询异常按暂态处理，保留到下一轮重试直到超时
                item["last_poll_error"] = str(e)
        for idx in done_this_round:
            pending.discard(idx)
        if pending:
            time.sleep(max(3, poll_interval_sec))

    # 清理内部字段，避免污染最终报告
    for item in details:
        if "_parse_deadline_ts" in item:
            item.pop("_parse_deadline_ts", None)
        if "_parse_retry_used" in item:
            item["parse_retry_used"] = item.pop("_parse_retry_used", 0)

    failed_details = [
        {
            "file_name": str(it.get("file_name", "")),
            "file_path": str(it.get("file_path", "")),
            "error": str(it.get("error", "")),
            "upload_attempts": int(it.get("upload_attempts", 0) or 0),
            "parse_status": str(it.get("parse_status", "")),
            "parse_retry_used": int(it.get("parse_retry_used", 0) or 0),
        }
        for it in details
        if it.get("success") is False
    ]

    return {
        "knowledge_base_name": knowledge_base_name,
        "workspace_id": workspace_id,
        "category_id": effective_category_id,
        "parser": parser,
        "uploaded": uploaded,
        "parse_success": parse_success,
        "failed": failed,
        "failed_details": failed_details,
        "uploaded_file_ids": uploaded_file_ids,
        "details": details,
        "total_master_files": total_master_files,
        "uploaded_count": uploaded,
        "skipped_count": len(skipped_records),
        "failed_count": failed,
        "skipped_records": skipped_records,
        "reused_for_index_count": reused_for_index_count,
        "upload_records_db_path": upload_records_db_path or "",
    }


def is_category_not_found_error(err: Exception) -> bool:
    msg = str(err)
    return ("InvalidParameter" in msg) and ("category_id" in msg or "category" in msg) and ("Cant find out category" in msg)


def _index_success_batch_pairs(summary: Dict[str, Any]) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    for it in summary.get("details", []):
        if it.get("skipped") and not it.get("reuse_for_index"):
            continue
        if it.get("success") is not True:
            continue
        lid = it.get("law_id")
        vh = it.get("version_hash")
        if lid and vh:
            out.append((str(lid), str(vh)))
    return out


def _doc_primary_id(doc: Dict[str, Any]) -> str:
    for key in ("DocId", "FileId", "Id", "doc_id", "file_id"):
        v = _get_case_insensitive(doc, key, "")
        if str(v).strip():
            return str(v).strip()
    return ""


def _apply_index_job_completed_to_records(
    summary: Dict[str, Any],
    upload_records_db_path: str,
    documents: List[Dict[str, Any]],
) -> None:
    by_fid: Dict[str, Dict[str, Any]] = {}
    for it in summary.get("details", []):
        if it.get("success") is not True:
            continue
        if it.get("skipped") and not it.get("reuse_for_index"):
            continue
        fid = str(it.get("file_id", "")).strip()
        lid = it.get("law_id")
        vh = it.get("version_hash")
        if fid and lid and vh:
            by_fid[fid] = it
    seen: set[str] = set()
    for raw in documents:
        doc = raw if isinstance(raw, dict) else model_to_dict(raw)
        did = _doc_primary_id(doc)
        if not did or did not in by_fid:
            continue
        seen.add(did)
        it = by_fid[did]
        lid_s, vh_s = str(it["law_id"]), str(it["version_hash"])
        st = _get_case_insensitive(doc, "status", "") or _get_case_insensitive(doc, "Status", "")
        stu = str(st).strip().upper()
        msg = str(
            _get_case_insensitive(doc, "message", "") or _get_case_insensitive(doc, "Message", "") or ""
        )
        try:
            if stu == "INSERT_ERROR":
                update_after_index_error(
                    law_id=lid_s,
                    version_hash=vh_s,
                    message=msg or "INSERT_ERROR",
                    index_status="INSERT_ERROR",
                    db_path=upload_records_db_path,
                )
            elif stu in ("FINISH", "SUCCESS", "COMPLETED"):
                update_record_index_finish(law_id=lid_s, version_hash=vh_s, db_path=upload_records_db_path)
            elif stu in ("RUNNING", "PENDING"):
                pass
            else:
                update_record_index_unknown(
                    law_id=lid_s,
                    version_hash=vh_s,
                    message=(f"未知文档状态：{stu}" + (f"；{msg}" if msg else ""))[:4000],
                    db_path=upload_records_db_path,
                )
        except Exception as ex:
            print(f"[{_now()}] 回写 kb_upload_records（文档级）失败：{ex}")
    for fid, it in by_fid.items():
        if fid in seen:
            continue
        try:
            update_record_index_finish(
                law_id=str(it["law_id"]), version_hash=str(it["version_hash"]), db_path=upload_records_db_path
            )
        except Exception as ex:
            print(f"[{_now()}] 回写 kb_upload_records（任务完成但无文档条目）失败：{ex}")


def poll_index_job_status_close_loop(
    client,
    workspace_id: str,
    index_id: str,
    job_id: str,
    summary: Dict[str, Any],
    upload_records_db_path: str,
    *,
    poll_interval_sec: int,
    poll_timeout_sec: int,
) -> None:
    pairs = _index_success_batch_pairs(summary)
    summary["index_job_poll_started_at"] = _now()
    summary["index_job_poll_attempts"] = 0
    summary["index_job_poll_last_error"] = ""
    summary["index_job_final_status"] = ""
    summary["index_job_status_raw"] = None

    deadline = time.time() + max(30, int(poll_timeout_sec))
    interval = max(3, int(poll_interval_sec))

    while time.time() < deadline:
        summary["index_job_poll_attempts"] = int(summary.get("index_job_poll_attempts") or 0) + 1
        try:
            norm = get_index_job_status(client, workspace_id, index_id, job_id)
            snippet = json.dumps(norm, ensure_ascii=False)[:2000]
            summary["index_job_status_raw"] = snippet

            succ = _get_case_insensitive(norm, "success", None)
            if succ is False:
                err = str(
                    _get_case_insensitive(norm, "message", "")
                    or _get_case_insensitive(norm, "Message", "")
                    or "GetIndexJobStatus Success=false"
                )
                summary["index_job_poll_last_error"] = err[:2000]
                time.sleep(interval)
                continue

            d = _get_case_insensitive(norm, "data", {}) or {}
            if not isinstance(d, dict):
                d = model_to_dict(d)
            jst = str(
                _get_case_insensitive(d, "Status", "") or _get_case_insensitive(d, "status", "") or ""
            ).strip().upper()
            docs_raw = d.get("Documents") or d.get("documents") or []
            docs_list: List[Dict[str, Any]] = []
            if isinstance(docs_raw, list):
                for x in docs_raw:
                    docs_list.append(x if isinstance(x, dict) else model_to_dict(x))

            if jst in ("PENDING", "RUNNING", "PROCESSING", ""):
                if pairs:
                    try:
                        update_records_index_running(pairs, db_path=upload_records_db_path)
                    except Exception as ex:
                        print(f"[{_now()}] 更新索引任务 RUNNING 状态失败：{ex}")
                time.sleep(interval)
                continue

            if jst in ("FAILED", "ERROR"):
                msg = str(
                    _get_case_insensitive(norm, "message", "")
                    or _get_case_insensitive(norm, "Message", "")
                    or _get_case_insensitive(d, "Message", "")
                    or jst
                )
                for lid, vh in pairs:
                    try:
                        update_after_index_error(
                            law_id=lid,
                            version_hash=vh,
                            message=msg[:4000],
                            index_status="FAILED",
                            db_path=upload_records_db_path,
                        )
                    except Exception as ex:
                        print(f"[{_now()}] 回写索引任务 FAILED 失败：{ex}")
                summary["index_job_poll_status"] = "TERMINAL_FAILED"
                summary["index_job_final_status"] = jst
                summary["index_job_poll_finished_at"] = _now()
                summary["index_job_poll_last_error"] = msg[:2000]
                return

            if jst in ("COMPLETED", "SUCCESS", "FINISH"):
                _apply_index_job_completed_to_records(summary, upload_records_db_path, docs_list)
                summary["index_job_poll_status"] = "TERMINAL_OK"
                summary["index_job_final_status"] = jst
                summary["index_job_poll_finished_at"] = _now()
                summary["index_job_poll_last_error"] = ""
                return

            summary["index_job_poll_last_error"] = f"unknown job status: {jst}"
            time.sleep(interval)
        except RuntimeError as e:
            msg = str(e)
            if "get_index_job_status" in msg or "SDK" in msg or "缺少" in msg:
                summary["index_job_poll_status"] = "SDK_UNSUPPORTED_OR_ERROR"
                summary["index_job_poll_last_error"] = msg[:2000]
                summary["index_job_poll_finished_at"] = _now()
                return
            summary["index_job_poll_last_error"] = msg[:2000]
            time.sleep(interval)
        except Exception as e:
            summary["index_job_poll_last_error"] = str(e)[:2000]
            time.sleep(interval)

    msg = (
        f"GetIndexJobStatus polling timeout after {poll_timeout_sec}s "
        f"(attempts={summary.get('index_job_poll_attempts')})"
    )
    for lid, vh in pairs:
        try:
            update_record_index_timeout(
                law_id=lid, version_hash=vh, message=msg[:4000], db_path=upload_records_db_path
            )
        except Exception as ex:
            print(f"[{_now()}] TIMEOUT 回写 kb_upload_records 失败：{ex}")
    summary["index_job_poll_status"] = "TIMEOUT"
    summary["index_job_final_status"] = "TIMEOUT"
    summary["index_job_poll_finished_at"] = _now()


def _apply_index_outcome_to_kb_upload_records(
    summary: Dict[str, Any],
    upload_records_db_path: str,
    job_resp: Optional[Dict[str, Any]],
    error_message: Optional[str],
) -> None:
    """将 SubmitIndexAddDocumentsJob 结果写回 kb_upload_records（仅本地上传记录表）。"""
    if not str(upload_records_db_path or "").strip():
        return
    job_id = ""
    if not error_message and isinstance(job_resp, dict):
        job_id = extract_bailian_job_id(job_resp)
    err = (error_message or "").strip()
    for it in summary.get("details", []):
        if it.get("skipped"):
            continue
        lid = it.get("law_id")
        vh = it.get("version_hash")
        if not lid or not vh:
            continue
        if it.get("success") is not True:
            continue
        try:
            if err:
                update_after_index_error(
                    law_id=str(lid),
                    version_hash=str(vh),
                    message=err,
                    db_path=upload_records_db_path,
                )
            else:
                update_after_index_submitted(
                    law_id=str(lid),
                    version_hash=str(vh),
                    bailian_job_id=job_id,
                    db_path=upload_records_db_path,
                )
        except Exception as ex:
            print(f"[{_now()}] 更新本地上传记录（索引阶段）失败：{ex}")


def _parse_bailian_bool_default_true(raw: str) -> bool:
    """未设置或 true/1/yes/on 为 True；false/0/no/off 为 False。"""
    r = (raw or "true").strip().lower()
    return r not in ("0", "false", "no", "off")


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(script_dir, ".env")
    env_loaded = load_env_file(env_path)
    if env_loaded:
        print(f"[{_now()}] 已加载环境配置：{env_path}")

    env_law_type = (os.getenv("BAILIAN_LAW_TYPE", "") or "").strip()
    env_base_path = (os.getenv("BAILIAN_BASE_PATH", "") or "").strip().strip('"').strip("'")
    env_workspace_id = (os.getenv("BAILIAN_WORKSPACE_ID", "") or "").strip()
    env_category_id = (os.getenv("BAILIAN_CATEGORY_ID", "") or "").strip()
    env_parser = (os.getenv("BAILIAN_PARSER", "") or "").strip()
    env_kb_name = (os.getenv("BAILIAN_KNOWLEDGE_BASE_NAME", "") or "").strip()
    env_index_id = (os.getenv("BAILIAN_INDEX_ID", "") or "").strip()
    env_poll_interval = (os.getenv("BAILIAN_POLL_INTERVAL_SEC", "") or "").strip()
    env_poll_timeout = (os.getenv("BAILIAN_POLL_TIMEOUT_SEC", "") or "").strip()
    env_source_type = (os.getenv("BAILIAN_SOURCE_TYPE", "") or "").strip()
    env_chunk_mode = (os.getenv("BAILIAN_CHUNK_MODE", "") or "").strip()
    env_chunk_separator = (os.getenv("BAILIAN_CHUNK_SEPARATOR", "") or "").strip()
    env_chunk_size = (os.getenv("BAILIAN_CHUNK_SIZE", "") or "").strip()
    env_overlap_size = (os.getenv("BAILIAN_OVERLAP_SIZE", "") or "").strip()
    env_retry_times = (os.getenv("BAILIAN_RETRY_TIMES", "") or "").strip()
    env_index_job_retry = (os.getenv("BAILIAN_INDEX_JOB_RETRY", "") or "").strip()
    env_index_job_retry_interval = (os.getenv("BAILIAN_INDEX_JOB_RETRY_INTERVAL_SEC", "") or "").strip()

    # 1) law type: prefer env, fallback prompt
    law_type = env_law_type
    if law_type:
        print(f"[{_now()}] 使用.env中的法规类型：{law_type}")
    else:
        law_type = str(
            input(
                """选择法规类型：
0.xf（宪法）；
1.flfg（法律）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方法规）；
4.1.jcfg（监察法规）；
输入拼音：（如flfg）"""
            )
        ).strip()
    if law_type not in DIC:
        print("规范类型输入错误。")
        return

    # 2) base path: prefer env, fallback prompt
    base_path = env_base_path
    if base_path:
        print(f"[{_now()}] 使用.env中的数据库目录：{base_path}")
    else:
        base_path = input("输入数据库所在目录（绝对路径）：").strip().strip('"').strip("'")
    if not base_path:
        print("目录不能为空。")
        return

    # 3) workspace/category/parser/poll: prefer env, fallback prompt/default
    workspace_id = env_workspace_id
    if workspace_id:
        print(f"[{_now()}] 使用.env中的WorkspaceId。")
    else:
        workspace_id = input("输入阿里云百炼 WorkspaceId（如 llm-xxxx）：").strip()
    if not workspace_id:
        print("WorkspaceId不能为空。")
        return

    category_id = env_category_id or "default"
    parser = env_parser or input("输入Parser（默认DASHSCOPE_DOCMIND）：").strip() or "DASHSCOPE_DOCMIND"
    knowledge_base_name = env_kb_name or input("输入知识库名称（用于记录与后续导入识别）：").strip()
    index_id = env_index_id or input("输入知识库IndexId（可选，填则先更新知识库名称）：").strip()

    poll_interval_raw = env_poll_interval or input("解析状态轮询间隔秒（默认15）：").strip() or "15"
    poll_timeout_raw = env_poll_timeout or input("解析超时时间秒（默认7200）：").strip() or "7200"
    if env_category_id:
        print(f"[{_now()}] 使用.env中的CategoryId：{category_id}")
    else:
        print(f"[{_now()}] CategoryId未配置，自动使用默认值：default")
    # 防误配：IndexId 与 CategoryId 不是同一概念，若填成同值则回退 default
    if index_id and category_id and index_id == category_id:
        print(f"[{_now()}] 检测到 CategoryId 与 IndexId 相同（{category_id}），这通常是误配置；已自动改用 default。")
        category_id = "default"
    if env_parser:
        print(f"[{_now()}] 使用.env中的Parser：{parser}")
    if env_kb_name:
        print(f"[{_now()}] 使用.env中的知识库名称：{knowledge_base_name}")
    if env_index_id:
        print(f"[{_now()}] 使用.env中的IndexId：{index_id}")
    if env_poll_interval:
        print(f"[{_now()}] 使用.env中的轮询间隔：{poll_interval_raw}")
    if env_poll_timeout:
        print(f"[{_now()}] 使用.env中的轮询超时：{poll_timeout_raw}")
    source_type = env_source_type or "DATA_CENTER_FILE"
    if env_source_type:
        print(f"[{_now()}] 使用.env中的SourceType：{source_type}")
    chunk_mode = (env_chunk_mode or "").strip().lower()
    # 对齐法规爬虫4产物：默认启用 regex 切分。
    if not chunk_mode:
        chunk_mode = "regex"
        print(f"[{_now()}] 未配置ChunkMode，已默认使用：{chunk_mode}")
    elif env_chunk_mode:
        print(f"[{_now()}] 使用.env中的ChunkMode：{chunk_mode}")

    # separator 是正则表达式字符串，不应在这里转成真实换行字符。
    chunk_separator = env_chunk_separator
    if chunk_separator in {"\\n", r"\n"}:
        # 仅按换行分隔在 DocMind 解析后不稳定，升级为“按来源信息行首”切分更稳。
        chunk_separator = r"(?=【来源信息】)"
    elif chunk_separator in {r"\r?\n", "\\r?\\n"}:
        chunk_separator = r"(?=【来源信息】)"
    # 若用户未配置 separator，默认使用“来源信息锚点”切分。
    if chunk_mode == "regex" and not chunk_separator:
        chunk_separator = r"(?=【来源信息】)"
    if chunk_separator:
        # 全角空格 / NBSP / 误写「【 来源信息」均会导致锚点与正文不一致
        chunk_separator = chunk_separator.replace("\u3000", "").replace("\xa0", "")
        chunk_separator = chunk_separator.replace("(?=【 来源信息】)", r"(?=【来源信息】)")
        chunk_separator = re.sub(r"【\s+来源信息", "【来源信息", chunk_separator)
    if env_chunk_separator:
        print(
            f"[{_now()}] 使用.env中的Separator正则：separator={repr(chunk_separator)} "
            f"（提交百炼参数与此一致）"
        )
    else:
        print(
            f"[{_now()}] 未配置Separator，默认：separator={repr(chunk_separator)} "
            f"（提交百炼参数与此一致）"
        )
    try:
        chunk_size = int(env_chunk_size) if env_chunk_size else 0
    except ValueError:
        chunk_size = 0
    try:
        overlap_size = int(env_overlap_size) if env_overlap_size else 0
    except ValueError:
        overlap_size = 0
    try:
        retry_times = max(0, int(env_retry_times)) if env_retry_times else 1
    except ValueError:
        retry_times = 1

    try:
        index_job_retry = max(0, int(env_index_job_retry)) if env_index_job_retry else 8
    except ValueError:
        index_job_retry = 8
    try:
        index_job_retry_interval = max(3, int(env_index_job_retry_interval)) if env_index_job_retry_interval else 30
    except ValueError:
        index_job_retry_interval = 30

    env_index_poll_enabled = (os.getenv("BAILIAN_INDEX_JOB_POLL_ENABLED", "true") or "").strip()
    env_index_poll_interval_sec = (os.getenv("BAILIAN_INDEX_JOB_POLL_INTERVAL_SECONDS", "10") or "").strip()
    env_index_poll_timeout_sec = (os.getenv("BAILIAN_INDEX_JOB_POLL_TIMEOUT_SECONDS", "1800") or "").strip()
    index_poll_enabled = _parse_bailian_bool_default_true(env_index_poll_enabled)
    try:
        index_poll_interval_sec = max(3, int(env_index_poll_interval_sec or "10"))
    except ValueError:
        index_poll_interval_sec = 10
    try:
        index_poll_timeout_sec = max(30, int(env_index_poll_timeout_sec or "1800"))
    except ValueError:
        index_poll_timeout_sec = 1800

    # 关键：SubmitIndexAddDocumentsJob 未传 chunk_size 时默认 500，可能把“单行切片”再次强制切断。
    # 对于法规爬虫4的一行一条格式，regex 模式下默认提升为 6000，尽量保持“一行一个切片”。
    if chunk_mode == "regex" and chunk_separator and chunk_size <= 0:
        chunk_size = 6000
        print(f"[{_now()}] 未配置ChunkSize，已按法规爬虫4行切片格式自动设置为：{chunk_size}")

    try:
        poll_interval = max(3, int(poll_interval_raw))
    except ValueError:
        poll_interval = 15
    try:
        poll_timeout = max(60, int(poll_timeout_raw))
    except ValueError:
        poll_timeout = 7200

    paths = resolve_clean_output_paths(base_path, law_type)
    out_root = paths["out_root"]
    upload_dir = paths["upload_dir"]
    master_path = paths["master_path"]
    try:
        upload_entries = load_upload_entries_from_master(master_path)
    except RuntimeError as e:
        print(f"[{_now()}] {e}")
        return

    upload_files_from_master = [p for p, _ in upload_entries]
    upload_records_db_path = str(init_kb_upload_db(get_kb_upload_db_path()))
    will_submit_index = bool(str(index_id or "").strip())

    if not os.path.isdir(upload_dir):
        print(f"未找到清洗上传目录：{upload_dir}")
        print("请先运行 法规爬虫4-清洗与知识库导出.py 生成清洗上传文件。")
        return
    print(f"[{_now()}] 使用 law_master.jsonl 精确上传：{master_path}")
    print(f"[{_now()}] 主清单文件数（去重后）：{len(upload_files_from_master)}；本地上传记录库：{upload_records_db_path}")

    # Optional: update index name before uploading files
    if index_id and knowledge_base_name:
        try:
            client = create_bailian_client()
            upd = update_index_name(client, workspace_id=workspace_id, index_id=index_id, index_name=knowledge_base_name)
            meta = _get_case_insensitive(upd, "_meta", {}) or {}
            ok = _get_case_insensitive(upd, "Success", None)
            print(
                f"[{_now()}] 已尝试更新知识库名称：IndexId={index_id} Name={knowledge_base_name} "
                f"(success={ok}, code={_get_case_insensitive(meta,'code','')}, message={_get_case_insensitive(meta,'message','')})"
            )
        except Exception as e:
            print(f"[{_now()}] 更新知识库名称失败（将继续上传文件，不中断）：{e}")

    print(f"[{_now()}] 开始上传目录：{upload_dir}")
    client_for_index_job = None
    try:
        client_for_index_job = create_bailian_client()
        summary = upload_cleaned_files_to_bailian(
            upload_dir,
            workspace_id=workspace_id,
            category_id=category_id,
            parser=parser,
            knowledge_base_name=knowledge_base_name,
            poll_interval_sec=poll_interval,
            poll_timeout_sec=poll_timeout,
            file_paths=upload_files_from_master,
            max_retry_per_file=retry_times,
            file_master_entries=upload_entries,
            upload_records_db_path=upload_records_db_path,
            will_submit_index=will_submit_index,
        )
    except Exception as e:
        # 容错：当配置的category_id不存在时，自动回退到default重试
        if category_id != "default" and is_category_not_found_error(e):
            print(f"[{_now()}] category_id={category_id} 无效，自动回退使用 default 重试。")
            summary = upload_cleaned_files_to_bailian(
                upload_dir,
                workspace_id=workspace_id,
                category_id="default",
                parser=parser,
                knowledge_base_name=knowledge_base_name,
                poll_interval_sec=poll_interval,
                poll_timeout_sec=poll_timeout,
                file_paths=upload_files_from_master,
                max_retry_per_file=retry_times,
                file_master_entries=upload_entries,
                upload_records_db_path=upload_records_db_path,
                will_submit_index=will_submit_index,
            )
        else:
            raise

    if int(summary.get("skipped_count") or 0) > 0:
        print(f"[{_now()}] 幂等跳过文件数：{summary.get('skipped_count')}")
    if int(summary.get("reused_for_index_count") or 0) > 0:
        print(f"[{_now()}] 复用 file_id 参与索引（未重复 AddFile）：{summary.get('reused_for_index_count')}")

    summary.setdefault("index_job_poll_enabled", False)
    summary.setdefault("index_job_poll_status", "NOT_APPLICABLE")

    # 可选：按示例接口将已上传文件提交到知识库（Index）
    if index_id and summary.get("uploaded_file_ids"):
        try:
            if client_for_index_job is None:
                client_for_index_job = create_bailian_client()
            if chunk_mode:
                print(
                    f"[{_now()}] 提交知识库切片参数：chunk_mode={chunk_mode}, "
                    f"separator={repr(chunk_separator)}, chunk_size={chunk_size or '<default>'}, "
                    f"overlap_size={overlap_size if env_overlap_size else '<default>'}"
                )
            summary["index_id"] = index_id
            last_job_resp = None
            for submit_attempt in range(index_job_retry + 1):
                try:
                    job_resp = submit_index_add_documents_job(
                        client_for_index_job,
                        workspace_id=workspace_id,
                        index_id=index_id,
                        file_ids=summary.get("uploaded_file_ids", []),
                        source_type=source_type,
                        chunk_mode=chunk_mode,
                        separator=chunk_separator,
                        chunk_size=chunk_size,
                        overlap_size=overlap_size,
                    )
                except Exception as call_exc:
                    if submit_attempt < index_job_retry:
                        print(
                            f"[{_now()}] SubmitIndexAddDocumentsJob 调用异常，{index_job_retry_interval}s 后重试 "
                            f"({submit_attempt + 1}/{index_job_retry + 1})：{call_exc}"
                        )
                        time.sleep(index_job_retry_interval)
                        continue
                    raise
                last_job_resp = job_resp
                summary["submit_index_add_documents_job"] = job_resp
                meta = _get_case_insensitive(job_resp, "_meta", {}) or {}
                code = _get_case_insensitive(meta, "code", "") or _get_case_insensitive(job_resp, "Code", "")
                message = _get_case_insensitive(meta, "message", "") or _get_case_insensitive(job_resp, "Message", "")
                status = _get_case_insensitive(job_resp, "Status", "") or _get_case_insensitive(meta, "status_code", "")
                print(
                    f"[{_now()}] 已调用SubmitIndexAddDocumentsJob：index_id={index_id}, "
                    f"code={code}, status={status}, message={message}"
                )
                if _submit_index_add_documents_job_response_succeeded(job_resp):
                    break

                http_sc = _get_case_insensitive(meta, "status_code", None)
                http_int: Optional[int] = None
                try:
                    if http_sc is not None and str(http_sc).strip() != "":
                        http_int = int(http_sc)
                except (TypeError, ValueError):
                    http_int = None
                status_int: Optional[int] = None
                if isinstance(status, int):
                    status_int = status
                elif isinstance(status, str) and str(status).strip().isdigit():
                    try:
                        status_int = int(str(status).strip())
                    except ValueError:
                        status_int = None

                retry_for_http = (http_int is not None and http_int >= 400) or (
                    status_int is not None and status_int >= 400
                )
                if retry_for_http and submit_attempt < index_job_retry:
                    print(
                        f"[{_now()}] SubmitIndexAddDocumentsJob HTTP 非 2xx（{http_int or status_int}），"
                        f"{index_job_retry_interval}s 后重试 ({submit_attempt + 1}/{index_job_retry + 1})"
                    )
                    time.sleep(index_job_retry_interval)
                    continue

                # 已拿到响应但非成功且非明确 HTTP 错误：不再重复 Submit，避免同一次任务多次建索引任务
                raise RuntimeError(
                    f"SubmitIndexAddDocumentsJob返回未判为成功（已停止重试）：code={code}, status={status}, message={message}"
                )
            parsed_job_id = extract_bailian_job_id(last_job_resp or {})
            print(f"[{_now()}] SubmitIndexAddDocumentsJob 解析 job_id={parsed_job_id or '<空>'}")
            if not str(parsed_job_id).strip() and isinstance(last_job_resp, dict):
                top_keys = [k for k in last_job_resp.keys() if k != "_meta"][:40]
                data_blob = _get_case_insensitive(last_job_resp, "data", None) or _get_case_insensitive(
                    last_job_resp, "Data", None
                )
                data_keys: List[str] = []
                if isinstance(data_blob, dict):
                    data_keys = list(data_blob.keys())[:40]
                elif data_blob is not None:
                    data_keys = [f"<非 dict: {type(data_blob).__name__}>"]
                print(
                    f"[{_now()}] 未解析到 job_id：响应顶层键（节选）={top_keys}；"
                    f"Data 内键（节选）={data_keys}（不打印敏感字段值）"
                )
            _apply_index_outcome_to_kb_upload_records(
                summary,
                upload_records_db_path,
                last_job_resp,
                None,
            )
            summary["index_job_poll_enabled"] = index_poll_enabled
            job_id_for_poll = str(parsed_job_id).strip()
            if not str(job_id_for_poll).strip():
                summary["index_job_poll_status"] = "SKIPPED_NO_JOB_ID"
                summary["index_job_poll_started_at"] = ""
                summary["index_job_poll_finished_at"] = _now()
                summary["index_job_poll_attempts"] = 0
                summary["index_job_final_status"] = ""
                summary["index_job_status_raw"] = None
                summary["index_job_poll_last_error"] = "SubmitIndexAddDocumentsJob 响应中未解析到 job_id，无法轮询 GetIndexJobStatus"
            elif not index_poll_enabled:
                summary["index_job_poll_status"] = "DISABLED"
                summary["index_job_poll_started_at"] = ""
                summary["index_job_poll_finished_at"] = _now()
                summary["index_job_poll_attempts"] = 0
                summary["index_job_final_status"] = "SUBMITTED_ONLY"
                summary["index_job_status_raw"] = None
                summary["index_job_poll_last_error"] = ""
            else:
                if not hasattr(client_for_index_job, "get_index_job_status_with_options"):
                    summary["index_job_poll_status"] = "SDK_UNSUPPORTED_OR_ERROR"
                    summary["index_job_poll_finished_at"] = _now()
                    summary["index_job_poll_last_error"] = (
                        "当前 SDK Client 无 get_index_job_status_with_options，请执行：pip install -U alibabacloud-bailian20231229"
                    )
                    print(f"[{_now()}] {summary['index_job_poll_last_error']}")
                else:
                    try:
                        poll_index_job_status_close_loop(
                            client_for_index_job,
                            workspace_id=workspace_id,
                            index_id=index_id,
                            job_id=str(job_id_for_poll).strip(),
                            summary=summary,
                            upload_records_db_path=upload_records_db_path,
                            poll_interval_sec=index_poll_interval_sec,
                            poll_timeout_sec=index_poll_timeout_sec,
                        )
                    except RuntimeError as rexc:
                        if "get_index_job_status" in str(rexc) or "SDK" in str(rexc):
                            summary["index_job_poll_status"] = "SDK_UNSUPPORTED_OR_ERROR"
                            summary["index_job_poll_finished_at"] = _now()
                            summary["index_job_poll_last_error"] = str(rexc)[:2000]
                            print(f"[{_now()}] GetIndexJobStatus 不可用，保持 INDEX_SUBMITTED：{rexc}")
                        else:
                            summary["index_job_poll_status"] = "ERROR"
                            summary["index_job_poll_finished_at"] = _now()
                            summary["index_job_poll_last_error"] = str(rexc)[:2000]
                            print(f"[{_now()}] 索引任务轮询异常（不重复提交任务）：{rexc}")
        except Exception as e:
            summary["submit_index_add_documents_job_error"] = str(e)
            print(f"[{_now()}] 调用SubmitIndexAddDocumentsJob失败（不影响已上传文件）：{e}")
            _apply_index_outcome_to_kb_upload_records(
                summary,
                upload_records_db_path,
                None,
                str(e),
            )
            summary["index_job_poll_enabled"] = index_poll_enabled
            summary["index_job_poll_status"] = "SUBMIT_FAILED_NO_POLL"
            summary["index_job_poll_finished_at"] = _now()
            summary["index_job_poll_last_error"] = str(e)[:2000]
    elif index_id and not summary.get("uploaded_file_ids"):
        print(f"[{_now()}] 本次无新上传文件（可能全部幂等跳过），已跳过 SubmitIndexAddDocumentsJob。")
        summary["index_job_poll_enabled"] = index_poll_enabled
        summary["index_job_poll_status"] = "NO_FILES_NO_SUBMIT"

    os.makedirs(out_root, exist_ok=True)
    upload_report_path = os.path.join(out_root, "aliyun_upload_report.json")
    with open(upload_report_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"[{_now()}] 上传完成：上传成功{summary['uploaded']}，解析成功{summary['parse_success']}，失败{summary['failed']}。")
    if summary.get("failed_details"):
        print(f"[{_now()}] 失败文件清单（文件名 -> 错误）：")
        for it in summary.get("failed_details", []):
            print(f"- {it.get('file_name','')} -> {it.get('error','')}")
    print(f"[{_now()}] 上传报告：{upload_report_path}")


if __name__ == "__main__":
    main()

