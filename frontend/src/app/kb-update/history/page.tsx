"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listKBUpdateJobs } from "@/services/api";
import type { KBJobData } from "@/types";
import { lawTypeLabel } from "../_lib/config";
import { kbCard, kbJobStatusBadgeClass, kbPrimaryBtn, kbSecondaryBtn, kbSection } from "../_lib/ui";

function statusText(status: string): string {
  if (status === "SUCCESS") return "执行成功";
  if (status === "FAILED") return "执行失败";
  if (status === "RUNNING") return "执行中";
  if (status === "CANCELLED") return "已取消";
  return "待启动";
}

function buildTaskName(job: KBJobData): string {
  const typeLabel = lawTypeLabel(job.law_type);
  const steps = new Set(job.steps);
  const hasAll =
    steps.has("law_index_update") &&
    steps.has("treaty_index_update") &&
    steps.has("treaty_download") &&
    steps.has("kb_export");
  if (hasAll) return `${typeLabel} 全流程更新任务`;

  const parts: string[] = [];
  if (steps.has("law_index_update")) parts.push("法规索引");
  if (steps.has("treaty_index_update")) parts.push("下载索引");
  if (steps.has("treaty_download")) parts.push("库下载");
  if (steps.has("kb_export")) parts.push("清洗数据");
  if (parts.length === 0) return `${typeLabel} 任务`;
  return `${typeLabel}${parts.join("+")}任务`;
}

export default function JobHistoryPage() {
  const [jobs, setJobs] = useState<KBJobData[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const resp = await listKBUpdateJobs();
        setJobs(resp.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载历史任务失败");
      }
    }
    load();
  }, []);

  return (
    <section className={kbSection("max-w-6xl")}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--app-text)]">历史任务</h1>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">查看执行记录并复用历史配置。</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/kb-update" className={kbSecondaryBtn}>
            返回
          </Link>
          <Link href="/kb-update/new" className={kbPrimaryBtn}>
            新建任务
          </Link>
        </div>
      </header>

      <div className={`${kbCard} overflow-hidden`}>
        <div className="grid grid-cols-5 gap-2 border-b border-[var(--app-border)] bg-[var(--app-surface-muted)]/50 px-4 py-3 text-xs font-medium text-[var(--app-text-muted)]">
          <span>任务名称</span>
          <span>类型</span>
          <span>状态</span>
          <span>创建时间</span>
          <span>操作</span>
        </div>
        {jobs.map((job) => (
          <div
            key={job.job_id}
            className="grid grid-cols-5 gap-2 border-b border-[var(--app-border)]/80 px-4 py-3 text-sm text-[var(--app-text)] odd:bg-[var(--app-surface-muted)]/35 last:border-b-0"
          >
            <span className="min-w-0 break-words">{buildTaskName(job)}</span>
            <span>{lawTypeLabel(job.law_type)}</span>
            <span>
              <i className={`rounded-full px-2 py-1 text-xs not-italic ${kbJobStatusBadgeClass(job.status)}`}>
                {statusText(job.status)}
              </i>
            </span>
            <span className="text-[var(--app-text-muted)]">{job.created_at}</span>
            <span className="flex flex-wrap gap-2">
              <Link href={`/kb-update/jobs/${job.job_id}/result`} className="font-medium text-[var(--app-primary)] hover:underline">
                查看
              </Link>
              <Link href="/kb-update/new" className="text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:underline">
                复制配置
              </Link>
            </span>
          </div>
        ))}
        {jobs.length === 0 ? (
          <div className="px-4 py-6 text-sm text-[var(--app-text-muted)]">暂无历史任务。</div>
        ) : null}
        {error ? (
          <div className="border-t border-[var(--app-border)] px-4 py-4 text-sm text-[var(--app-danger)]">{error}</div>
        ) : null}
      </div>
    </section>
  );
}
