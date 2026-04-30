"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { listKBUpdateJobs } from "@/services/api";
import type { KBJobData } from "@/types";
import { lawTypeLabel } from "./_lib/config";

function statusText(status: string): string {
  if (status === "SUCCESS") return "执行成功";
  if (status === "FAILED") return "执行失败";
  if (status === "RUNNING") return "执行中";
  if (status === "CANCELLED") return "已取消";
  return "待启动";
}

function statusBadgeClass(status: string): string {
  if (status === "SUCCESS") return "bg-emerald-100 text-emerald-700";
  if (status === "FAILED") return "bg-rose-100 text-rose-700";
  if (status === "RUNNING") return "bg-blue-100 text-blue-700";
  if (status === "CANCELLED") return "bg-slate-200 text-slate-700";
  return "bg-amber-100 text-amber-700";
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null) return "-";
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
    steps.has("kb_export");
  if (hasAll) return `${typeLabel}全流程更新任务`;

  const parts: string[] = [];
  if (steps.has("law_index_update")) parts.push("法规索引");
  if (steps.has("treaty_index_update")) parts.push("下载索引");
  if (steps.has("treaty_download")) parts.push("库下载");
  if (steps.has("kb_export")) parts.push("清洗数据");
  if (parts.length === 0) return `${typeLabel}任务`;
  return `${typeLabel}${parts.join("+")}任务`;
}

export default function KbUpdateHomeClient() {
  const [jobs, setJobs] = useState<KBJobData[]>([]);

  useEffect(() => {
    async function load() {
      const resp = await listKBUpdateJobs().catch(() => null);
      if (resp) setJobs(resp.items.slice(0, 3));
    }
    load();
  }, []);

  const hasJobs = useMemo(() => jobs.length > 0, [jobs]);

  return (
    <section className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
      <header className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">【更新知识库】</h1>
        <p className="mt-2 text-sm text-slate-600">
          面向非技术用户的法规与条约更新入口，支持一键全流程、分步执行、失败重试与历史复用。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/kb-update/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            新建更新任务
          </Link>
          <Link
            href="/kb-update/history"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            查看历史任务
          </Link>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
          <h2 className="text-base font-semibold text-slate-900">最近任务</h2>
          <div className="mt-4 space-y-3">
            {hasJobs ? (
              jobs.map((job) => (
                <div
                  key={job.job_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{buildTaskName(job)}</p>
                    <p className="text-xs text-slate-500">
                      {job.job_id} · {lawTypeLabel(job.law_type)} · {job.created_at}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(job.status)}`}
                    >
                      {statusText(job.status)}
                    </span>
                    <span className="text-xs text-slate-500">{formatDuration(job.duration_seconds)}</span>
                    <Link
                      href={`/kb-update/jobs/${job.job_id}/result`}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      详情
                    </Link>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-500">暂无任务记录。</div>
            )}
          </div>
        </article>

        <aside className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-amber-900">运行提示</h2>
          <ul className="mt-3 space-y-2 text-sm text-amber-900/90">
            <li>建议首次先使用分页更新，小批量验证再全量执行。</li>
            <li>若出现反爬限制，请等待后重试或切换网络环境。</li>
            <li>下载条约 PDF 会显著增加执行时长。</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}
