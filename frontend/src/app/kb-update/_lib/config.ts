export type LawType =
  | "xf"
  | "flfg"
  | "xzfg"
  | "jcfg"
  | "sfjs"
  | "dfxfg"
  | "tiaoyue"
  | "shuangbian"
  | "duobian";

export type RunMode = "full_run" | "step_run";

export type StepId =
  | "env_check"
  | "law_index_update"
  | "treaty_index_update"
  | "treaty_download"
  | "kb_export"
  | "kb_upload"
  | "result_summary";

export const LAW_TYPE_OPTIONS: Array<{ value: LawType; label: string }> = [
  { value: "xf", label: "宪法" },
  { value: "flfg", label: "法律" },
  { value: "xzfg", label: "行政法规" },
  { value: "jcfg", label: "监察法规" },
  { value: "sfjs", label: "司法解释" },
  { value: "dfxfg", label: "地方法规" },
  { value: "tiaoyue", label: "条约（全部）" },
  { value: "shuangbian", label: "双边条约" },
  { value: "duobian", label: "多边条约" },
];

export const LAW_TYPES = new Set<LawType>([
  "xf",
  "flfg",
  "xzfg",
  "jcfg",
  "sfjs",
  "dfxfg",
]);

export const TREATY_TYPES = new Set<LawType>(["tiaoyue", "shuangbian", "duobian"]);

export const STEP_OPTIONS: Array<{ id: StepId; label: string; desc: string }> = [
  { id: "env_check", label: "环境与目录检查", desc: "校验目录可写、参数完整性与网络可达性。" },
  { id: "law_index_update", label: "法规索引更新", desc: "执行法规索引构建与更新流程。" },
  { id: "treaty_index_update", label: "条约索引更新", desc: "执行条约索引抓取与入库流程。" },
  { id: "treaty_download", label: "条约附件下载", desc: "下载条约 PDF 文件（耗时较长）。" },
  { id: "kb_export", label: "清洗与知识库导出", desc: "执行法规爬虫4，清洗并导出知识库上传文件。" },
  { id: "kb_upload", label: "上传阿里云知识库", desc: "执行法规爬虫5，将清洗产物上传到阿里云百炼知识库。" },
  { id: "result_summary", label: "结果汇总", desc: "汇总输出统计、失败信息与建议。" },
];

export const DEFAULT_STEPS: StepId[] = STEP_OPTIONS.map((s) => s.id);

export function isLawType(value: string | null): value is LawType {
  if (!value) return false;
  return LAW_TYPE_OPTIONS.some((item) => item.value === value);
}

export function isRunMode(value: string | null): value is RunMode {
  return value === "full_run" || value === "step_run";
}

export function lawTypeLabel(type: LawType): string {
  return LAW_TYPE_OPTIONS.find((item) => item.value === type)?.label ?? type;
}
