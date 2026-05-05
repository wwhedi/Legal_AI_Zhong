import { Suspense } from "react";
import { JobConfigClient } from "./JobConfigClient";

export const dynamic = "force-dynamic";

export default async function JobConfigPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const lawTypeParam = typeof sp.lawType === "string" ? sp.lawType : null;
  const storageRoot = typeof sp.storageRoot === "string" ? sp.storageRoot : "";
  const steps = typeof sp.steps === "string" ? sp.steps : "";
  const runMode = typeof sp.runMode === "string" ? sp.runMode : "step_run";
  return (
    <Suspense
      fallback={
        <section className="mx-auto min-h-full w-full max-w-4xl space-y-6 bg-[var(--app-bg)] p-6 md:p-10">
          <p className="rounded-2xl border border-[var(--app-border)] bg-white p-4 text-sm text-[var(--app-text-muted)] shadow-[var(--app-shadow-sm)]">
            正在加载…
          </p>
        </section>
      }
    >
      <JobConfigClient
        lawTypeParam={lawTypeParam}
        storageRoot={storageRoot}
        steps={steps}
        runMode={runMode}
      />
    </Suspense>
  );
}

/*
import { Suspense } from "react";
import { JobConfigClient } from "./JobConfigClient";

export const dynamic = "force-dynamic";

export default function JobConfigPage() {
  return (
    <Suspense
      fallback={
        <section className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            正在加载…
          </p>
        </section>
      }
    >
      <JobConfigClient />
    </Suspense>
  );
}

/*
import { Suspense } from "react";
import { JobConfigClient } from "./JobConfigClient";

export default function JobConfigPage() {
  return (
    <Suspense
      fallback={
        <section className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            正在加载…
          </p>
        </section>
      }
    >
      <JobConfigClient />
    </Suspense>
  );
}
*/

/*
"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TREATY_TYPES, isLawType, lawTypeLabel, type LawType } from "../../_lib/config";
import { createKBUpdateJob } from "@/services/api";
import type { KBStepId } from "@/types";

export default function JobConfigPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const lawTypeParam = searchParams.get("lawType");
  const storageRoot = searchParams.get("storageRoot") ?? "";
  const steps = searchParams.get("steps") ?? "";
  const runMode = searchParams.get("runMode") ?? "step_run";

  const lawType = isLawType(lawTypeParam) ? (lawTypeParam as LawType) : null;
  const isTreaty = lawType ? TREATY_TYPES.has(lawType) : false;
  const stepList = useMemo(
    () =>
      steps
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0) as KBStepId[],
    [steps],
  );
  const needsPageRange = useMemo(() => stepList.includes("law_index_update"), [stepList]);
  const selectedStepSet = useMemo(() => new Set(stepList), [stepList]);
  const hasKbExport = useMemo(() => selectedStepSet.has("kb_export"), [selectedStepSet]);
  const selectedActionLabels = useMemo(() => {
    const labels: string[] = [];
    if (selectedStepSet.has("treaty_index_update")) labels.push("建立下载索引");
    if (selectedStepSet.has("treaty_download")) labels.push("库下载");
    if (selectedStepSet.has("kb_export")) labels.push("清洗与知识库导出");
    if (labels.length === 0) labels.push("结果汇总");
    return labels;
  }, [selectedStepSet]);
  const cleaningPaths = useMemo(() => {
    if (!lawType || isTreaty || !hasKbExport) return null;
    const typeLabel = lawTypeLabel(lawType);
    const base = storageRoot;
    const lawRoot = `${base}/法规爬虫/${typeLabel}`;
    const outRoot = `${lawRoot}/清洗产物`;
    return {
      typeLabel,
      base,
      outRoot,
      uploadDir: `${outRoot}/aliyun_upload/${typeLabel}`,
      masterPath: `${outRoot}/law_master.jsonl`,
      reportPath: `${outRoot}/clean_report.txt`,
    };
  }, [lawType, isTreaty, storageRoot, hasKbExport]);

  const [startPage, setStartPage] = useState("0");
  const [endPage, setEndPage] = useState("0");
  const [treatyStartPage, setTreatyStartPage] = useState("1");
  const [downloadPdf, setDownloadPdf] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const validationMsg = useMemo(() => {
    if (!lawType || !storageRoot) return "基础参数缺失，请返回上一步。";
    if (isTreaty) {
      const page = Number(treatyStartPage);
      if (!Number.isInteger(page) || page < 1) return "条约起始页必须是大于等于 1 的整数。";
      return "";
    }
    if (!needsPageRange) return "";
    const s = Number(startPage);
    const e = Number(endPage);
    const full = s === 0 && e === 0;
    if (full) return "";
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < 1 || s > e) {
      return "页数设置不正确：末页需大于等于起始页（且起始页、末页都需 ≥ 1），或使用 0/0 表示全库。";
    }
    return "";
  }, [lawType, storageRoot, isTreaty, startPage, endPage, treatyStartPage]);

  async function handleSubmit() {
    if (validationMsg || !lawType) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const created = await createKBUpdateJob({
        law_type: lawType,
        storage_root: storageRoot,
        run_mode: "step_run",
        steps: stepList,
        start_page: needsPageRange ? Number(startPage) : 0,
        end_page: needsPageRange ? Number(endPage) : 0,
        treaty_start_page: Number(treatyStartPage),
        download_pdf: downloadPdf,
      });
      router.push(`/kb-update/jobs/${created.job_id}/run`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "创建任务失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleBack() {
    if (!lawType) {
      router.push("/kb-update/new/steps");
      return;
    }
    const params = new URLSearchParams({
      lawType,
      storageRoot,
      runMode,
      steps,
    });
    router.push(`/kb-update/new/steps?${params.toString()}`);
  }

  return (
    <section className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">参数配置</h1>
        <p className="mt-2 text-sm text-slate-600">
          此页配置将映射脚本交互输入，后端运行时按顺序注入 stdin。
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {!lawType ? (
          <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            缺少规范类型参数，请返回重试。
          </p>
        ) : isTreaty ? (
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-slate-900">条约类参数</h2>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">起始页</span>
              <input
                value={treatyStartPage}
                onChange={(e) => setTreatyStartPage(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={downloadPdf}
                onChange={(e) => setDownloadPdf(e.target.checked)}
              />
              下载条约 PDF（会明显增加执行时长）
            </label>
          </div>
        ) : (
          <div className="space-y-4">
            {needsPageRange ? (
              <>
                <h2 className="text-base font-semibold text-slate-900">请设置获取页数</h2>
                <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900/90">
                  爬取全库则输入0；爬取全库可能受反爬虫机制限制而出错，出错时请从出错页数[即1页]起手动爬取，出错页数为法规索引中末尾规范编号+1，不建议超过100页[即99页]，如超过100页请分多次爬取；当前仅地方性法规超过100页，其他法规可直接爬取全库。
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-700">起始页（e1）</span>
                    <input
                      value={startPage}
                      onChange={(e) => setStartPage(e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-700">末页（e2）</span>
                    <input
                      value={endPage}
                      onChange={(e) => setEndPage(e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setStartPage("0");
                    setEndPage("0");
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700"
                >
                  设为全库更新（0/0）
                </button>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-slate-900">无需设置页数</h2>
                <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-6 text-slate-700">
                  你当前未选择“法规索引更新”，因此不需要设置抓取页数。提交后将直接执行：
                  {selectedActionLabels.join("、")}。
                </p>
                {cleaningPaths ? (
                  <div className="rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    <p className="font-semibold text-slate-900">本次清洗确认信息</p>
                    <ul className="mt-2 space-y-1 leading-6">
                      <li>法规类型：{cleaningPaths.typeLabel}</li>
                      <li>数据根目录：{cleaningPaths.base}</li>
                      <li>清洗产物目录：{cleaningPaths.outRoot}</li>
                      <li>上传文件目录：{cleaningPaths.uploadDir}</li>
                      <li>主数据表：{cleaningPaths.masterPath}</li>
                      <li>清洗报告：{cleaningPaths.reportPath}</li>
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>

      {validationMsg ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {validationMsg}
        </p>
      ) : null}
      {submitError ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {submitError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleBack}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          返回上一步
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!!validationMsg || submitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {submitting ? "提交中..." : "提交并开始执行"}
        </button>
      </div>
    </section>
  );
}
*/
