from __future__ import annotations

import asyncio
import contextlib
import json
import locale
import os
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth.config import AuthUserRecord
from auth.dependencies import require_admin

router = APIRouter(prefix="/kb-update", tags=["kb-update"])

LawType = Literal[
    "xf",
    "flfg",
    "xzfg",
    "jcfg",
    "sfjs",
    "dfxfg",
    "tiaoyue",
    "shuangbian",
    "duobian",
]
StepId = Literal[
    "env_check",
    "law_index_update",
    "treaty_index_update",
    "treaty_download",
    "kb_export",
    "kb_upload",
    "result_summary",
]
JobStatus = Literal["PENDING", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"]
StepStatus = Literal["pending", "running", "success", "failed", "skipped"]

ALL_STEPS: List[StepId] = [
    "env_check",
    "law_index_update",
    "treaty_index_update",
    "treaty_download",
    "kb_export",
    "kb_upload",
    "result_summary",
]

LAW_TYPES = {"xf", "flfg", "xzfg", "jcfg", "sfjs", "dfxfg"}
TREATY_TYPES = {"tiaoyue", "shuangbian", "duobian"}


class CreateJobRequest(BaseModel):
    law_type: LawType
    storage_root: str = Field(..., min_length=1)
    run_mode: Literal["full_run", "step_run"] = "full_run"
    steps: List[StepId] = Field(default_factory=lambda: ALL_STEPS.copy())
    start_page: int = 0
    end_page: int = 0
    treaty_start_page: int = 1
    download_pdf: bool = False


class StepProgress(BaseModel):
    step: StepId
    label: str
    status: StepStatus
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    duration_seconds: Optional[float] = None


class JobData(BaseModel):
    job_id: str
    law_type: LawType
    storage_root: str
    run_mode: Literal["full_run", "step_run"]
    steps: List[StepId]
    start_page: int
    end_page: int
    treaty_start_page: int
    download_pdf: bool
    status: JobStatus
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    duration_seconds: Optional[float] = None
    error: Optional[str] = None
    logs: List[str] = Field(default_factory=list)
    step_progress: List[StepProgress] = Field(default_factory=list)


class CreateJobResponse(BaseModel):
    job_id: str
    status: JobStatus


class StartJobResponse(BaseModel):
    job_id: str
    status: JobStatus


class StopJobResponse(BaseModel):
    job_id: str
    status: JobStatus


class JobListResponse(BaseModel):
    total: int
    items: List[JobData]


class JobSnapshotResponse(BaseModel):
    job: JobData


class KBValidateReportSummaryResponse(BaseModel):
    """清洗产物目录下的 validate_report.json 摘要（由 scripts/validate_kb_export.py 生成）。"""

    exists: bool = False
    applicable: bool = True
    report_path: str = ""
    total_chunks: Optional[int] = None
    error_count: Optional[int] = None
    warning_count: Optional[int] = None
    allow_upload: Optional[bool] = None
    parse_error: Optional[str] = None


# 与 frontend `lawTypeLabel` / 法规爬虫目录名一致
LAW_TYPE_LABEL_CN: Dict[str, str] = {
    "xf": "宪法",
    "flfg": "法律",
    "xzfg": "行政法规",
    "jcfg": "监察法规",
    "sfjs": "司法解释",
    "dfxfg": "地方法规",
    "tiaoyue": "条约（全部）",
    "shuangbian": "双边条约",
    "duobian": "多边条约",
}

_LEGAL_AI_ROOT = Path(__file__).resolve().parents[1]


def _kb_update_db_path() -> Path:
    raw = os.environ.get("KB_UPDATE_DB_PATH", "").strip()
    if not raw:
        return _LEGAL_AI_ROOT / "data" / "kb_update.db"
    p = Path(raw)
    if p.is_absolute():
        return p.resolve()
    return (_LEGAL_AI_ROOT / p).resolve()


def _validate_report_path_for_job(job: JobData) -> tuple[bool, Path, str]:
    """
    返回 (是否适用法规类路径, Path, 展示用绝对/规范化路径字符串)。
    条约类不适用与法规相同的「法规爬虫/{中文类型}/清洗产物」约定。
    """
    if job.law_type in TREATY_TYPES:
        return False, Path(), ""
    label = LAW_TYPE_LABEL_CN.get(job.law_type, job.law_type)
    p = Path(job.storage_root) / "法规爬虫" / label / "清洗产物" / "validate_report.json"
    try:
        resolved = str(p.resolve())
    except Exception:
        resolved = str(p)
    return True, p, resolved


JOB_STORE: Dict[str, JobData] = {}
TASK_STORE: Dict[str, asyncio.Task] = {}
PROCESS_STORE: Dict[str, asyncio.subprocess.Process] = {}
STORE_LOCK = asyncio.Lock()

STEP_LABELS = {
    "env_check": "环境与目录检查",
    "law_index_update": "法规索引更新",
    "treaty_index_update": "建立下载索引",
    "treaty_download": "库下载",
    "kb_export": "清洗与知识库导出",
    "kb_upload": "上传阿里云知识库",
    "result_summary": "结果汇总",
}


def _db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_kb_update_db_path()), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    db_path = _kb_update_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _db_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS kb_jobs (
              job_id TEXT PRIMARY KEY,
              law_type TEXT NOT NULL,
              storage_root TEXT NOT NULL,
              run_mode TEXT NOT NULL,
              steps_json TEXT NOT NULL,
              start_page INTEGER NOT NULL,
              end_page INTEGER NOT NULL,
              treaty_start_page INTEGER NOT NULL,
              download_pdf INTEGER NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              duration_seconds REAL,
              error TEXT
            );

            CREATE TABLE IF NOT EXISTS kb_job_steps (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL,
              step TEXT NOT NULL,
              label TEXT NOT NULL,
              status TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              duration_seconds REAL
            );
            CREATE INDEX IF NOT EXISTS idx_kb_job_steps_job_id ON kb_job_steps(job_id);

            CREATE TABLE IF NOT EXISTS kb_job_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              message TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_kb_job_logs_job_id_id ON kb_job_logs(job_id, id);
            """
        )


def _save_job(job: JobData) -> None:
    with _db_conn() as conn:
        conn.execute(
            """
            INSERT INTO kb_jobs (
              job_id, law_type, storage_root, run_mode, steps_json,
              start_page, end_page, treaty_start_page, download_pdf, status,
              created_at, started_at, finished_at, duration_seconds, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
              law_type=excluded.law_type,
              storage_root=excluded.storage_root,
              run_mode=excluded.run_mode,
              steps_json=excluded.steps_json,
              start_page=excluded.start_page,
              end_page=excluded.end_page,
              treaty_start_page=excluded.treaty_start_page,
              download_pdf=excluded.download_pdf,
              status=excluded.status,
              created_at=excluded.created_at,
              started_at=excluded.started_at,
              finished_at=excluded.finished_at,
              duration_seconds=excluded.duration_seconds,
              error=excluded.error
            """,
            (
                job.job_id,
                job.law_type,
                job.storage_root,
                job.run_mode,
                json.dumps(job.steps, ensure_ascii=False),
                job.start_page,
                job.end_page,
                job.treaty_start_page,
                1 if job.download_pdf else 0,
                job.status,
                job.created_at,
                job.started_at,
                job.finished_at,
                job.duration_seconds,
                job.error,
            ),
        )


def _save_steps(job: JobData) -> None:
    with _db_conn() as conn:
        conn.execute("DELETE FROM kb_job_steps WHERE job_id = ?", (job.job_id,))
        conn.executemany(
            """
            INSERT INTO kb_job_steps (
              job_id, step, label, status, started_at, finished_at, duration_seconds
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    job.job_id,
                    s.step,
                    s.label,
                    s.status,
                    s.started_at,
                    s.finished_at,
                    s.duration_seconds,
                )
                for s in job.step_progress
            ],
        )


def _save_job_state(job: JobData) -> None:
    _save_job(job)
    _save_steps(job)


def _insert_log(job_id: str, created_at: str, message: str) -> None:
    with _db_conn() as conn:
        conn.execute(
            "INSERT INTO kb_job_logs (job_id, created_at, message) VALUES (?, ?, ?)",
            (job_id, created_at, message),
        )


def _load_job_from_db(job_id: str) -> Optional[JobData]:
    with _db_conn() as conn:
        job_row = conn.execute("SELECT * FROM kb_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not job_row:
            return None
        step_rows = conn.execute(
            "SELECT step, label, status, started_at, finished_at, duration_seconds FROM kb_job_steps WHERE job_id = ? ORDER BY id ASC",
            (job_id,),
        ).fetchall()
        log_rows = conn.execute(
            "SELECT created_at, message FROM kb_job_logs WHERE job_id = ? ORDER BY id ASC",
            (job_id,),
        ).fetchall()

    step_progress = [
        StepProgress(
            step=row["step"],
            label=row["label"],
            status=row["status"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            duration_seconds=row["duration_seconds"],
        )
        for row in step_rows
    ]
    logs = [f"[{row['created_at']}] {row['message']}" for row in log_rows]
    steps = json.loads(job_row["steps_json"]) if job_row["steps_json"] else []
    return JobData(
        job_id=job_row["job_id"],
        law_type=job_row["law_type"],
        storage_root=job_row["storage_root"],
        run_mode=job_row["run_mode"],
        steps=steps,
        start_page=job_row["start_page"],
        end_page=job_row["end_page"],
        treaty_start_page=job_row["treaty_start_page"],
        download_pdf=bool(job_row["download_pdf"]),
        status=job_row["status"],
        created_at=job_row["created_at"],
        started_at=job_row["started_at"],
        finished_at=job_row["finished_at"],
        duration_seconds=job_row["duration_seconds"],
        error=job_row["error"],
        logs=logs,
        step_progress=step_progress,
    )


def _list_jobs_from_db(limit: int, offset: int) -> JobListResponse:
    with _db_conn() as conn:
        total = int(conn.execute("SELECT COUNT(1) AS c FROM kb_jobs").fetchone()["c"])
        rows = conn.execute(
            "SELECT job_id FROM kb_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    items: List[JobData] = []
    for row in rows:
        job = _load_job_from_db(row["job_id"])
        if job:
            items.append(job)
    return JobListResponse(total=total, items=items)


_init_db()


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _step_label(law_type: LawType, step: StepId) -> str:
    if law_type in TREATY_TYPES:
        treaty_labels = {
            "env_check": "环境与目录检查",
            "law_index_update": "法规索引更新",
            "treaty_index_update": "条约索引更新",
            "treaty_download": "条约附件下载",
            "kb_export": "清洗与知识库导出",
            "kb_upload": "上传阿里云知识库",
            "result_summary": "结果汇总",
        }
        return treaty_labels[step]
    return STEP_LABELS[step]


def _build_step_progress(law_type: LawType, selected_steps: List[StepId]) -> List[StepProgress]:
    selected = set(selected_steps)
    result: List[StepProgress] = []
    for step in ALL_STEPS:
        result.append(
            StepProgress(
                step=step,
                label=_step_label(law_type, step),
                status="pending" if step in selected else "skipped",
            )
        )
    return result


def _set_step_status(job: JobData, step: StepId, status: StepStatus) -> None:
    for item in job.step_progress:
        if item.step == step:
            if status == "running":
                item.started_at = _now_str()
                item.finished_at = None
                item.duration_seconds = None
            elif status in {"success", "failed", "skipped"}:
                item.finished_at = _now_str()
                if item.started_at:
                    started = datetime.strptime(item.started_at, "%Y-%m-%d %H:%M:%S")
                    item.duration_seconds = max((datetime.now() - started).total_seconds(), 0.0)
            item.status = status
            _save_steps(job)
            return


def _append_log(job: JobData, message: str) -> None:
    normalized = message.strip()
    if "浏览索引为空，无需建立下载索引" in normalized:
        normalized = "无更新内容：本次未发现新增/更新规范，无需建立下载索引。"
    elif "下载索引为空，无需下载" in normalized:
        normalized = "无更新内容：下载索引无可下载条目，本次无需执行库下载。"
    ts = _now_str()
    job.logs.append(f"[{ts}] {normalized}")
    _insert_log(job.job_id, ts, normalized)


def _decode_output_line(raw: bytes) -> str:
    text = raw.rstrip(b"\r\n")
    preferred = locale.getpreferredencoding(False) or "utf-8"
    for encoding in (preferred, "utf-8", "gbk", "cp936"):
        try:
            return text.decode(encoding)
        except UnicodeDecodeError:
            continue
    return text.decode("utf-8", errors="replace")


def _script_path() -> Path:
    base = Path(__file__).resolve().parents[1]
    return base / "law_spider" / "法规爬虫1-建立法规索引、浏览索引.py"


def _script2_path() -> Path:
    base = Path(__file__).resolve().parents[1]
    return base / "law_spider" / "法规爬虫2-建立下载索引.py"


def _script3_path() -> Path:
    base = Path(__file__).resolve().parents[1]
    return base / "law_spider" / "法规爬虫3-库下载.py"

def _script4_path() -> Path:
    base = Path(__file__).resolve().parents[1]
    return base / "law_spider" / "法规爬虫4-清洗与知识库导出.py"


def _script5_path() -> Path:
    base = Path(__file__).resolve().parents[1]
    return base / "law_spider" / "法规爬虫5-上传阿里云知识库.py"


def _build_interactive_input(job: JobData, step: StepId) -> str:
    if step in {"treaty_index_update", "treaty_download", "kb_export"} and job.law_type in LAW_TYPES:
        # Script 2/3 both request: law_type + path. Script 3 may optionally ask
        # an extra resume prompt when existing files are detected, so append blank line.
        return "\n".join([job.law_type, job.storage_root, ""]) + "\n"
    if step == "kb_upload" and job.law_type in LAW_TYPES:
        # Script 5 may read additional interactive params if .env lacks fields.
        # Provide blanks so it can continue with defaults/env values.
        return "\n".join([job.law_type, job.storage_root, "", "", "", "", "", ""]) + "\n"
    lines = [job.law_type, job.storage_root]
    if job.law_type in LAW_TYPES:
        lines.append(str(job.start_page))
        lines.append(str(job.end_page))
    else:
        lines.append(str(job.treaty_start_page))
        lines.append("1" if job.download_pdf else "")
    return "\n".join(lines) + "\n"


async def _run_interactive_script(job: JobData, script: Path, step: StepId) -> None:
    if not script.exists():
        raise RuntimeError(f"未找到脚本: {script}")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-u",
        str(script),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.PIPE,
        cwd=str(script.parent),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    PROCESS_STORE[job.job_id] = process

    user_input = _build_interactive_input(job, step).encode("utf-8")
    assert process.stdin is not None
    process.stdin.write(user_input)
    await process.stdin.drain()
    process.stdin.close()

    assert process.stdout is not None
    while True:
        line = await process.stdout.readline()
        if not line:
            break
        text = _decode_output_line(line).strip()
        if text:
            _append_log(job, text)

    code = await process.wait()
    PROCESS_STORE.pop(job.job_id, None)
    if code != 0:
        raise RuntimeError(f"{script.name} 退出码为 {code}")


async def _run_job(job_id: str) -> None:
    async with STORE_LOCK:
        job = JOB_STORE[job_id]
        job.status = "RUNNING"
        job.started_at = _now_str()
        _append_log(job, "任务开始执行。")
        _set_step_status(job, "env_check", "running")
        _save_job(job)

    try:
        out_dir = Path(job.storage_root)
        out_dir.mkdir(parents=True, exist_ok=True)
        _set_step_status(job, "env_check", "success")
        _append_log(job, "环境检查通过。")
        _save_job(job)
        if "law_index_update" in job.steps:
            _set_step_status(job, "law_index_update", "running")
            await _run_interactive_script(job, _script_path(), "law_index_update")
            _set_step_status(job, "law_index_update", "success")
            _save_job(job)

        if job.law_type in LAW_TYPES:
            if "treaty_index_update" in job.steps:
                _set_step_status(job, "treaty_index_update", "running")
                await _run_interactive_script(job, _script2_path(), "treaty_index_update")
                _set_step_status(job, "treaty_index_update", "success")
                _save_job(job)
            if "treaty_download" in job.steps:
                _set_step_status(job, "treaty_download", "running")
                await _run_interactive_script(job, _script3_path(), "treaty_download")
                _set_step_status(job, "treaty_download", "success")
                _save_job(job)
            if "kb_export" in job.steps:
                _set_step_status(job, "kb_export", "running")
                await _run_interactive_script(job, _script4_path(), "kb_export")
                _set_step_status(job, "kb_export", "success")
                _save_job(job)
            if "kb_upload" in job.steps:
                _set_step_status(job, "kb_upload", "running")
                await _run_interactive_script(job, _script5_path(), "kb_upload")
                _set_step_status(job, "kb_upload", "success")
                _save_job(job)
        else:
            if "treaty_index_update" in job.steps:
                _set_step_status(job, "treaty_index_update", "running")
                await _run_interactive_script(job, _script_path(), "treaty_index_update")
                _set_step_status(job, "treaty_index_update", "success")
                _save_job(job)
            if "treaty_download" in job.steps and job.download_pdf:
                _set_step_status(job, "treaty_download", "success")
                _save_job(job)
            if "kb_export" in job.steps:
                _set_step_status(job, "kb_export", "skipped")
                _save_job(job)
            if "kb_upload" in job.steps:
                _set_step_status(job, "kb_upload", "skipped")
                _save_job(job)
        _set_step_status(job, "result_summary", "running")
        _append_log(job, "执行完成，开始汇总结果。")
        _set_step_status(job, "result_summary", "success")
        job.status = "SUCCESS"
        _save_job(job)
    except Exception as exc:
        async with STORE_LOCK:
            job = JOB_STORE[job_id]
            job.status = "FAILED"
            job.error = str(exc)
            _append_log(job, f"任务失败：{exc}")
            for step in job.step_progress:
                if step.status == "running":
                    step.status = "failed"
            _save_job_state(job)
    finally:
        async with STORE_LOCK:
            job = JOB_STORE[job_id]
            if job.started_at:
                started = datetime.strptime(job.started_at, "%Y-%m-%d %H:%M:%S")
                job.duration_seconds = max((datetime.now() - started).total_seconds(), 0.0)
            job.finished_at = _now_str()
            _save_job(job)
            TASK_STORE.pop(job_id, None)


@router.post("/jobs", response_model=CreateJobResponse)
async def create_job(
    req: CreateJobRequest,
    _admin: Annotated[AuthUserRecord, Depends(require_admin)],
) -> CreateJobResponse:
    if req.law_type in LAW_TYPES:
        full_scan = req.start_page == 0 and req.end_page == 0
        if not full_scan and (req.start_page < 1 or req.end_page < req.start_page):
            raise HTTPException(status_code=400, detail="法规分页参数不合法")
    if req.law_type in TREATY_TYPES and req.treaty_start_page < 1:
        raise HTTPException(status_code=400, detail="条约起始页必须 >= 1")

    selected_steps = req.steps or ALL_STEPS.copy()
    job_id = f"job-{datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6]}"
    job = JobData(
        job_id=job_id,
        law_type=req.law_type,
        storage_root=req.storage_root,
        run_mode=req.run_mode,
        steps=selected_steps,
        start_page=req.start_page,
        end_page=req.end_page,
        treaty_start_page=req.treaty_start_page,
        download_pdf=req.download_pdf,
        status="PENDING",
        created_at=_now_str(),
        step_progress=_build_step_progress(req.law_type, selected_steps),
    )
    _append_log(job, "任务已创建，等待启动。")
    async with STORE_LOCK:
        JOB_STORE[job_id] = job
        _save_job_state(job)
    return CreateJobResponse(job_id=job_id, status=job.status)


@router.post("/jobs/{job_id}/start", response_model=StartJobResponse)
async def start_job(
    job_id: str,
    _admin: Annotated[AuthUserRecord, Depends(require_admin)],
) -> StartJobResponse:
    async with STORE_LOCK:
        job = JOB_STORE.get(job_id)
        if not job:
            loaded = _load_job_from_db(job_id)
            if loaded:
                JOB_STORE[job_id] = loaded
                job = loaded
        if not job:
            raise HTTPException(status_code=404, detail="任务不存在")
        if job.status == "RUNNING":
            return StartJobResponse(job_id=job_id, status=job.status)
        if job.status in {"SUCCESS", "FAILED", "CANCELLED"}:
            raise HTTPException(status_code=400, detail="当前状态不可启动")
        task = asyncio.create_task(_run_job(job_id))
        TASK_STORE[job_id] = task
    return StartJobResponse(job_id=job_id, status="RUNNING")


@router.post("/jobs/{job_id}/stop", response_model=StopJobResponse)
async def stop_job(
    job_id: str,
    _admin: Annotated[AuthUserRecord, Depends(require_admin)],
) -> StopJobResponse:
    task: Optional[asyncio.Task] = None
    async with STORE_LOCK:
        job = JOB_STORE.get(job_id)
        if not job:
            loaded = _load_job_from_db(job_id)
            if loaded:
                JOB_STORE[job_id] = loaded
                job = loaded
        if not job:
            raise HTTPException(status_code=404, detail="任务不存在")
        process = PROCESS_STORE.get(job_id)
        if process and process.returncode is None:
            process.kill()
        task = TASK_STORE.get(job_id)
        if task and not task.done():
            task.cancel()

    # Never await cancelled task while holding STORE_LOCK, otherwise _run_job.finally
    # cannot reacquire the lock to flush final state/logs.
    if task and not task.done():
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async with STORE_LOCK:
        job = JOB_STORE.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="任务不存在")
        job.status = "CANCELLED"
        job.finished_at = _now_str()
        _append_log(job, "任务已取消。")
        for step in job.step_progress:
            if step.status == "running":
                step.status = "failed"
        _save_job_state(job)
    return StopJobResponse(job_id=job_id, status="CANCELLED")


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(
    _admin: Annotated[AuthUserRecord, Depends(require_admin)],
    limit: int = 20,
    offset: int = 0,
) -> JobListResponse:
    safe_limit = max(1, min(limit, 200))
    safe_offset = max(0, offset)
    return _list_jobs_from_db(limit=safe_limit, offset=safe_offset)


@router.get("/jobs/{job_id}/validate-report-summary", response_model=KBValidateReportSummaryResponse)
async def get_validate_report_summary(
    job_id: str,
    _admin: Annotated[AuthUserRecord, Depends(require_admin)],
) -> KBValidateReportSummaryResponse:
    async with STORE_LOCK:
        job = JOB_STORE.get(job_id)
    if not job:
        job = _load_job_from_db(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="任务不存在")
        async with STORE_LOCK:
            JOB_STORE[job_id] = job

    applicable, path_obj, path_str = _validate_report_path_for_job(job)
    if not applicable:
        return KBValidateReportSummaryResponse(
            exists=False,
            applicable=False,
            report_path="",
        )

    if not path_obj.is_file():
        return KBValidateReportSummaryResponse(
            exists=False,
            applicable=True,
            report_path=path_str,
        )

    try:
        raw = path_obj.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as exc:
        return KBValidateReportSummaryResponse(
            exists=True,
            applicable=True,
            report_path=path_str,
            parse_error=str(exc),
        )

    if not isinstance(data, dict):
        return KBValidateReportSummaryResponse(
            exists=True,
            applicable=True,
            report_path=path_str,
            parse_error="validate_report.json 根类型不是对象",
        )

    def _int(key: str) -> Optional[int]:
        v = data.get(key)
        if v is None:
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    def _bool(key: str) -> Optional[bool]:
        v = data.get(key)
        if isinstance(v, bool):
            return v
        return None

    return KBValidateReportSummaryResponse(
        exists=True,
        applicable=True,
        report_path=path_str,
        total_chunks=_int("total_chunks"),
        error_count=_int("error_count"),
        warning_count=_int("warning_count"),
        allow_upload=_bool("allow_upload"),
    )


@router.get("/jobs/{job_id}", response_model=JobSnapshotResponse)
async def get_job(
    job_id: str,
    _admin: Annotated[AuthUserRecord, Depends(require_admin)],
) -> JobSnapshotResponse:
    async with STORE_LOCK:
        job = JOB_STORE.get(job_id)
    if not job:
        job = _load_job_from_db(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="任务不存在")
        async with STORE_LOCK:
            JOB_STORE[job_id] = job
    return JobSnapshotResponse(job=job)


__all__ = ["router"]
