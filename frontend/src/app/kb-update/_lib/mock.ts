import type { LawType, StepId } from "./config";
import { lawTypeLabel } from "./config";

export type JobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";

export type JobItem = {
  id: string;
  lawType: LawType;
  status: JobStatus;
  createdAt: string;
  duration: string;
};

export const RECENT_JOBS: JobItem[] = [
  {
    id: "job-20260421-001",
    lawType: "flfg",
    status: "SUCCESS",
    createdAt: "2026-04-21 10:25",
    duration: "12m 30s",
  },
  {
    id: "job-20260420-007",
    lawType: "dfxfg",
    status: "FAILED",
    createdAt: "2026-04-20 16:44",
    duration: "7m 15s",
  },
  {
    id: "job-20260420-003",
    lawType: "tiaoyue",
    status: "RUNNING",
    createdAt: "2026-04-20 14:20",
    duration: "18m 02s",
  },
];

export const MOCK_STEP_STATUS: Array<{
  step: StepId;
  label: string;
  status: "pending" | "running" | "success" | "failed";
}> = [
  { step: "env_check", label: "环境与目录检查", status: "success" },
  { step: "law_index_update", label: "法规索引更新", status: "running" },
  { step: "treaty_index_update", label: "条约索引更新", status: "pending" },
  { step: "treaty_download", label: "条约附件下载", status: "pending" },
  { step: "result_summary", label: "结果汇总", status: "pending" },
];

export const MOCK_LOGS = [
  "[10:25:10] 任务已创建，开始执行环境检查。",
  "[10:25:13] storageRoot 校验通过，目录可写。",
  "[10:25:18] 网络可达性检查通过，准备执行主流程。",
  "[10:25:20] 开始检索法规索引，第 1 页。",
  "[10:25:23] 第 1 页已完成，累计 20 条。",
  "[10:25:27] 第 2 页已完成，累计 40 条。",
];

export function statusBadgeClass(status: JobStatus): string {
  switch (status) {
    case "SUCCESS":
      return "bg-emerald-100 text-emerald-700";
    case "FAILED":
      return "bg-rose-100 text-rose-700";
    case "RUNNING":
      return "bg-blue-100 text-blue-700";
    case "CANCELLED":
      return "bg-slate-200 text-slate-700";
    default:
      return "bg-amber-100 text-amber-700";
  }
}

export function jobTitle(job: JobItem): string {
  return `${lawTypeLabel(job.lawType)} 更新任务`;
}
