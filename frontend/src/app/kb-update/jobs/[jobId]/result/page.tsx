"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getKBUpdateJob } from "@/services/api";
import type { KBJobData } from "@/types";
import { lawTypeLabel } from "../../../_lib/config";
import {
  kbCard,
  kbJobStatusBadgeClass,
  kbPrimaryBtn,
  kbSecondaryBtn,
  kbSection,
} from "../../../_lib/ui";

function statusText(status?: string): string {
  if (status === "SUCCESS") return "执行成功";
  if (status === "FAILED") return "执行失败";
  if (status === "RUNNING") return "执行中";
  if (status === "CANCELLED") return "已取消";
  if (status === "PENDING") return "待启动";
  return "未知状态";
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(seconds)) return "-";
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}分${secs}秒`;
}

function buildTaskName(job: KBJobData): string {
  const typeLabel = lawTypeLabel(job.law_type);
  const steps = new Set(job.steps);
  const hasAll =
    steps.has("law_index_update") &&
    steps.has("treaty_index_update") &&
    steps.has("treaty_download") &&
    steps.has("kb_export") &&
    steps.has("kb_upload");
  if (hasAll) return `${typeLabel}全流程更新任务`;

  const parts: string[] = [];
  if (steps.has("law_index_update")) parts.push("法规索引");
  if (steps.has("treaty_index_update")) parts.push("下载索引");
  if (steps.has("treaty_download")) parts.push("库下载");
  if (steps.has("kb_export")) parts.push("清洗数据");
  if (steps.has("kb_upload")) parts.push("上传知识库");
  if (parts.length === 0) return `${typeLabel}任务`;
  return `${typeLabel}${parts.join("+")}任务`;
}

function buildOutputItems(job: KBJobData, isFailed: boolean): Array<{ label: string; path: string }> {
  const base = job.storage_root;
  const typeLabel = lawTypeLabel(job.law_type);
  const steps = new Set(job.steps);
  const items: Array<{ label: string; path: string }> = [];

  if (steps.has("law_index_update")) {
    items.push({ label: "法规索引", path: `${base}/法规爬虫/${typeLabel}/法规索引` });
    items.push({ label: "中间文档", path: `${base}/法规爬虫/${typeLabel}/中间文档` });
  }
  if (steps.has("treaty_index_update")) {
    items.push({ label: "下载索引", path: `${base}/法规爬虫/${typeLabel}/中间文档/*-下载索引.txt` });
  }
  if (steps.has("treaty_download")) {
    items.push({ label: "本地法规库", path: `${base}/法规爬虫/${typeLabel}/${typeLabel}库` });
  }
  if (steps.has("kb_export")) {
    items.push({ label: "清洗产物目录", path: `${base}/法规爬虫/${typeLabel}/清洗产物` });
    items.push({
      label: "知识库上传文件目录",
      path: `${base}/法规爬虫/${typeLabel}/清洗产物/aliyun_upload/${typeLabel}`,
    });
    items.push({ label: "主数据表", path: `${base}/法规爬虫/${typeLabel}/清洗产物/law_master.jsonl` });
    items.push({ label: "清洗报告", path: `${base}/法规爬虫/${typeLabel}/清洗产物/clean_report.txt` });
  }
  if (steps.has("kb_upload")) {
    items.push({ label: "上传执行脚本", path: `${base}/法规爬虫5-上传阿里云知识库.py` });
  }

  items.push({ label: isFailed ? "错误日志" : "运行日志（排查用）", path: "law_spider/error.log" });
  return items;
}

export default function JobResultPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params?.jobId ?? "";
  const [job, setJob] = useState<KBJobData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!jobId) return;
    async function load() {
      try {
        const resp = await getKBUpdateJob(jobId);
        setJob(resp.job);
      } catch (err) {
        setError(err instanceof Error ? err.message : "获取结果失败");
      }
    }
    load();
  }, [jobId]);

  const pageCount = useMemo(() => {
    if (!job) return "-";
    if (job.law_type === "tiaoyue" || job.law_type === "shuangbian" || job.law_type === "duobian") {
      return `起始页 ${job.treaty_start_page}`;
    }
    if (job.start_page === 0 && job.end_page === 0) return "全库";
    return `${job.start_page}-${job.end_page}`;
  }, [job]);

  const isFailed = job?.status === "FAILED" || job?.status === "CANCELLED";
  const totalDurationText = useMemo(() => {
    if (!job) return "-";
    if (job.duration_seconds != null) return formatDuration(job.duration_seconds);
    const total = (job.step_progress ?? []).reduce((acc, item) => acc + (item.duration_seconds ?? 0), 0);
    return formatDuration(total);
  }, [job]);
  const outputItems = useMemo(() => (job ? buildOutputItems(job, isFailed) : []), [job, isFailed]);
  const taskTitle = useMemo(() => (job ? buildTaskName(job) : "结果详情"), [job]);

  const statusClass = kbJobStatusBadgeClass(job?.status ?? "");

  return (
    <section className={kbSection("max-w-5xl")}>
      <header>
        <h1 className="text-2xl font-semibold text-[var(--app-text)]">{taskTitle}</h1>
        <p className="mt-1 text-sm text-[var(--app-text-muted)]">任务 ID：{jobId}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className={`${kbCard} p-4`}>
          <p className="text-xs text-[var(--app-text-muted)]">执行状态</p>
          <div className="mt-2">
            <span
              className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-black/[0.04] ${statusClass}`}
            >
              {statusText(job?.status)}
            </span>
          </div>
        </div>
        <div className={`${kbCard} p-4`}>
          <p className="text-xs text-[var(--app-text-muted)]">页码范围</p>
          <p className="mt-1 text-lg font-semibold text-[var(--app-text)]">{pageCount}</p>
        </div>
        <div className={`${kbCard} p-4`}>
          <p className="text-xs text-[var(--app-text-muted)]">日志条数</p>
          <p className="mt-1 text-lg font-semibold text-[var(--app-text)]">{job?.logs?.length ?? 0}</p>
        </div>
      </div>

      <article className={`${kbCard} p-6`}>
        <h2 className="text-base font-semibold text-[var(--app-text)]">输出文件与目录</h2>
        <ul className="mt-3 space-y-2 text-sm text-[var(--app-text-muted)]">
          {outputItems.map((item) => (
            <li key={`${item.label}-${item.path}`}>
              <span className="text-[var(--app-text)]">{item.label}</span>：
              <code className="break-all text-[13px] text-[var(--app-text-muted)]">{item.path}</code>
            </li>
          ))}
        </ul>
        {job?.error ? <p className="mt-3 text-sm text-[var(--app-danger)]">失败原因：{job.error}</p> : null}
        {error ? <p className="mt-3 text-sm text-[var(--app-danger)]">{error}</p> : null}
      </article>

      <article className={`${kbCard} p-6`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--app-text)]">步骤耗时明细</h2>
          <span className="rounded-full bg-[var(--app-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--app-primary)] ring-1 ring-[var(--app-primary-soft)]">
            总用时：{totalDurationText}
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {(job?.step_progress ?? []).map((step) => (
            <div
              key={step.step}
              className="flex items-center justify-between rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)]/40 px-3 py-2 text-sm"
            >
              <span className="text-[var(--app-text)]">{step.label}</span>
              <span className="font-medium tabular-nums text-[var(--app-text)]">{formatDuration(step.duration_seconds)}</span>
            </div>
          ))}
        </div>
      </article>

      {isFailed ? (
        <article
          className={`${kbCard} border-amber-200/90 bg-[var(--app-warning-soft)]/90 p-6`}
        >
          <h2 className="text-base font-semibold text-[var(--app-text)]">异常处理建议</h2>
          <ul className="mt-3 space-y-2 text-sm text-[var(--app-text-muted)]">
            <li>若第 1 页即失败，优先检查网络环境或更换出口 IP 后重试。</li>
            <li>分页更新建议每次不超过 100 页，降低反爬限制风险。</li>
            <li>可使用“仅重试失败步骤”减少重复耗时。</li>
          </ul>
        </article>
      ) : (
        <article
          className={`${kbCard} border-emerald-200/90 bg-[var(--app-success-soft)]/90 p-6`}
        >
          <h2 className="text-base font-semibold text-[var(--app-text)]">执行结果说明</h2>
          <ul className="mt-3 space-y-2 text-sm text-[var(--app-text-muted)]">
            <li>当前任务已成功完成，无需处理异常。</li>
            <li>如需复核执行细节，可在监控页查看完整实时日志。</li>
            <li>若后续新增规则或范围变更，可直接复用当前配置重建任务。</li>
          </ul>
        </article>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        <Link href="/kb-update" className={kbSecondaryBtn}>
          返回主页
        </Link>
        <Link href={`/kb-update/jobs/${jobId}/run`} className={kbSecondaryBtn}>
          返回监控页
        </Link>
        <Link href="/kb-update/new" className={kbPrimaryBtn}>
          使用相似配置重建任务
        </Link>
      </div>
    </section>
  );
}
