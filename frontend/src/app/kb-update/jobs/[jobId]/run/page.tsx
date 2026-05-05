/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getKBUpdateJob, startKBUpdateJob, stopKBUpdateJob } from "@/services/api";
import type { KBJobData } from "@/types";
import { kbCard, kbPrimaryBtn, kbSecondaryBtn, kbSection, kbStepDotClass, kbStepStatusBadgeClass } from "../../../_lib/ui";

function stepStatusLabel(status: string): string {
  if (status === "pending") return "待执行";
  if (status === "running") return "执行中";
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  if (status === "skipped") return "已跳过";
  return status;
}

function isLawType(type?: string): boolean {
  return ["xf", "flfg", "xzfg", "jcfg", "sfjs", "dfxfg"].includes(type ?? "");
}

function isTreatyType(type?: string): boolean {
  return ["tiaoyue", "shuangbian", "duobian"].includes(type ?? "");
}

export default function JobRunPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params?.jobId ?? "";
  const [job, setJob] = useState<KBJobData | null>(null);
  const [error, setError] = useState("");

  async function fetchJob() {
    try {
      const resp = await getKBUpdateJob(jobId);
      setJob(resp.job);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取任务失败");
    }
  }

  useEffect(() => {
    if (!jobId) return;
    let timer: number | undefined;
    async function boot() {
      await fetchJob();
      try {
        await startKBUpdateJob(jobId);
      } catch {
        // ignore if already started
      }
      await fetchJob();
      timer = window.setInterval(fetchJob, 1500);
    }
    boot();
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [jobId]);

  const currentStep = useMemo(() => {
    if (!job) return "待启动";
    const running = job.step_progress.find((s) => s.status === "running");
    if (running) return running.label;
    if (job.status === "SUCCESS") return "已完成";
    if (job.status === "FAILED") return "执行失败";
    if (job.status === "CANCELLED") return "已取消";
    return "待启动";
  }, [job]);

  const visibleSteps = useMemo(() => {
    if (!job) return [];
    if (isTreatyType(job.law_type)) {
      return job.step_progress.filter((s) => s.step !== "law_index_update");
    }
    return job.step_progress;
  }, [job]);

  const renderedSteps = useMemo(() => {
    if (!job) return [];
    return visibleSteps.map((step) => {
      if (isLawType(job.law_type) && step.step === "treaty_index_update") {
        return { ...step, label: "建立下载索引" };
      }
      if (isLawType(job.law_type) && step.step === "treaty_download") {
        return { ...step, label: "库下载" };
      }
      if (isLawType(job.law_type) && step.step === "kb_export") {
        return { ...step, label: "清洗与知识库导出" };
      }
      if (isLawType(job.law_type) && step.step === "kb_upload") {
        return { ...step, label: "上传阿里云知识库" };
      }
      return step;
    });
  }, [job, visibleSteps]);

  async function handleStop() {
    if (!jobId) return;
    await stopKBUpdateJob(jobId);
    await fetchJob();
  }

  return (
    <section className={kbSection("max-w-6xl")}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--app-text)]">执行监控</h1>
          <p className="mt-1 text-sm text-[var(--app-text-muted)]">
            任务 ID：{jobId} · 状态：{job?.status ?? "PENDING"} · 当前步骤：{currentStep}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {job?.status === "RUNNING" ? (
            <button
              type="button"
              onClick={handleStop}
              className="rounded-xl border border-[var(--app-danger)]/35 bg-[var(--app-danger-soft)] px-3 py-1.5 text-sm font-medium text-[var(--app-danger)] hover:opacity-90"
            >
              停止任务
            </button>
          ) : (
            <Link href="/kb-update" className={kbSecondaryBtn}>
              返回主页
            </Link>
          )}
          <Link href={`/kb-update/jobs/${jobId}/result`} className={`${kbPrimaryBtn} px-3 py-1.5 text-sm`}>
            查看结果页
          </Link>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <article className={`${kbCard} p-5`}>
          <h2 className="text-base font-semibold text-[var(--app-text)]">步骤状态</h2>
          <div className="mt-4 space-y-3">
            {renderedSteps.map((step) => (
              <div key={step.step} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)]/35 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[var(--app-text)]">{step.label}</p>
                  <span
                    className={`inline-block size-3 rounded-full ${kbStepDotClass(step.status)}`}
                    title={stepStatusLabel(step.status)}
                  />
                </div>
                <div className="mt-2">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${kbStepStatusBadgeClass(step.status)}`}>
                    {stepStatusLabel(step.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={`${kbCard} p-5 lg:col-span-2`}>
          <h2 className="text-base font-semibold text-[var(--app-text)]">实时日志</h2>
          <div className="mt-3 h-[300px] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)]/80 p-3 shadow-inner">
            {error ? <p className="text-xs text-[var(--app-danger)]">{error}</p> : null}
            {(job?.logs ?? []).map((line, idx) => (
              <p key={`${idx}-${line}`} className="font-mono text-[11px] leading-6 text-[var(--app-text-muted)]">
                {line}
              </p>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
