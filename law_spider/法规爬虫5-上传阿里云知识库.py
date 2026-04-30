import hashlib
import inspect
import json
import os
import re
import time
from typing import Any, Dict, List

import requests

# 避免 Windows/GBK 控制台在打印生僻字时抛出 UnicodeEncodeError
try:
    import sys
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


def upload_cleaned_files_to_bailian(
    upload_dir: str,
    workspace_id: str,
    category_id: str = "default",
    parser: str = "DASHSCOPE_DOCMIND",
    knowledge_base_name: str = "",
    poll_interval_sec: int = 15,
    poll_timeout_sec: int = 7200,
    file_paths: List[str] = None,
    max_retry_per_file: int = 1,
) -> Dict[str, Any]:
    client = create_bailian_client()
    effective_category_id = category_id
    if file_paths is not None:
        files = [p for p in file_paths if os.path.isfile(p)]
    else:
        files = [
            os.path.join(upload_dir, fn)
            for fn in os.listdir(upload_dir)
            if os.path.isfile(os.path.join(upload_dir, fn))
        ]
    files.sort()
    if not files:
        return {"uploaded": 0, "parse_success": 0, "failed": 0, "details": []}

    details: List[Dict[str, Any]] = []
    uploaded = 0
    parse_success = 0
    failed = 0
    uploaded_file_ids: List[str] = []
    pending_parse_indices: List[int] = []

    for idx, file_path in enumerate(files, start=1):
        file_name = os.path.basename(file_path)
        print(f"[{_now()}] ({idx}/{len(files)}) 上传开始：{file_name}")
        item: Dict[str, Any] = {
            "file_name": file_name,
            "file_path": file_path,
            "knowledge_base_name": knowledge_base_name,
            "workspace_id": workspace_id,
            "category_id": effective_category_id,
            "parser": parser,
        }
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
    }


def is_category_not_found_error(err: Exception) -> bool:
    msg = str(err)
    return ("InvalidParameter" in msg) and ("category_id" in msg or "category" in msg) and ("Cant find out category" in msg)


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
    if env_chunk_separator:
        print(f"[{_now()}] 使用.env中的Separator正则：{chunk_separator}")
    else:
        print(f"[{_now()}] 未配置Separator，已按法规爬虫4格式默认使用：{chunk_separator}")
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
        upload_files_from_master = load_upload_files_from_master(master_path)
    except RuntimeError as e:
        print(f"[{_now()}] {e}")
        return

    if not os.path.isdir(upload_dir):
        print(f"未找到清洗上传目录：{upload_dir}")
        print("请先运行 法规爬虫4-清洗与知识库导出.py 生成清洗上传文件。")
        return
    print(f"[{_now()}] 使用 law_master.jsonl 精确上传：{master_path}")
    print(f"[{_now()}] 本次将上传文件数：{len(upload_files_from_master)}")

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
            )
        else:
            raise

    # 可选：按示例接口将已上传文件提交到知识库（Index）
    if index_id and summary.get("uploaded_file_ids"):
        try:
            if client_for_index_job is None:
                client_for_index_job = create_bailian_client()
            if chunk_mode:
                print(
                    f"[{_now()}] 提交知识库切片参数：chunk_mode={chunk_mode}, "
                    f"separator={chunk_separator or '<empty>'}, chunk_size={chunk_size or '<default>'}, "
                    f"overlap_size={overlap_size if env_overlap_size else '<default>'}"
                )
            summary["index_id"] = index_id
            last_job_resp = None
            for attempt in range(index_job_retry + 1):
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
                # Bailian OpenAPI 有时会把业务错误放在 body 里，但 HTTP status_code 仍是 200。
                # 这里以 Code 是否存在且非空/Status>=400 作为失败信号。
                is_failed = False
                try:
                    if str(code).strip():
                        # 只要返回 Code 且不是 Success=true 的形态，通常就是失败
                        is_failed = True
                except Exception:
                    pass
                try:
                    if isinstance(status, int) and status >= 400:
                        is_failed = True
                    elif isinstance(status, str) and status.strip().isdigit() and int(status.strip()) >= 400:
                        is_failed = True
                except Exception:
                    pass
                if not is_failed:
                    break
                # 典型暂态：Index.IndexInitError，指数初始化中/异常时会返回 500；做退避重试
                if attempt < index_job_retry:
                    time.sleep(index_job_retry_interval)
                    continue
                raise RuntimeError(f"SubmitIndexAddDocumentsJob失败：code={code}, status={status}, message={message}")
        except Exception as e:
            summary["submit_index_add_documents_job_error"] = str(e)
            print(f"[{_now()}] 调用SubmitIndexAddDocumentsJob失败（不影响已上传文件）：{e}")

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

