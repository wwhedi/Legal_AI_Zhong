"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_STEPS, STEP_OPTIONS, isLawType, isRunMode, type StepId } from "../../_lib/config";

const LAW_TYPES = new Set(["xf", "flfg", "xzfg", "jcfg", "sfjs", "dfxfg"]);
const TREATY_TYPES = new Set(["tiaoyue", "shuangbian", "duobian"]);

export function StepSelectionClient(props: {
  lawType: string | null;
  storageRoot: string | null;
  runMode: string | null;
}) {
  const router = useRouter();
  const { lawType, storageRoot, runMode } = props;

  const [selected, setSelected] = useState<StepId[]>(DEFAULT_STEPS);

  const visibleSteps = useMemo(() => {
    if (lawType && TREATY_TYPES.has(lawType)) {
      return STEP_OPTIONS.filter((s) => s.id !== "law_index_update");
    }
    return STEP_OPTIONS;
  }, [lawType]);

  const stepsWithLabels = useMemo(
    () =>
      visibleSteps.map((step) => {
        if (lawType && LAW_TYPES.has(lawType)) {
          if (step.id === "treaty_index_update") {
            return { ...step, label: "建立下载索引", desc: "执行法规爬虫2，生成下载索引。" };
          }
          if (step.id === "treaty_download") {
            return { ...step, label: "库下载", desc: "执行法规爬虫3，按下载索引下载入库。" };
          }
          if (step.id === "kb_export") {
            return { ...step, label: "清洗与知识库导出", desc: "执行法规爬虫4，清洗并导出知识库上传文件。" };
          }
        }
        return step;
      }),
    [visibleSteps, lawType],
  );

  const visibleStepIds = useMemo(() => visibleSteps.map((s) => s.id), [visibleSteps]);
  const allSelected =
    visibleStepIds.length > 0 && visibleStepIds.every((id) => selected.includes(id));
  const selectedVisible = useMemo(
    () => selected.filter((id) => visibleStepIds.includes(id)),
    [selected, visibleStepIds],
  );

  const valid = useMemo(
    () => isLawType(lawType) && isRunMode(runMode) && !!storageRoot,
    [lawType, runMode, storageRoot],
  );

  function toggleStep(step: StepId) {
    setSelected((prev) =>
      prev.includes(step) ? prev.filter((id) => id !== step) : [...prev, step],
    );
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        return prev.filter((id) => !visibleStepIds.includes(id));
      }
      const merged = new Set<StepId>([...prev, ...visibleStepIds]);
      return Array.from(merged);
    });
  }

  function goConfig(forceAll: boolean) {
    if (!valid || !lawType || !storageRoot || !runMode) return;
    const steps = forceAll ? visibleStepIds : selectedVisible;
    const params = new URLSearchParams({
      lawType,
      storageRoot,
      runMode,
      steps: steps.join(","),
    });
    router.push(`/kb-update/new/config?${params.toString()}`);
  }

  const nextButtonText = useMemo(() => {
    // If only exporting/cleaning (no pagination-required steps), don't say "select pages"
    const hasIndexUpdate = selectedVisible.includes("law_index_update");
    const hasTreatyFlow = lawType ? TREATY_TYPES.has(lawType) : false;
    if (hasTreatyFlow) return "下一步：确认参数";
    return hasIndexUpdate ? "下一步：选取页数" : "下一步：确认参数";
  }, [lawType, selectedVisible]);

  function goBack() {
    if (!lawType || !storageRoot || !runMode) {
      router.push("/kb-update/new");
      return;
    }
    const params = new URLSearchParams({
      lawType,
      storageRoot,
      runMode,
    });
    router.push(`/kb-update/new?${params.toString()}`);
  }

  if (!valid) {
    return (
      <section className="mx-auto w-full max-w-3xl p-6 md:p-10">
        <p className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          任务基础配置缺失，请返回上一步重新填写。
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">步骤选择</h1>
        <p className="mt-2 text-sm text-slate-600">
          支持一键执行全部步骤，或按需分步执行（含全选）。
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <label className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          全选步骤
        </label>

        <div className="space-y-3">
          {stepsWithLabels.map((step) => (
            <label
              key={step.id}
              className="flex items-start gap-3 rounded-lg border border-slate-200 p-3"
            >
              <input
                type="checkbox"
                checked={selected.includes(step.id)}
                onChange={() => toggleStep(step.id)}
                className="mt-1"
              />
              <div>
                <p className="text-sm font-medium text-slate-900">{step.label}</p>
                <p className="text-xs text-slate-500">{step.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={goBack}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          返回
        </button>
        <button
          type="button"
          onClick={() => goConfig(false)}
          disabled={selectedVisible.length === 0}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {nextButtonText}
        </button>
      </div>
    </section>
  );
}

