import hashlib
import json
import os
import re
import sys
import time
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple
import requests
from xml.etree import ElementTree as ET

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

STATUS_CODE_TO_TEXT = {
    # 与网页“时效性”筛选项对齐：尚未生效 / 有效 / 已修改 / 已废止
    "1": "已修改",
    "2": "已废止",
    "3": "有效",
    "4": "尚未生效",
}


@dataclass
class LawMeta:
    title: str
    issuer: str
    publish_date: str
    effective_date: str
    law_nature: str
    status_text: str
    detail_url: str
    bbbs: str


@dataclass
class DownloadIndexRow:
    no: int
    title: str
    bbbs: str
    fmt: str


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def sha256_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8", errors="ignore"))


def md5_file(file_path: str) -> str:
    md5_hash = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            md5_hash.update(chunk)
    return md5_hash.hexdigest()


def safe_filename(name: str) -> str:
    name = name.strip().replace("\u200b", "")
    return re.sub(r'[\\/:*?"<>|]', "_", name)


def pick_latest_file(dir_path: str, suffix: str) -> Optional[str]:
    if not os.path.isdir(dir_path):
        return None
    candidates = [fn for fn in os.listdir(dir_path) if fn.endswith(suffix)]
    if not candidates:
        return None
    candidates.sort()
    return os.path.join(dir_path, candidates[-1])


def read_text_auto(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except UnicodeDecodeError:
        with open(path, "r", encoding="gbk", errors="ignore") as f:
            return f.read()


def parse_bbbs_from_detail_url(url: str) -> str:
    # supports: https://flk.npc.gov.cn/detail?id=...
    m = re.search(r"[?&]id=([0-9a-fA-F]{16,64})", url)
    return m.group(1) if m else ""


def parse_law_index_meta(index_file_path: str) -> Dict[str, LawMeta]:
    """
    Parse `*-最新规范.txt` produced by script1 (law types).
    Returns dict: bbbs -> LawMeta
    """
    content = read_text_auto(index_file_path)

    # Each entry in current output is a block like:
    # No.X
    # 名称：...
    # 制定机关：...
    # 公布日期：...
    # 生效日期：...
    # 法律性质：...
    # 时效性：...
    # 网址：https://flk.npc.gov.cn/detail?id=...
    blocks = [b.strip() for b in content.split("\n\n") if b.strip()]
    out: Dict[str, LawMeta] = {}
    for b in blocks:
        if not b.startswith("No."):
            continue
        title = _kv_line(b, "名称：")
        issuer = _kv_line(b, "制定机关：")
        publish_date = _kv_line(b, "公布日期：")
        effective_date = _kv_line(b, "生效日期：")
        law_nature = _kv_line(b, "法律性质：")
        status_text = _kv_line(b, "时效性：")
        detail_url = _kv_line(b, "网址：")
        bbbs = parse_bbbs_from_detail_url(detail_url)
        if not bbbs:
            continue
        out[bbbs] = LawMeta(
            title=title,
            issuer=issuer,
            publish_date=publish_date,
            effective_date=effective_date,
            law_nature=law_nature,
            status_text=status_text,
            detail_url=detail_url,
            bbbs=bbbs,
        )
    return out


def _kv_line(block: str, prefix: str) -> str:
    for line in block.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return ""


def parse_download_index(download_index_path: str) -> List[DownloadIndexRow]:
    content = read_text_auto(download_index_path)
    blocks = [b.strip() for b in content.split("\n\n") if b.strip()]
    rows: List[DownloadIndexRow] = []
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 4:
            continue
        m1 = re.match(r"(\d+)：(.+)", lines[0])
        m2 = re.match(r"bbbs：(.+)", lines[1])
        m3 = re.match(r"格式：(.+)", lines[2])
        if not (m1 and m2 and m3):
            continue
        no = int(m1.group(1))
        title = m1.group(2).strip()
        bbbs = m2.group(1).strip()
        fmt = (m3.group(1).strip() or "docx")
        rows.append(DownloadIndexRow(no=no, title=title, bbbs=bbbs, fmt=fmt))
    rows.sort(key=lambda x: x.no)
    return rows


def list_local_doc_files(law_lib_dir: str) -> Dict[int, str]:
    """
    Map: no -> file_path
    expects filenames like `12.标题.docx`
    """
    mapping: Dict[int, str] = {}
    if not os.path.isdir(law_lib_dir):
        return mapping
    for fn in os.listdir(law_lib_dir):
        m = re.match(r"^(\d+)\.", fn)
        if not m:
            continue
        no = int(m.group(1))
        mapping[no] = os.path.join(law_lib_dir, fn)
    return mapping


def extract_docx_text(docx_path: str) -> str:
    """
    Pure-Python docx text extractor (no external deps).
    Keeps paragraph breaks; tries to preserve basic structure for chunking.
    """
    with zipfile.ZipFile(docx_path) as z:
        with z.open("word/document.xml") as fp:
            xml = fp.read()
    root = ET.fromstring(xml)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

    paras: List[str] = []
    for p in root.findall(".//w:p", ns):
        texts: List[str] = []
        for t in p.findall(".//w:t", ns):
            if t.text:
                texts.append(t.text)
        para = "".join(texts).strip()
        if para:
            paras.append(para)
    return "\n".join(paras).strip()


def clean_text_for_kb(text: str) -> str:
    """
    Keep structure for KB chunking:
    - normalize whitespace
    - keep paragraph breaks
    - remove obvious noise lines (pure page numbers / separators)
    """
    lines = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            lines.append("")
            continue
        if re.fullmatch(r"\d{1,4}", s):
            continue
        if re.fullmatch(r"[-‐–—_]{3,}", s):
            continue
        s = re.sub(r"[ \t]+", " ", s)
        lines.append(s)

    # collapse many blank lines to max 1
    out: List[str] = []
    blank = 0
    for ln in lines:
        if ln == "":
            blank += 1
            if blank <= 1:
                out.append("")
        else:
            blank = 0
            out.append(ln)
    return "\n".join(out).strip()


def format_for_regex_chunking(text: str) -> str:
    """
    Prepare body for stable Aliyun KB chunking.
    - Fix broken anchors caused by docx paragraph splits (e.g. "第…百二十八" + "条")
    - Reflow content so that "按换行切分" produces meaningful chunks:
      Prefer one article (第...条) per line/paragraph.
    """
    if not text:
        return ""

    anchor_re = re.compile(r"^第[一二三四五六七八九十百千0-9]{1,9}(章|节|条)")
    num_only_re = re.compile(r"^第[一二三四五六七八九十百千0-9]{1,9}$")
    unit_only = {"章", "节", "条"}

    # 1) normalize lines & remove multi blanks
    raw_lines = [ln.strip() for ln in text.splitlines()]
    raw_lines = [ln for ln in raw_lines if ln != "" or True]

    # 2) merge broken anchors: "...第十二" + "条" => "...第十二条"
    merged_lines: List[str] = []
    for ln in raw_lines:
        s = ln.strip()
        if not s:
            merged_lines.append("")
            continue
        if s in unit_only and merged_lines:
            # previous line might be "第…百二十八" or endswith "...百二十八"
            prev = merged_lines.pop()
            if prev:
                merged_lines.append((prev + s).strip())
            else:
                merged_lines.append(s)
            continue
        if merged_lines:
            prev = merged_lines[-1]
            if prev and num_only_re.match(prev) and s in unit_only:
                merged_lines[-1] = (prev + s).strip()
                continue
        merged_lines.append(s)

    # 3) If a line contains an anchor not at start, split it so anchor starts a new line
    split_lines: List[str] = []
    inline_anchor = re.compile(r"(第[一二三四五六七八九十百千0-9]{1,9}(章|节|条))")
    for ln in merged_lines:
        s = ln.strip()
        if not s:
            split_lines.append("")
            continue
        m = inline_anchor.search(s)
        if m and m.start() > 0:
            pre = s[: m.start()].strip()
            post = s[m.start() :].strip()
            if pre:
                split_lines.append(pre)
            split_lines.append(post)
        else:
            split_lines.append(s)

    # 4) group lines into chunks for newline-splitting:
    #    - preface (anything before first 章/节/条) becomes ONE line (序言不切)
    #    - keep "第...章/节" as its own line
    #    - merge "第...条" with subsequent lines until next anchor (一条一行)
    chunks: List[str] = []
    buf: List[str] = []
    buf_kind: Optional[str] = None  # "article" | None
    preface_buf: List[str] = []
    saw_first_anchor = False

    # Special: preface section like "序言/前言" should not be split.
    preface_section_buf: List[str] = []
    in_preface_section = False

    def flush_buf():
        nonlocal buf, buf_kind
        if not buf:
            return
        merged = " ".join([x for x in buf if x]).strip()
        if merged:
            chunks.append(merged)
        buf = []
        buf_kind = None

    for ln in split_lines:
        s = ln.strip()
        if not s:
            # keep paragraph boundary only when we are not inside an article buffer
            if in_preface_section:
                continue
            if buf_kind is None:
                flush_buf()
            continue

        m = anchor_re.match(s)
        if m:
            # if we are inside 序言/前言 section, flush it as ONE chunk before anchors
            if in_preface_section:
                merged_preface = " ".join([x for x in preface_section_buf if x]).strip()
                if merged_preface:
                    chunks.append(merged_preface)
                preface_section_buf = []
                in_preface_section = False

            if not saw_first_anchor:
                # flush preface into one chunk before first anchor
                preface = " ".join([x for x in preface_buf if x]).strip()
                if preface:
                    chunks.append(preface)
                preface_buf = []
                saw_first_anchor = True

            kind = m.group(1)  # 章/节/条
            if kind in {"章", "节"}:
                flush_buf()
                chunks.append(s)
                continue
            # kind == 条
            flush_buf()
            buf_kind = "article"
            buf.append(s)
            continue

        # non-anchor line
        # detect start of preface section
        s_compact = re.sub(r"\s+", "", s)
        if s_compact in {"序言", "前言"}:
            # flush any ongoing buffers
            flush_buf()
            if not saw_first_anchor:
                preface_buf = []
                saw_first_anchor = True
            in_preface_section = True
            preface_section_buf = [s_compact]
            continue

        if in_preface_section:
            preface_section_buf.append(s)
            continue

        if not saw_first_anchor:
            preface_buf.append(s)
            continue
        if buf_kind == "article":
            buf.append(s)
        else:
            flush_buf()
            chunks.append(s)

    flush_buf()
    if in_preface_section:
        merged_preface = " ".join([x for x in preface_section_buf if x]).strip()
        if merged_preface:
            chunks.append(merged_preface)
    if not saw_first_anchor:
        preface = " ".join([x for x in preface_buf if x]).strip()
        if preface:
            chunks.append(preface)

    # Collapse extra blanks again
    final_lines: List[str] = []
    for c in chunks:
        c = re.sub(r"[ \t]+", " ", c).strip()
        if c:
            final_lines.append(c)
    return "\n".join(final_lines).strip()


def remove_toc_chunks(chunks: List[str]) -> List[str]:
    """
    Remove leading table-of-contents chunks (目录) if present.
    Typical pattern: starts with '目录' then many short chapter/section titles.
    """
    if not chunks:
        return chunks
    i = 0
    # skip empty
    while i < len(chunks) and not chunks[i].strip():
        i += 1
    if i >= len(chunks):
        return chunks

    head = re.sub(r"\s+", "", chunks[i])
    looks_like_toc = head in {"目录", "目錄"}
    # Heuristic: even without explicit "目录", if first ~20 lines are mostly short chapter/section titles,
    # treat them as toc.
    if not looks_like_toc:
        sample = chunks[i : min(i + 20, len(chunks))]
        cs = 0
        art = 0
        other_long = 0
        for s0 in sample:
            s = (s0 or "").strip()
            if not s:
                continue
            if re.match(r"^第[一二三四五六七八九十百千0-9]{1,9}条", s):
                art += 1
            elif re.match(r"^第[一二三四五六七八九十百千0-9]{1,9}(章|节)", s) and len(s) <= 40:
                cs += 1
            elif len(s) >= 60:
                other_long += 1
        if cs >= 6 and art == 0 and other_long == 0:
            looks_like_toc = True
        else:
            return chunks

    # toc mode: skip subsequent short chapter/section lines until we hit 序言/前言 or an article line
    out: List[str] = []
    if head in {"目录", "目錄"}:
        i += 1
    for j in range(i, len(chunks)):
        s = chunks[j].strip()
        if not s:
            continue
        compact = re.sub(r"\s+", "", s)
        if compact in {"序言", "前言"}:
            out.extend(chunks[j:])
            return out
        if re.match(r"^第[一二三四五六七八九十百千0-9]{1,9}条", s):
            out.extend(chunks[j:])
            return out
        # skip short toc lines like "第一章 总纲" / "第一节 ..."
        if len(s) <= 40 and re.match(r"^第[一二三四五六七八九十百千0-9]{1,9}(章|节)", s):
            continue
        # if it's still short, likely toc, keep skipping; once we see substantial text, stop skipping
        if len(s) <= 40:
            continue
        out.extend(chunks[j:])
        return out
    return out


def build_source_info_line(meta: LawMeta) -> str:
    status_norm = normalize_status_text(meta.status_text)
    return (
        f"法规名：{meta.title} | "
        f"类型：{meta.law_nature or ''} | "
        f"时效性：{status_norm} | "
        f"公布日期：{meta.publish_date} | "
        f"生效日期：{meta.effective_date} | "
        f"链接：{meta.detail_url}"
    ).strip()


def render_kb_lines(meta: LawMeta, body_text: str) -> List[str]:
    """
    Produce newline-separated KB slices. Each line is one slice.
    Format requirement (single-line, easy to scan):
    【来源信息】...  【章节】...  【法规正文】...
    """
    chunks = [ln.strip() for ln in (body_text or "").splitlines() if ln.strip()]
    chunks = remove_toc_chunks(chunks)

    source = build_source_info_line(meta)
    chapter_ctx = ""
    preface_buf: List[str] = []
    in_preface = False

    lines: List[str] = []
    article_re = re.compile(r"^(第[一二三四五六七八九十百千0-9]{1,9}条)(.*)$")
    chapter_re = re.compile(r"^第[一二三四五六七八九十百千0-9]{1,9}(章|节)")

    for c in chunks:
        compact = re.sub(r"\s+", "", c)
        if compact in {"序言", "前言"}:
            # start preface section (must be ONE slice)
            chapter_ctx = "序言"
            in_preface = True
            preface_buf = []
            continue

        if chapter_re.match(c):
            if in_preface:
                merged_preface = " ".join([x for x in preface_buf if x]).strip()
                if merged_preface:
                    lines.append(f"【来源信息】{source}  【章节】序言  【法规正文】{merged_preface}")
                preface_buf = []
                in_preface = False
            chapter_ctx = c
            continue

        # preface content (after 序言/前言) -> accumulate into one line
        if in_preface:
            preface_buf.append(c)
            continue

        m = article_re.match(c)
        if m:
            article = m.group(1).strip()
            info = (m.group(2) or "").strip()
            chapter_part = chapter_ctx.strip()
            if chapter_part:
                section = f"{chapter_part}  {article}"
            else:
                section = article
            lines.append(f"【来源信息】{source}  【章节】{section}  【法规正文】{info or ''}".rstrip())
            continue

        # fallback: keep as its own slice with current chapter context if any
        section = chapter_ctx.strip() if chapter_ctx else ""
        if section:
            lines.append(f"【来源信息】{source}  【章节】{section}  【法规正文】{c}")
        else:
            lines.append(f"【来源信息】{source}  【法规正文】{c}")

    return lines

def normalize_status_text(status_text: str) -> str:
    """
    Normalize to website filter labels:
    - 尚未生效 / 有效 / 已修改 / 已废止
    Accepts legacy labels from earlier scripts.
    """
    s = (status_text or "").strip()
    if not s:
        return ""
    # legacy -> new
    legacy_map = {
        "即将生效": "尚未生效",
        "尚未生效": "尚未生效",
        "现行有效": "有效",
        "有效": "有效",
        "已失效": "已废止",
        "已废止": "已废止",
        "已修改": "已修改",
    }
    if s in legacy_map:
        return legacy_map[s]

    # allow inputs like "状态编码3" or just "3"
    m = re.search(r"(\d)", s)
    if m:
        code = m.group(1)
        return STATUS_CODE_TO_TEXT.get(code, s)
    return s


def build_upload_markdown(meta: LawMeta, body: str) -> str:
    # 输出为“按换行切分”的最终切片形态：每行一个切片，且每行包含来源信息+章节+法规信息
    lines = render_kb_lines(meta, body)
    return "\n".join(lines).strip() + "\n"


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def write_jsonl(path: str, rows: Iterable[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


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
    for k, v in d.items():
        if str(k).lower() == key_low:
            return v
    return default


def create_bailian_client():
    """
    Create Bailian client from env vars:
    - ALIBABA_CLOUD_ACCESS_KEY_ID
    - ALIBABA_CLOUD_ACCESS_KEY_SECRET
    - ALIBABA_CLOUD_SECURITY_TOKEN (optional)
    """
    try:
        from alibabacloud_tea_openapi import models as open_api_models
        from alibabacloud_bailian20231229.client import Client as BailianClient
    except Exception as e:
        print("缺少阿里云百炼Python SDK，请先安装：")
        print("pip install alibabacloud-bailian20231229 alibabacloud-tea-openapi alibabacloud-tea-util")
        raise RuntimeError(f"SDK导入失败：{e}")

    access_key_id = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID", "").strip()
    access_key_secret = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "").strip()
    security_token = os.getenv("ALIBABA_CLOUD_SECURITY_TOKEN", "").strip()
    if not access_key_id or not access_key_secret:
        raise RuntimeError(
            "未检测到阿里云凭证环境变量，请设置 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET。"
        )

    config = open_api_models.Config(
        access_key_id=access_key_id,
        access_key_secret=access_key_secret,
    )
    if security_token:
        config.security_token = security_token
    config.endpoint = "bailian.cn-beijing.aliyuncs.com"
    return BailianClient(config)


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
    return model_to_dict(resp)


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
        x_match = re.search(r'X-bailian-extra["\']?\s*[:=]\s*["\']([^"\']+)["\']', headers_raw)
        c_match = re.search(r'Content-Type["\']?\s*[:=]\s*["\']([^"\']*)["\']', headers_raw)
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
    return model_to_dict(resp)


def describe_file(client, workspace_id: str, file_id: str):
    try:
        from alibabacloud_tea_util import models as util_models
    except Exception as e:
        raise RuntimeError(f"SDK模型导入失败：{e}")
    runtime = util_models.RuntimeOptions()
    resp = client.describe_file_with_options(workspace_id, file_id, {}, runtime)
    return model_to_dict(resp)


def upload_cleaned_files_to_bailian(
    upload_dir: str,
    workspace_id: str,
    category_id: str = "default",
    parser: str = "DASHSCOPE_DOCMIND",
    poll_interval_sec: int = 15,
    poll_timeout_sec: int = 7200,
) -> Dict[str, Any]:
    client = create_bailian_client()
    files = [
        os.path.join(upload_dir, fn)
        for fn in os.listdir(upload_dir)
        if os.path.isfile(os.path.join(upload_dir, fn))
    ]
    files.sort()
    if not files:
        return {"uploaded": 0, "parse_success": 0, "failed": 0, "details": []}

    details = []
    uploaded = 0
    parse_success = 0
    failed = 0

    for idx, file_path in enumerate(files, start=1):
        file_name = os.path.basename(file_path)
        print(f"[{_now()}] ({idx}/{len(files)}) 上传开始：{file_name}")
        item = {"file_name": file_name, "file_path": file_path}
        try:
            lease_resp = apply_upload_lease(client, category_id, file_path, workspace_id)
            data = _get_case_insensitive(lease_resp, "data", {}) or {}
            if not isinstance(data, dict):
                data = model_to_dict(data)
            lease_id = _get_case_insensitive(data, "file_upload_lease_id", "") or _get_case_insensitive(
                data, "FileUploadLeaseId", ""
            )
            if not lease_id:
                raise RuntimeError("ApplyFileUploadLease返回中缺少FileUploadLeaseId")

            upload_file_to_presigned_url(lease_resp, file_path)

            add_resp = add_file_by_lease(client, workspace_id, category_id, lease_id, parser)
            add_data = _get_case_insensitive(add_resp, "data", {}) or {}
            if not isinstance(add_data, dict):
                add_data = model_to_dict(add_data)
            file_id = _get_case_insensitive(add_data, "file_id", "") or _get_case_insensitive(add_data, "FileId", "")
            if not file_id:
                raise RuntimeError("AddFile返回中缺少FileId")

            uploaded += 1
            item["lease_id"] = lease_id
            item["file_id"] = file_id

            deadline = time.time() + poll_timeout_sec
            last_status = ""
            while time.time() < deadline:
                desc = describe_file(client, workspace_id, file_id)
                d = _get_case_insensitive(desc, "data", {}) or {}
                if not isinstance(d, dict):
                    d = model_to_dict(d)
                status = (_get_case_insensitive(d, "status", "") or _get_case_insensitive(d, "Status", "")).upper()
                if status:
                    last_status = status
                if status == "PARSE_SUCCESS":
                    parse_success += 1
                    item["parse_status"] = status
                    print(f"[{_now()}] 解析完成：{file_name} -> {file_id}")
                    break
                if status in {"PARSE_FAILED", "FAILED"}:
                    item["parse_status"] = status
                    raise RuntimeError(f"解析失败，状态={status}")
                time.sleep(max(3, poll_interval_sec))
            else:
                item["parse_status"] = last_status or "TIMEOUT"
                raise RuntimeError(f"解析超时（>{poll_timeout_sec}s），最后状态={item['parse_status']}")

            item["success"] = True
        except Exception as e:
            failed += 1
            item["success"] = False
            item["error"] = str(e)
            print(f"[{_now()}] 上传失败：{file_name}，错误：{e}")
        details.append(item)

    return {
        "uploaded": uploaded,
        "parse_success": parse_success,
        "failed": failed,
        "details": details,
    }


def main() -> None:
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
        sys.exit(1)

    base_path = input("输入数据库所在目录（绝对路径）：").strip().strip('"').strip("'")
    if not base_path:
        print("目录不能为空。")
        sys.exit(1)

    t = time.strftime("%Y-%m-%d")
    law_root = os.path.join(base_path, "法规爬虫", DIC[law_type])
    index_dir = os.path.join(law_root, "法规索引")
    mid_dir = os.path.join(law_root, "中间文档")
    lib_dir = os.path.join(law_root, f"{DIC[law_type]}库")

    today_index = os.path.join(index_dir, f"{t}-最新规范.txt")
    index_path = today_index if os.path.exists(today_index) else pick_latest_file(index_dir, "-最新规范.txt")
    if not index_path:
        print("未找到法规索引（*-最新规范.txt）；请先运行法规爬虫1生成。")
        sys.exit(1)

    today_download = os.path.join(mid_dir, f"{t}-下载索引.txt")
    download_path = today_download if os.path.exists(today_download) else pick_latest_file(mid_dir, "-下载索引.txt")
    if not download_path:
        print("未找到下载索引（*-下载索引.txt）；请先运行法规爬虫2生成。")
        sys.exit(1)

    out_root = os.path.join(law_root, "清洗产物")
    upload_root = os.path.join(out_root, "aliyun_upload")
    upload_type_dir = os.path.join(upload_root, DIC[law_type])
    ensure_dir(upload_type_dir)

    report_path = os.path.join(out_root, "clean_report.txt")
    master_path = os.path.join(out_root, "law_master.jsonl")

    print(f"[{_now()}] 使用索引：{os.path.basename(index_path)}")
    print(f"[{_now()}] 使用下载索引：{os.path.basename(download_path)}")
    print(f"[{_now()}] 本地库目录：{lib_dir}")
    print(f"[{_now()}] 输出目录：{out_root}")

    metas_by_bbbs = parse_law_index_meta(index_path)
    download_rows = parse_download_index(download_path)
    local_by_no = list_local_doc_files(lib_dir)

    # Reports
    missing_doc = []
    missing_meta = []
    extracted_fail = []
    written = 0

    master_rows: List[dict] = []
    for row in download_rows:
        doc_path = local_by_no.get(row.no, "")
        if not doc_path or not os.path.exists(doc_path):
            missing_doc.append({"no": row.no, "title": row.title, "bbbs": row.bbbs})
            continue
        meta = metas_by_bbbs.get(row.bbbs)
        if not meta:
            missing_meta.append({"no": row.no, "title": row.title, "bbbs": row.bbbs, "doc_path": doc_path})
            continue

        try:
            raw_text = extract_docx_text(doc_path)
            cleaned = clean_text_for_kb(raw_text)
            cleaned = format_for_regex_chunking(cleaned)
        except Exception as e:
            extracted_fail.append({"no": row.no, "title": row.title, "bbbs": row.bbbs, "doc_path": doc_path, "error": str(e)})
            continue

        if not cleaned:
            extracted_fail.append({"no": row.no, "title": row.title, "bbbs": row.bbbs, "doc_path": doc_path, "error": "正文抽取为空"})
            continue

        doc_id = f"law_{row.bbbs}"
        title_for_name = safe_filename(meta.title or row.title or doc_id)
        publish_for_name = re.sub(r"[^0-9\-]", "", (meta.publish_date or "").strip()) or "unknown-date"
        out_name = f"{title_for_name}__{publish_for_name}__{row.bbbs}.md"
        out_path = os.path.join(upload_type_dir, out_name)

        md = build_upload_markdown(meta, cleaned)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(md)

        master_rows.append(
            {
                "doc_id": doc_id,
                "bbbs": row.bbbs,
                "title": meta.title or row.title,
                "law_type": DIC[law_type],
                "status_text": normalize_status_text(meta.status_text),
                "publish_date": meta.publish_date,
                "effective_date": meta.effective_date,
                "issuer": meta.issuer,
                "law_nature": meta.law_nature,
                "detail_url": meta.detail_url,
                "download_format": row.fmt,
                "no": row.no,
                "local_file_path": doc_path,
                "upload_file_name": out_name,
                "upload_file_path": out_path,
                "content": cleaned,
                "content_char_count": len(cleaned),
                "content_sha256": sha256_text(cleaned),
                "source_index_file": index_path,
                "source_download_index_file": download_path,
                "clean_version": "v1",
            }
        )
        written += 1

    ensure_dir(out_root)
    write_jsonl(master_path, master_rows)

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(f"清洗时间：{_now()}\n")
        f.write(f"法规类型：{DIC[law_type]}\n")
        f.write(f"使用法规索引：{index_path}\n")
        f.write(f"使用下载索引：{download_path}\n")
        f.write(f"本地库目录：{lib_dir}\n")
        f.write(f"输出目录：{out_root}\n")
        f.write("\n")
        f.write(f"成功生成上传文件：{written} 条\n")
        f.write(f"缺少正文文件（下载缺失）：{len(missing_doc)} 条\n")
        f.write(f"缺少元信息（索引缺失/未解析到bbbs）：{len(missing_meta)} 条\n")
        f.write(f"正文抽取失败/为空：{len(extracted_fail)} 条\n")
        f.write("\n")

        if missing_doc:
            f.write("=== 缺少正文文件（下载缺失） ===\n")
            for it in missing_doc[:500]:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")
            if len(missing_doc) > 500:
                f.write(f"... 省略 {len(missing_doc) - 500} 条\n")
            f.write("\n")

        if missing_meta:
            f.write("=== 缺少元信息（索引缺失/未解析到bbbs） ===\n")
            for it in missing_meta[:500]:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")
            if len(missing_meta) > 500:
                f.write(f"... 省略 {len(missing_meta) - 500} 条\n")
            f.write("\n")

        if extracted_fail:
            f.write("=== 正文抽取失败/为空 ===\n")
            for it in extracted_fail[:500]:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")
            if len(extracted_fail) > 500:
                f.write(f"... 省略 {len(extracted_fail) - 500} 条\n")
            f.write("\n")

    print(f"[{_now()}] 完成：生成 {written} 条上传文件。")
    print(f"[{_now()}] 主数据表：{master_path}")
    print(f"[{_now()}] 报告：{report_path}")


if __name__ == "__main__":
    main()

