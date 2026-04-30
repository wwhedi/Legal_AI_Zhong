"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LAW_TYPE_OPTIONS, type LawType, type RunMode } from "../_lib/config";

export default function NewKnowledgeJobPage() {
  const router = useRouter();
  const [lawType, setLawType] = useState<LawType>("xf");
  const [storageRoot, setStorageRoot] = useState("e:\\LegalData");
  const [runMode, setRunMode] = useState<RunMode>("full_run");

  const canSubmit = useMemo(() => storageRoot.trim().length > 0, [storageRoot]);

  function handleNext() {
    if (!canSubmit) return;
    const params = new URLSearchParams({
      lawType,
      storageRoot,
      runMode,
    });
    router.push(`/kb-update/new/steps?${params.toString()}`);
  }

  return (
    <section className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">新建更新任务</h1>
        <p className="mt-2 text-sm text-slate-600">
          先选择更新对象和目录，下一步可选择一键全流程或分步运行。
        </p>
      </header>

      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-slate-700">规范类型</span>
          <select
            value={lawType}
            onChange={(e) => setLawType(e.target.value as LawType)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {LAW_TYPE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-slate-700">数据根目录（绝对路径）</span>
          <input
            value={storageRoot}
            onChange={(e) => setStorageRoot(e.target.value)}
            placeholder="例如：E:\LegalData"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">执行模式</legend>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              checked={runMode === "full_run"}
              onChange={() => setRunMode("full_run")}
            />
            一键全流程（默认执行全部步骤）
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="radio"
              checked={runMode === "step_run"}
              onChange={() => setRunMode("step_run")}
            />
            分步运行（可按需勾选步骤）
          </label>
        </fieldset>
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => router.push("/kb-update")}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          返回
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!canSubmit}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          下一步：步骤选择
        </button>
      </div>
    </section>
  );
}
