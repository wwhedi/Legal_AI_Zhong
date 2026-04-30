"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listKBUpdateJobs } from "@/services/api";
import type { KBJobData } from "@/types";
import { lawTypeLabel } from "../_lib/config";

function statusBadgeClass(status: string): string {
  if (status === "SUCCESS") return "bg-emerald-100 text-emerald-700";
  if (status === "FAILED") return "bg-rose-100 text-rose-700";
  if (status === "RUNNING") return "bg-blue-100 text-blue-700";
  if (status === "CANCELLED") return "bg-slate-200 text-slate-700";
  return "bg-amber-100 text-amber-700";
}

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
  // Prefer compact Chinese naming (no extra spaces)
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
    <section className="mx-auto w-full max-w-6xl space-y-6 p-6 md:p-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">历史任务</h1>
          <p className="mt-1 text-sm text-slate-600">查看执行记录并复用历史配置。</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/kb-update"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            返回
          </Link>
          <Link href="/kb-update/new" className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white">
            新建任务
          </Link>
        </div>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-5 gap-2 border-b border-slate-200 px-4 py-3 text-xs font-medium text-slate-500">
          <span>任务名称</span>
          <span>类型</span>
          <span>状态</span>
          <span>创建时间</span>
          <span>操作</span>
        </div>
        {jobs.map((job) => (
          <div
            key={job.job_id}
            className="grid grid-cols-5 gap-2 px-4 py-3 text-sm text-slate-700 odd:bg-slate-50"
          >
            <span>{buildTaskName(job)}</span>
            <span>{lawTypeLabel(job.law_type)}</span>
            <span>
              <i className={`rounded-full px-2 py-1 text-xs not-italic ${statusBadgeClass(job.status)}`}>
                {statusText(job.status)}
              </i>
            </span>
            <span>{job.created_at}</span>
            <span className="flex gap-2">
              <Link href={`/kb-update/jobs/${job.job_id}/result`} className="text-blue-700 hover:underline">
                查看
              </Link>
              <Link href="/kb-update/new" className="text-slate-700 hover:underline">
                复制配置
              </Link>
            </span>
          </div>
        ))}
        {jobs.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">暂无历史任务。</div>
        ) : null}
        {error ? <div className="px-4 py-4 text-sm text-rose-700">{error}</div> : null}
      </div>
    </section>
  );
}
