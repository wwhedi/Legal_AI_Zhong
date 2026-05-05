"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TREATY_TYPES, isLawType, lawTypeLabel, type LawType } from "../../_lib/config";
import { createKBUpdateJob } from "@/services/api";
import type { KBStepId } from "@/types";
import { kbCard, kbCardPadding, kbInput, kbPrimaryBtn, kbSecondaryBtn, kbSection } from "../../_lib/ui";

export function JobConfigClient(props: {
  lawTypeParam: string | null;
  storageRoot: string;
  steps: string;
  runMode: string;
}) {
  const router = useRouter();
  const { lawTypeParam, storageRoot, steps, runMode } = props;

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
  }, [lawType, storageRoot, isTreaty, startPage, endPage, treatyStartPage, needsPageRange]);

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
    <section className={kbSection("max-w-4xl")}>
      <header>
        <h1 className="text-2xl font-semibold text-[var(--app-text)]">参数配置</h1>
        <p className="mt-2 text-sm text-[var(--app-text-muted)]">
          已选步骤：{selectedActionLabels.join(" / ")}。确认参数后开始执行。
        </p>
      </header>

      {validationMsg ? (
        <p className="rounded-xl border border-[var(--app-border)] bg-[var(--app-danger-soft)] p-4 text-sm text-[var(--app-danger)]">
          {validationMsg}
        </p>
      ) : null}

      <div className={`${kbCard} ${kbCardPadding}`}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {!isTreaty && needsPageRange ? (
            <>
              <label className="space-y-1 text-sm">
                <div className="font-medium text-[var(--app-text)]">起始页（0 表示全库）</div>
                <input value={startPage} onChange={(e) => setStartPage(e.target.value)} className={`${kbInput} h-9`} />
              </label>
              <label className="space-y-1 text-sm">
                <div className="font-medium text-[var(--app-text)]">末页（0 表示全库）</div>
                <input value={endPage} onChange={(e) => setEndPage(e.target.value)} className={`${kbInput} h-9`} />
              </label>
            </>
          ) : null}

          {isTreaty ? (
            <label className="space-y-1 text-sm">
              <div className="font-medium text-[var(--app-text)]">条约起始页</div>
              <input
                value={treatyStartPage}
                onChange={(e) => setTreatyStartPage(e.target.value)}
                className={`${kbInput} h-9`}
              />
            </label>
          ) : null}

          <label className="flex items-center gap-2 text-sm text-[var(--app-text)] md:col-span-2">
            <input
              type="checkbox"
              checked={downloadPdf}
              onChange={(e) => setDownloadPdf(e.target.checked)}
            />
            下载 PDF（如步骤包含下载）
          </label>
        </div>

        {cleaningPaths ? (
          <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)]/70 p-3 text-xs text-[var(--app-text-muted)]">
            <div className="font-medium text-[var(--app-text)]">清洗产物路径（参考）</div>
            <div className="mt-1 font-mono whitespace-pre-wrap">
              {`uploadDir: ${cleaningPaths.uploadDir}\nmasterPath: ${cleaningPaths.masterPath}\nreportPath: ${cleaningPaths.reportPath}`}
            </div>
          </div>
        ) : null}

        {submitError ? (
          <p className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-danger-soft)] p-3 text-sm text-[var(--app-danger)]">
            {submitError}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button type="button" onClick={handleBack} className={kbSecondaryBtn}>
            返回
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={Boolean(validationMsg) || submitting}
            className={kbPrimaryBtn}
          >
            {submitting ? "创建中…" : "创建任务并执行"}
          </button>
        </div>
      </div>
    </section>
  );
}
