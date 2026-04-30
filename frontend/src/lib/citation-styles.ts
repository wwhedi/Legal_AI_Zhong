import type { Citation } from "@/types";

/** 底部引用汇总统一格式：[1] 民法典 第496条 【有效】 */
export function formatCitationSummaryLine(
  c: Pick<Citation, "ref_id" | "law_name" | "article" | "status_display">,
): string {
  const name = (c.law_name || "法规").replace(/《|》/g, "");
  const st = c.status_display?.trim() || "【待核验】";
  return `${c.ref_id} ${name} 第${c.article}条 ${st}`;
}

/** 与后端 metadata.status / Citation.status 对齐的粗粒度分类 */
export type LawEffectKind = "effective" | "repealed" | "revised_or_pending" | "unknown";

const GREEN = { bg: "bg-[#52C41A]/15", text: "text-[#389E0D]", ring: "ring-[#52C41A]/35" };
const RED = { bg: "bg-[#F5222D]/12", text: "text-[#CF1322]", ring: "ring-[#F5222D]/35" };
const ORANGE = { bg: "bg-[#FAAD14]/18", text: "text-[#D48806]", ring: "ring-[#FAAD14]/40" };
const NEUTRAL = { bg: "bg-slate-500/12", text: "text-slate-700", ring: "ring-slate-400/30" };

/**
 * 从 Citation 或法条展示文案推断法律状态，用于引用角标颜色。
 */
export function inferLawEffectKind(
  citation: Pick<Citation, "status" | "status_display"> | null | undefined,
): LawEffectKind {
  const raw = `${citation?.status ?? ""} ${citation?.status_display ?? ""}`.toLowerCase();
  const cn = citation?.status_display ?? "";

  if (
    /repealed|废止|失效|废除/.test(raw) ||
    /【已废止】|【失效】|已废止|失效/.test(cn)
  ) {
    return "repealed";
  }
  if (
    /revised|已修改|修正|尚未生效|invalid|未生效|待生效/.test(raw) ||
    /【已修改】|【尚未生效】|已修改/.test(cn)
  ) {
    return "revised_or_pending";
  }
  if (
    /valid|effective|现行|有效/.test(raw) ||
    /【有效】|现行有效/.test(cn)
  ) {
    return "effective";
  }
  return "unknown";
}

export function lawEffectTagClasses(kind: LawEffectKind) {
  switch (kind) {
    case "effective":
      return GREEN;
    case "repealed":
      return RED;
    case "revised_or_pending":
      return ORANGE;
    default:
      return NEUTRAL;
  }
}

export function verificationLabelZh(verified: boolean | undefined): string {
  if (verified === false) return "未验证";
  return "已验证";
}

const VERIFY_SOURCE_ZH: Record<string, string> = {
  retrieved_context: "检索上下文",
  kb_fallback: "知识库兜底",
  unverified: "未校验",
};

export function verifySourceLabelZh(source: string | undefined): string {
  if (!source) return "—";
  return VERIFY_SOURCE_ZH[source] ?? source;
}
