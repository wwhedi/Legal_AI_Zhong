"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, LogOut, MessageSquarePlus, Send, Square, User, X } from "lucide-react";
import {
  PLACEHOLDER_BASIS,
  PLACEHOLDER_RISK,
  PLACEHOLDER_SUGGESTION,
  QwenKbAnswerCard,
  type QwenAnswer,
} from "@/components/chat/QwenKbAnswerCard";
import { CitationSidePanel } from "@/components/chat/CitationSidePanel";
import { ChatSessionSidebar } from "@/components/chat/ChatSessionSidebar";
import { ProcessTimeline } from "@/components/chat/ProcessTimeline";
import {
  generateSessionTitle,
  getActiveSessionId,
  LEGACY_CHAT_SESSIONS_STORAGE_KEY,
  setActiveSessionId as persistActiveSessionId,
} from "@/lib/chat-sessions";
import { fetchMe, getApiBaseUrl, logout as logoutRequest } from "@/lib/auth-client";
import {
  apiAppendMessage,
  apiCreateSession,
  apiGetSessionMessages,
  apiListSessions,
  apiPatchSessionTitle,
  isChatApiUnauthorized,
} from "@/lib/chat-session-api";
import { cn, isValidExternalUrl, normalizeExternalUrl } from "@/lib/utils";
import type {
  ChatItem,
  ChatSession,
  ConversationHistoryTurn,
  QwenKbSource,
  RagProcessEvent,
} from "@/types";

type NewRagCitation = {
  ref_id?: string;
  law_name?: string;
  lawName?: string;
  law_type?: string;
  lawType?: string;
  effective_status?: string;
  effectiveStatus?: string;
  publish_date?: string;
  publishDate?: string;
  effective_date?: string;
  effectiveDate?: string;
  chapter?: string;
  article?: string;
  text?: string;
  source_url?: string;
  sourceUrl?: string;
  score?: number;
};

type NewRagResponse = {
  question: string;
  answer: string;
  model: string;
  retrieved_count: number;
  citations: NewRagCitation[];
};

/** 与流式回答兜底模型名一致（见 pushEvent 内解析 d.model） */
const DEFAULT_STREAM_MODEL_NAME = "qwen-plus";

/** 发往 /new-rag/ask-stream 的 conversation_history：条数与单条长度上限 */
const MAX_HISTORY_MESSAGES = 6;
const MAX_USER_HISTORY_CHARS = 500;
const MAX_ASSISTANT_HISTORY_CHARS = 800;

/** 距底部超过此值视为用户主动上滑，暂停自动滚到底 */
const AUTO_SCROLL_PAUSE_BELOW_PX = 120;
/** 距底部小于此值恢复自动跟随 */
const AUTO_SCROLL_RESUME_BELOW_PX = 80;

function buildConversationHistoryForAskStream(recentMessages: ChatItem[]): ConversationHistoryTurn[] {
  const out: ConversationHistoryTurn[] = [];
  for (const m of recentMessages) {
    if (m.role === "user") {
      const content = (m.content ?? "").trim().slice(0, MAX_USER_HISTORY_CHARS);
      if (!content) continue;
      out.push({ role: "user", content });
      continue;
    }
    const conclusion = (m.answerCard?.answer?.conclusion ?? "").trim();
    const raw = conclusion || (m.content ?? "").trim();
    const content = raw.slice(0, MAX_ASSISTANT_HISTORY_CHARS);
    if (!content) continue;
    out.push({ role: "assistant", content });
  }
  return out;
}

function parseRefIdToNumber(refId?: string): number | null {
  const raw = String(refId ?? "").trim();
  const m = /^\[(\d+)\]$/.exec(raw) || /^(\d+)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function asEventRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function chapterArticleFromParts(ch: unknown, ar: unknown): string {
  const c = ch != null ? String(ch).trim() : "";
  const a = ar != null ? String(ar).trim() : "";
  if (c === "未提供" && a === "未提供") return "未提供";
  if (c && c !== "未提供" && a && a !== "未提供") return `${c}；${a}`;
  return c && c !== "未提供" ? c : a || "未提供";
}

/** 开发环境仅：对比各 ref 的 sourceUrl 字节与校验结果（不打印法规正文全文） */
type CitationUrlDebugRow = {
  id: number;
  refIdRaw: string;
  law: string;
  chapterArticle: string;
  urlApiRaw: string | null;
  urlTrimOnly: string | null;
  urlNormalized: string | null;
};

function debugLogCitationUrls(phase: string, rows: CitationUrlDebugRow[]) {
  if (process.env.NODE_ENV !== "development" || rows.length === 0) return;
  console.groupCollapsed(`[debug citation url] ${phase} (${rows.length} items)`);
  for (const r of rows) {
    const norm = r.urlNormalized ?? "";
    console.log("[debug citation url]");
    console.log(`id: ${r.id}`);
    console.log(`ref_id: ${r.refIdRaw}`);
    console.log(`law: ${r.law}`);
    console.log(`chapter: ${r.chapterArticle}`);
    console.log(`urlApiRaw: ${r.urlApiRaw ?? "(null)"}`);
    console.log(`urlTrimOnly: ${r.urlTrimOnly ?? "(null)"}`);
    console.log(`urlNormalized: ${norm}`);
    console.log(`normalizedLength: ${norm.length}`);
    console.log(`normalizedEncoded: ${encodeURIComponent(norm)}`);
    console.log(`valid: ${norm !== "" && isValidExternalUrl(norm)}`);
  }
  console.groupEnd();
}

/** 与 ProcessTimeline 一致：从 kb_retrieve_done 的 citations_summary 构造来源，供流式阶段 QwenKbAnswerCard 的 [n] 悬浮 */
function kbSourcesFromRagEvents(events: RagProcessEvent[]): QwenKbSource[] {
  const isDev = process.env.NODE_ENV === "development";
  const hit = [...events].reverse().find((e) => e.stage === "kb_retrieve_done");
  const d = asEventRecord(hit?.data);
  const arr = d && Array.isArray(d.citations_summary) ? d.citations_summary : [];
  const out: QwenKbSource[] = [];
  const debugRows: CitationUrlDebugRow[] = [];
  for (const raw of arr) {
    const row = asEventRecord(raw);
    if (!row) continue;
    const id = parseRefIdToNumber(row.ref_id != null ? String(row.ref_id) : undefined);
    if (!id) continue;
    const lawName = row.law_name != null ? String(row.law_name) : "未提供";
    const chapter = row.chapter != null ? String(row.chapter) : "未提供";
    const article = row.article != null ? String(row.article) : "未提供";
    const refRaw = row.ref_id != null ? String(row.ref_id).trim() : "";
    const su = row.source_url ?? row.sourceUrl;
    const urlApiRaw = su == null ? null : String(su);
    const urlTrimOnly = su == null ? null : (() => {
      const t = String(su).trim();
      return t ? t : null;
    })();
    const urlNormalized = normalizeExternalUrl(urlApiRaw);
    if (isDev) {
      debugRows.push({
        id,
        refIdRaw: refRaw || (row.ref_id != null ? String(row.ref_id) : ""),
        law: lawName,
        chapterArticle: chapterArticleFromParts(chapter, article),
        urlApiRaw,
        urlTrimOnly,
        urlNormalized,
      });
    }
    out.push({
      id,
      refId: refRaw || `[${id}]`,
      lawName,
      lawType: "未提供",
      effectiveStatus: row.effective_status != null ? String(row.effective_status) : "未提供",
      publishDate: row.publish_date != null ? String(row.publish_date) : "未提供",
      effectiveDate: row.effective_date != null ? String(row.effective_date) : "未提供",
      chapter,
      article,
      text: `${lawName} · ${chapterArticleFromParts(chapter, article)}`,
      sourceUrl: urlNormalized,
      score: typeof row.score === "number" ? row.score : undefined,
    });
  }
  const sorted = out.sort((a, b) => a.id - b.id);
  if (isDev && debugRows.length > 0) {
    debugRows.sort((a, b) => a.id - b.id);
    debugLogCitationUrls("kb_retrieve_done.citations_summary (streaming)", debugRows);
  }
  return sorted;
}

type SectionKind = "conclusion" | "keyFacts" | "basis" | "risks" | "actionAdvice" | "actionSteps";

type SectionHeaderRule = {
  kind: SectionKind;
  friendly: boolean;
  match: RegExp;
  strips: RegExp[];
  /** 优先尝试：同一行标题+正文、顿号编号等；捕获组为剩余正文（可为空） */
  flexStrips?: RegExp[];
};

/** 小节编号前缀：1) 1）1、1. 一、 等（不依赖 \\b） */
const SEC_P1 = "(?:[1１]\\s*(?:[)）]|[、,，]|[.．])\\s*|[一]\\s*[、,，.]\\s*)";
const SEC_P2 = "(?:[2２]\\s*(?:[)）]|[、,，]|[.．])\\s*|[二]\\s*[、,，.]\\s*)";
const SEC_P3 = "(?:[3３]\\s*(?:[)）]|[、,，]|[.．])\\s*|[三]\\s*[、,，.]\\s*)";
const SEC_P4 = "(?:[4４]\\s*(?:[)）]|[、,，]|[.．])\\s*|[四]\\s*[、,，.]\\s*)";
const SEC_P5 = "(?:[5５]\\s*(?:[)）]|[、,，]|[.．])\\s*|[五]\\s*[、,，.]\\s*)";
const SEC_P6 = "(?:[6６]\\s*(?:[)）]|[、,，]|[.．])\\s*|[六]\\s*[、,，.]\\s*)";

/** 列表项「- [1] …」不是小节标题；不把引用 [n] 当章节号 */
function isCitationListLine(line: string): boolean {
  return /^\s*[-*•]\s*\[\d+\]/.test(line.trimStart());
}

/** 标题匹配：顺序靠前的优先（避免「行动建议」被「建议」吃掉等） */
const SECTION_HEADER_RULES: SectionHeaderRule[] = [
  {
    kind: "actionSteps",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P4}可执行操作步骤`),
    flexStrips: [new RegExp(`^\\s*${SEC_P4}可执行操作步骤\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)可执行操作步骤(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)可执行操作步骤\s*$/s,
    ],
  },
  {
    kind: "actionSteps",
    friendly: true,
    match: new RegExp(
      `^\\s*${SEC_P4}(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)`,
    ),
    flexStrips: [
      new RegExp(
        `^\\s*${SEC_P4}(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)\\s*(.*)$`,
        "s",
      ),
    ],
    strips: [
      /^\s*(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)\s*$/s,
    ],
  },
  {
    kind: "actionSteps",
    friendly: true,
    match: /^\s*可执行操作步骤(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*可执行操作步骤\s*[：:]\s*(.*)$/s,
      /^\s*可执行操作步骤\s+(.+)$/s,
      /^\s*可执行操作步骤\s*$/s,
    ],
    strips: [/^\s*可执行操作步骤(\s*[：:]\s*|\s+)(.*)$/s, /^\s*可执行操作步骤\s*$/s],
  },
  {
    kind: "actionSteps",
    friendly: true,
    match: /^\s*(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)(?:\s*[：:]|\s+$|\s+)/,
    strips: [
      /^\s*(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:办理步骤|处理步骤|执行步骤|流程步骤|操作步骤)\s*$/s,
    ],
  },
  {
    kind: "actionSteps",
    friendly: true,
    match: /^\s*(?:维权步骤|索赔步骤|申请步骤)(?:\s*[：:]|\s+$|\s+)/,
    strips: [
      /^\s*(?:维权步骤|索赔步骤|申请步骤)(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:维权步骤|索赔步骤|申请步骤)\s*$/s,
    ],
  },
  {
    kind: "keyFacts",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P2}影响结果的关键事实`),
    flexStrips: [new RegExp(`^\\s*${SEC_P2}影响结果的关键事实\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)影响结果的关键事实(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)影响结果的关键事实\s*$/s,
    ],
  },
  {
    kind: "keyFacts",
    friendly: true,
    match: /^\s*影响结果的关键事实(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*影响结果的关键事实\s*[：:]\s*(.*)$/s,
      /^\s*影响结果的关键事实\s+(.+)$/s,
      /^\s*影响结果的关键事实\s*$/s,
    ],
    strips: [/^\s*影响结果的关键事实(\s*[：:]\s*|\s+)(.*)$/s, /^\s*影响结果的关键事实\s*$/s],
  },
  {
    kind: "keyFacts",
    friendly: true,
    match: /^\s*核心判断要点(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*核心判断要点(\s*[：:]\s*|\s+)(.*)$/s, /^\s*核心判断要点\s*$/s],
  },
  {
    kind: "keyFacts",
    friendly: true,
    match: /^\s*关键判断标准(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*关键判断标准(\s*[：:]\s*|\s+)(.*)$/s, /^\s*关键判断标准\s*$/s],
  },
  {
    kind: "keyFacts",
    friendly: false,
    match: /^\s*判断标准(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*判断标准(\s*[：:]\s*|\s+)(.*)$/s, /^\s*判断标准\s*$/s],
  },
  {
    kind: "keyFacts",
    friendly: false,
    match: /^\s*关键判断(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*关键判断(\s*[：:]\s*|\s+)(.*)$/s, /^\s*关键判断\s*$/s],
  },
  {
    kind: "keyFacts",
    friendly: false,
    match: /^\s*关键事实(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*关键事实(\s*[：:]\s*|\s+)(.*)$/s, /^\s*关键事实\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P1}一句话结论`),
    flexStrips: [new RegExp(`^\\s*${SEC_P1}一句话结论\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)一句话结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)一句话结论\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*一句话结论(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*一句话结论\s*[：:]\s*(.*)$/s,
      /^\s*一句话结论\s+(.+)$/s,
      /^\s*一句话结论\s*$/s,
    ],
    strips: [/^\s*一句话结论(\s*[：:]\s*|\s+)(.*)$/s, /^\s*一句话结论\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P1}简短结论`),
    flexStrips: [new RegExp(`^\\s*${SEC_P1}简短结论\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)简短结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)简短结论\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*简短结论(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*简短结论\s*[：:]\s*(.*)$/s,
      /^\s*简短结论\s+(.+)$/s,
      /^\s*简短结论\s*$/s,
    ],
    strips: [/^\s*简短结论(\s*[：:]\s*|\s+)(.*)$/s, /^\s*简短结论\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P1}核心结论`),
    flexStrips: [new RegExp(`^\\s*${SEC_P1}核心结论\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)核心结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)核心结论\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*核心结论(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*核心结论\s*[：:]\s*(.*)$/s,
      /^\s*核心结论\s+(.+)$/s,
      /^\s*核心结论\s*$/s,
    ],
    strips: [/^\s*核心结论(\s*[：:]\s*|\s+)(.*)$/s, /^\s*核心结论\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P1}直接回答`),
    flexStrips: [new RegExp(`^\\s*${SEC_P1}直接回答\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)直接回答(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)直接回答\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*直接回答(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*直接回答\s*[：:]\s*(.*)$/s,
      /^\s*直接回答\s+(.+)$/s,
      /^\s*直接回答\s*$/s,
    ],
    strips: [/^\s*直接回答(\s*[：:]\s*|\s+)(.*)$/s, /^\s*直接回答\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P1}直接结论`),
    flexStrips: [new RegExp(`^\\s*${SEC_P1}直接结论\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)直接结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)直接结论\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*直接结论(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*直接结论\s*[：:]\s*(.*)$/s,
      /^\s*直接结论\s+(.+)$/s,
      /^\s*直接结论\s*$/s,
    ],
    strips: [/^\s*直接结论(\s*[：:]\s*|\s+)(.*)$/s, /^\s*直接结论\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: false,
    match: new RegExp(`^\\s*${SEC_P1}结论(?![性书及编])`),
    flexStrips: [new RegExp(`^\\s*${SEC_P1}结论(?![性书及编])\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)结论(?![性书及编])\s*(.*)$/s,
      /^\s*(?:(?:[1１]\s*(?:[)）]|[、,，]|[.．])\s*|[一]\s*[、,，.]\s*|1\s*\.)\s*)结论\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: false,
    match: /^\s*结论(?![性书及编])\s*$/,
    strips: [/^\s*结论(?![性书及编])\s*$/s],
  },
  {
    kind: "conclusion",
    friendly: false,
    match: /^\s*结论(?![性书及编])(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*结论(?![性书及编])\s*[：:]\s*(.*)$/s,
      /^\s*结论(?![性书及编])\s+(.+)$/s,
      /^\s*结论(?![性书及编])\s*$/s,
    ],
    strips: [/^\s*结论(\s*[：:]\s*|\s+)(.*)$/s, /^\s*结论(?![性书及编])\s*$/s, /^\s*结论\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P3}你现在可以这样处理`),
    flexStrips: [new RegExp(`^\\s*${SEC_P3}你现在可以这样处理\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)你现在可以这样处理(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)你现在可以这样处理\s*$/s,
    ],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*你现在可以这样处理(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*你现在可以这样处理\s*[：:]\s*(.*)$/s,
      /^\s*你现在可以这样处理\s+(.+)$/s,
      /^\s*你现在可以这样处理\s*$/s,
    ],
    strips: [/^\s*你现在可以这样处理(\s*[：:]\s*|\s+)(.*)$/s, /^\s*你现在可以这样处理\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*下一步建议(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*下一步建议(\s*[：:]\s*|\s+)(.*)$/s, /^\s*下一步建议\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*处理建议(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*处理建议(\s*[：:]\s*|\s+)(.*)$/s, /^\s*处理建议\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P2}你现在最该做`),
    flexStrips: [new RegExp(`^\\s*${SEC_P2}你现在最该做\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)你现在最该做(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)你现在最该做\s*$/s,
    ],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P2}现在最该做`),
    flexStrips: [new RegExp(`^\\s*${SEC_P2}现在最该做\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)现在最该做(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)现在最该做\s*$/s,
    ],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*你现在最该做(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*你现在最该做\s*[：:]\s*(.*)$/s,
      /^\s*你现在最该做\s+(.+)$/s,
      /^\s*你现在最该做\s*$/s,
    ],
    strips: [/^\s*你现在最该做(\s*[：:]\s*|\s+)(.*)$/s, /^\s*你现在最该做\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*现在最该做(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*现在最该做\s*[：:]\s*(.*)$/s,
      /^\s*现在最该做\s+(.+)$/s,
      /^\s*现在最该做\s*$/s,
    ],
    strips: [/^\s*现在最该做(\s*[：:]\s*|\s+)(.*)$/s, /^\s*现在最该做\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*行动建议(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*行动建议(\s*[：:]\s*|\s+)(.*)$/s, /^\s*行动建议\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*下一步(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*下一步(\s*[：:]\s*|\s+)(.*)$/s, /^\s*下一步\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: true,
    match: /^\s*你可以这样做(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*你可以这样做(\s*[：:]\s*|\s+)(.*)$/s, /^\s*你可以这样做\s*$/s],
  },
  {
    kind: "actionAdvice",
    friendly: false,
    match: /^\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议\b/,
    strips: [
      /^\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议\s*$/s,
    ],
  },
  {
    kind: "actionAdvice",
    friendly: false,
    match: /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议\b/,
    strips: [
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议\s*$/s,
    ],
  },
  {
    kind: "actionAdvice",
    friendly: false,
    match: /^\s*建议(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*建议(\s*[：:]\s*|\s+)(.*)$/s, /^\s*建议\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P5}需要注意`),
    flexStrips: [new RegExp(`^\\s*${SEC_P5}需要注意\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)需要注意(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)需要注意\s*$/s,
    ],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*五[、.,．]\s*需要注意(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*五[、.,．]\s*需要注意\s*[：:]\s*(.*)$/s,
      /^\s*五[、.,．]\s*需要注意\s+(.+)$/s,
      /^\s*五[、.,．]\s*需要注意\s*$/s,
    ],
    strips: [/^\s*五[、.,．]\s*需要注意(\s*[：:]\s*|\s+)(.*)$/s, /^\s*五[、.,．]\s*需要注意\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*特别说明(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*特别说明(\s*[：:]\s*|\s+)(.*)$/s, /^\s*特别说明\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*注意事项(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*注意事项(\s*[：:]\s*|\s+)(.*)$/s, /^\s*注意事项\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*对方可能的抗辩(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*对方可能的抗辩(\s*[：:]\s*|\s+)(.*)$/s, /^\s*对方可能的抗辩\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*特殊风险(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*特殊风险(\s*[：:]\s*|\s+)(.*)$/s, /^\s*特殊风险\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P3}需要注意`),
    flexStrips: [new RegExp(`^\\s*${SEC_P3}需要注意\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)需要注意(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)需要注意\s*$/s,
    ],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*需要注意(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*需要注意\s*[：:]\s*(.*)$/s,
      /^\s*需要注意\s+(.+)$/s,
      /^\s*需要注意\s*$/s,
    ],
    strips: [/^\s*需要注意(\s*[：:]\s*|\s+)(.*)$/s, /^\s*需要注意\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*三[、.,．]\s*需要注意(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*三[、.,．]\s*需要注意\s*[：:]\s*(.*)$/s,
      /^\s*三[、.,．]\s*需要注意\s+(.+)$/s,
      /^\s*三[、.,．]\s*需要注意\s*$/s,
    ],
    strips: [/^\s*三[、.,．]\s*需要注意(\s*[：:]\s*|\s+)(.*)$/s, /^\s*三[、.,．]\s*需要注意\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P3}风险提示`),
    flexStrips: [new RegExp(`^\\s*${SEC_P3}风险提示\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险提示(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险提示\s*$/s,
    ],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*风险提示(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*风险提示\s*[：:]\s*(.*)$/s,
      /^\s*风险提示\s+(.+)$/s,
      /^\s*风险提示\s*$/s,
    ],
    strips: [/^\s*风险提示(\s*[：:]\s*|\s+)(.*)$/s, /^\s*风险提示\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*主要风险(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*主要风险(\s*[：:]\s*|\s+)(.*)$/s, /^\s*主要风险\s*$/s],
  },
  {
    kind: "risks",
    friendly: true,
    match: /^\s*注意风险(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*注意风险(\s*[：:]\s*|\s+)(.*)$/s, /^\s*注意风险\s*$/s],
  },
  {
    kind: "risks",
    friendly: false,
    match: /^\s*风险点(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*风险点(\s*[：:]\s*|\s+)(.*)$/s, /^\s*风险点\s*$/s],
  },
  {
    kind: "risks",
    friendly: false,
    match: /^\s*风险点\s*$/,
    strips: [/^\s*风险点\s*$/s],
  },
  {
    kind: "risks",
    friendly: false,
    match: new RegExp(`^\\s*${SEC_P3}风险点`),
    flexStrips: [new RegExp(`^\\s*${SEC_P3}风险点\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险点(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险点\s*$/s,
    ],
  },
  {
    kind: "risks",
    friendly: false,
    match: new RegExp(`^\\s*${SEC_P3}风险(?![点示])`),
    flexStrips: [new RegExp(`^\\s*${SEC_P3}风险(?![点示])\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险\s*$/s,
    ],
  },
  {
    kind: "risks",
    friendly: false,
    match: /^\s*风险(?![点示])(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*风险(\s*[：:]\s*|\s+)(.*)$/s, /^\s*风险\s*$/s],
  },
  {
    kind: "basis",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P6}法律依据`),
    flexStrips: [new RegExp(`^\\s*${SEC_P6}法律依据\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[6６]\s*(?:[)）]|[、,，]|[.．])\s*|[六]\s*[、,，.]\s*|6\s*\.)\s*)法律依据(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[6６]\s*(?:[)）]|[、,，]|[.．])\s*|[六]\s*[、,，.]\s*|6\s*\.)\s*)法律依据\s*$/s,
    ],
  },
  {
    kind: "basis",
    friendly: true,
    match: /^\s*六[、.,．]\s*法律依据(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*六[、.,．]\s*法律依据\s*[：:]\s*(.*)$/s,
      /^\s*六[、.,．]\s*法律依据\s+(.+)$/s,
      /^\s*六[、.,．]\s*法律依据\s*$/s,
    ],
    strips: [/^\s*六[、.,．]\s*法律依据(\s*[：:]\s*|\s+)(.*)$/s, /^\s*六[、.,．]\s*法律依据\s*$/s],
  },
  {
    kind: "basis",
    friendly: true,
    match: new RegExp(`^\\s*${SEC_P5}法律依据`),
    flexStrips: [new RegExp(`^\\s*${SEC_P5}法律依据\\s*(.*)$`, "s")],
    strips: [
      /^\s*(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)法律依据(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)法律依据\s*$/s,
    ],
  },
  {
    kind: "basis",
    friendly: true,
    match: /^\s*法律依据(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*法律依据\s*[：:]\s*(.*)$/s,
      /^\s*法律依据\s+(.+)$/s,
      /^\s*法律依据\s*$/s,
    ],
    strips: [/^\s*法律依据(\s*[：:]\s*|\s+)(.*)$/s, /^\s*法律依据\s*$/s],
  },
  {
    kind: "basis",
    friendly: true,
    match: /^\s*引用依据(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*引用依据\s*[：:]\s*(.*)$/s,
      /^\s*引用依据\s+(.+)$/s,
      /^\s*引用依据\s*$/s,
    ],
    strips: [/^\s*引用依据(\s*[：:]\s*|\s+)(.*)$/s, /^\s*引用依据\s*$/s],
  },
  {
    kind: "basis",
    friendly: true,
    match: /^\s*相关依据(?:\s*[：:]|\s+$|\s+)/,
    flexStrips: [
      /^\s*相关依据\s*[：:]\s*(.*)$/s,
      /^\s*相关依据\s+(.+)$/s,
      /^\s*相关依据\s*$/s,
    ],
    strips: [/^\s*相关依据(\s*[：:]\s*|\s+)(.*)$/s, /^\s*相关依据\s*$/s],
  },
  {
    kind: "basis",
    friendly: false,
    match: /^\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据\b/,
    strips: [
      /^\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据\s*$/s,
    ],
  },
  {
    kind: "basis",
    friendly: false,
    match: /^\s*依据\s*$/,
    strips: [/^\s*依据\s*$/s],
  },
  {
    kind: "basis",
    friendly: false,
    match: /^\s*依据(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*依据(\s*[：:]\s*|\s+)(.*)$/s, /^\s*依据\s*$/s],
  },
];

function matchSectionHeader(line: string): SectionHeaderRule | null {
  const t = line.trimStart();
  if (isCitationListLine(line)) return null;
  for (const rule of SECTION_HEADER_RULES) {
    if (rule.match.test(t)) return rule;
  }
  return null;
}

function stripSectionHeaderLine(line: string, rule: SectionHeaderRule): { rest: string; stripped: boolean } {
  const sequence = [...(rule.flexStrips ?? []), ...rule.strips];
  for (const re of sequence) {
    const m = re.exec(line);
    if (!m) continue;
    if (m.length <= 1) {
      return { rest: "", stripped: true };
    }
    const body = m[2] ?? m[1];
    if (typeof body === "string") {
      return { rest: body.trim(), stripped: true };
    }
    return { rest: "", stripped: true };
  }
  return { rest: line, stripped: false };
}

function textHasAnySectionHeader(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (matchSectionHeader(line)) return true;
  }
  return false;
}

/** 从一段文字中拆出后续小节（用于标题挤在同一行的情况） */
function peelFollowingSection(
  content: string,
  kind: "basis" | "risks" | "actionAdvice" | "actionSteps" | "keyFacts",
): { head: string; tail: string } {
  const patterns: Record<typeof kind, RegExp[]> = {
    keyFacts: [
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)影响结果的关键事实\s*[：:]?\s*/,
      /(?<![0-9０-９])影响结果的关键事实\s*[：:]?\s*/,
      /(?<![0-9０-９])核心判断要点\s*[：:]?\s*/,
      /(?<![0-9０-９])关键判断标准\s*[：:]?\s*/,
      /(?<![0-9０-９])判断标准\s*[：:]?\s*/,
      /(?<![0-9０-９])关键判断\s*[：:]?\s*/,
      /(?<![0-9０-９])关键事实\s*[：:]?\s*/,
    ],
    basis: [
      /(?<![0-9０-９])(?:(?:[6６]\s*(?:[)）]|[、,，]|[.．])\s*|[六]\s*[、,，.]\s*|6\s*\.)\s*)法律依据\s*[：:]?\s*/,
      /(?<![0-9０-９])六[、.,．]\s*法律依据\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)法律依据\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)依据\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)(?:引用依据|相关依据)\s*[：:]?\s*/,
    ],
    risks: [
      /(?<![0-9０-９])(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)需要注意\s*[：:]?\s*/,
      /(?<![0-9０-９])五[、.,．]\s*需要注意\s*[：:]?\s*/,
      /(?<![0-9０-９])特别说明\s*[：:]?\s*/,
      /(?<![0-9０-９])注意事项\s*[：:]?\s*/,
      /(?<![0-9０-９])对方可能的抗辩\s*[：:]?\s*/,
      /(?<![0-9０-９])特殊风险\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)需要注意\s*[：:]?\s*/,
      /(?<![0-9０-９])三[、.,．]\s*需要注意\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险提示\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)主要风险\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)注意风险\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险点\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险(?![点示])\s*[：:]?\s*/,
    ],
    actionAdvice: [
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)你现在可以这样处理\s*[：:]?\s*/,
      /(?<![0-9０-９])你现在可以这样处理\s*[：:]?\s*/,
      /(?<![0-9０-９])下一步建议\s*[：:]?\s*/,
      /(?<![0-9０-９])处理建议\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)你现在最该做\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)现在最该做\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)建议\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)建议\s*[：:]?\s*/,
    ],
    actionSteps: [
      /(?<![0-9０-９])(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)可执行操作步骤\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)(?:操作步骤|办理步骤|处理步骤|执行步骤|流程步骤)\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:维权步骤|索赔步骤|申请步骤)\s*[：:]?\s*/,
    ],
  };
  for (const rx of patterns[kind]) {
    const m = rx.exec(content);
    if (m && m.index !== undefined) {
      return {
        head: content.slice(0, m.index).trimEnd(),
        tail: content.slice(m.index + m[0].length).trim(),
      };
    }
  }
  return { head: content, tail: "" };
}

const ACTION_LINE_RE =
  /^\s*(?:建议|应当|可以|需要|请|建议先|建议双方|建议当事人|建议贵方|建议您|建议你|建议企业)/;

function heuristicAppendSuggestionFromBasisLines(basisLines: string[]): { basisLines: string[]; suggestionLines: string[] } {
  const splitIdx = basisLines.findIndex((ln, i) => i > 0 && ACTION_LINE_RE.test(ln));
  if (splitIdx === -1) return { basisLines, suggestionLines: [] };
  return {
    basisLines: basisLines.slice(0, splitIdx),
    suggestionLines: basisLines.slice(splitIdx),
  };
}

function fallbackFourPart(text: string): {
  conclusion: string;
  basis: string;
  risks: string;
  actionAdvice: string;
} {
  const paras = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 4) {
    return {
      conclusion: paras[0] ?? "",
      basis: paras[1] ?? "",
      risks: paras[2] ?? "",
      actionAdvice: paras.slice(3).join("\n\n"),
    };
  }
  if (paras.length === 3) {
    return { conclusion: paras[0] ?? "", basis: paras[1] ?? "", risks: "", actionAdvice: paras[2] ?? "" };
  }
  if (paras.length === 2) {
    return { conclusion: paras[0] ?? "", basis: paras[1] ?? "", risks: "", actionAdvice: "" };
  }
  const lines = text.split(/\r?\n/);
  const basisLike: string[] = [];
  const riskLike: string[] = [];
  const suggestLike: string[] = [];
  const head: string[] = [];
  let phase: "head" | "basis" | "risk" | "suggest" = "head";
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) {
      if (phase === "head") head.push(ln);
      else if (phase === "basis") basisLike.push(ln);
      else if (phase === "risk") riskLike.push(ln);
      else suggestLike.push(ln);
      continue;
    }
    const listCitation = /^[-*•]\s*\[[0-9０-９]+\]/.test(t);
    const riskHead = /^(?:风险点|风险|风险提示|需要注意)\s*[：:]/.test(t);
    const action = ACTION_LINE_RE.test(t);
    if (phase === "head" && listCitation) {
      phase = "basis";
    }
    if (phase === "basis" && riskHead) {
      phase = "risk";
    }
    if ((phase === "basis" || phase === "risk") && action && !/^[-*•]\s*\[[0-9０-９]+\]/.test(t) && !riskHead) {
      phase = "suggest";
    }
    if (phase === "head") head.push(ln);
    else if (phase === "basis") basisLike.push(ln);
    else if (phase === "risk") riskLike.push(ln);
    else suggestLike.push(ln);
  }
  return {
    conclusion: head.join("\n").trim() || text.trim(),
    basis: basisLike.join("\n").trim(),
    risks: riskLike.join("\n").trim(),
    actionAdvice: suggestLike.join("\n").trim(),
  };
}

function mergeTail(prefix: string, existing: string): string {
  return [prefix, existing].filter(Boolean).join("\n\n").trim();
}

function applyPeelChain(
  head: string,
  kinds: Array<"keyFacts" | "basis" | "risks" | "actionAdvice" | "actionSteps">,
  parts: { basis: string; risks: string; actionAdvice: string; actionSteps: string; keyFacts: string },
): string {
  let h = head;
  for (const k of kinds) {
    const p = peelFollowingSection(h, k);
    if (p.tail) {
      h = p.head.trim();
      parts[k] = mergeTail(p.tail, parts[k]);
    }
  }
  return h;
}

function normalizeAnswer(answer: string): QwenAnswer {
  const text = (answer || "").trim();
  if (!text) {
    return {
      conclusion: "未获取到回答。",
      basis: PLACEHOLDER_BASIS,
      risks: PLACEHOLDER_RISK,
      actionAdvice: PLACEHOLDER_SUGGESTION,
      details: [
        { title: "依据", content: PLACEHOLDER_BASIS },
        { title: "风险点", content: PLACEHOLDER_RISK },
        { title: "建议", content: PLACEHOLDER_SUGGESTION },
      ],
    };
  }

  let mode: SectionKind = "conclusion";
  let sawFriendlyDetailTitles = false;
  const buckets: Record<SectionKind, string[]> = {
    conclusion: [],
    keyFacts: [],
    basis: [],
    risks: [],
    actionAdvice: [],
    actionSteps: [],
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const rule = matchSectionHeader(line);
    if (rule) {
      const { rest, stripped } = stripSectionHeaderLine(line, rule);
      if (!stripped) {
        buckets[mode].push(line);
        continue;
      }
      if (rule.friendly || rule.kind === "actionSteps" || rule.kind === "keyFacts") sawFriendlyDetailTitles = true;
      mode = rule.kind;
      if (rest) buckets[rule.kind].push(rest);
      continue;
    }
    buckets[mode].push(line);
  }

  let conclusion = buckets.conclusion.join("\n").trim();
  let keyFacts = buckets.keyFacts.join("\n").trim();
  let basis = buckets.basis.join("\n").trim();
  let risks = buckets.risks.join("\n").trim();
  let actionAdvice = buckets.actionAdvice.join("\n").trim();
  let actionSteps = buckets.actionSteps.join("\n").trim();

  const parts = { basis, risks, actionAdvice, actionSteps, keyFacts };
  conclusion = applyPeelChain(conclusion, ["keyFacts", "actionAdvice", "actionSteps", "risks", "basis"], parts);
  parts.keyFacts = applyPeelChain(parts.keyFacts, ["actionAdvice", "actionSteps", "risks", "basis"], parts);
  parts.basis = applyPeelChain(parts.basis, ["keyFacts", "actionAdvice", "actionSteps", "risks"], parts);
  parts.risks = applyPeelChain(parts.risks, ["actionAdvice", "actionSteps", "basis"], parts);
  parts.actionAdvice = applyPeelChain(parts.actionAdvice, ["actionSteps", "risks", "basis"], parts);
  parts.actionSteps = applyPeelChain(parts.actionSteps, ["risks", "basis"], parts);
  keyFacts = parts.keyFacts;
  basis = parts.basis;
  risks = parts.risks;
  actionAdvice = parts.actionAdvice;
  actionSteps = parts.actionSteps;

  if (!actionAdvice.trim()) {
    const bl = basis.split(/\r?\n/);
    const heur = heuristicAppendSuggestionFromBasisLines(bl);
    basis = heur.basisLines.join("\n").trim();
    actionAdvice = mergeTail(heur.suggestionLines.join("\n").trim(), actionAdvice);
  }

  const looksUnstructured =
    !textHasAnySectionHeader(text) &&
    !keyFacts.trim() &&
    !basis.trim() &&
    !risks.trim() &&
    !actionAdvice.trim() &&
    !actionSteps.trim();

  if (looksUnstructured) {
    const fb = fallbackFourPart(text);
    conclusion = fb.conclusion;
    basis = fb.basis;
    risks = fb.risks;
    actionAdvice = fb.actionAdvice;
  }

  if (!conclusion.trim()) {
    const firstPara = text.split(/\n\s*\n+/)[0]?.trim() || text.split(/\r?\n/)[0]?.trim() || "";
    if (firstPara) {
      conclusion = firstPara;
    }
  }

  if (!basis.trim()) {
    basis = PLACEHOLDER_BASIS;
  }
  if (!risks.trim()) {
    risks = PLACEHOLDER_RISK;
  }
  if (!actionAdvice.trim()) {
    actionAdvice = PLACEHOLDER_SUGGESTION;
  }

  const actionStepsRaw = actionSteps.trim() ? actionSteps.trim() : undefined;

  const d0 = sawFriendlyDetailTitles ? "法律依据" : "依据";
  const d1 = sawFriendlyDetailTitles ? "需要注意" : "风险点";
  const d2 = sawFriendlyDetailTitles ? "你现在可以这样处理" : "建议";

  const keyFactsTrim = keyFacts.trim();
  const out: QwenAnswer = {
    conclusion: conclusion.trim() || text,
    basis,
    risks,
    actionAdvice,
    actionStepsRaw,
    details: [
      { title: d0, content: basis },
      { title: d1, content: risks },
      { title: d2, content: actionAdvice },
    ],
  };
  if (keyFactsTrim) out.keyFacts = keyFactsTrim;
  return out;
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "未提供";
}

function pickUrl(obj: Record<string, unknown>): string | null {
  const v = obj.source_url ?? obj.sourceUrl;
  if (v == null) return null;
  return normalizeExternalUrl(String(v));
}

function normalizeSources(citations: NewRagResponse["citations"]): QwenKbSource[] {
  const isDev = process.env.NODE_ENV === "development";
  const seen = new Set<number>();
  const result: QwenKbSource[] = [];
  const debugRows: CitationUrlDebugRow[] = [];
  for (const raw of citations || []) {
    const item = raw as Record<string, unknown>;
    const id = parseRefIdToNumber(item.ref_id as string | undefined);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const lawName = pickStr(item, "law_name", "lawName");
    const lawType = pickStr(item, "law_type", "lawType");
    const effectiveStatus = pickStr(item, "effective_status", "effectiveStatus");
    const publishDate = pickStr(item, "publish_date", "publishDate");
    const effectiveDate = pickStr(item, "effective_date", "effectiveDate");
    const chapter = pickStr(item, "chapter");
    const article = pickStr(item, "article");
    const body = pickStr(item, "text");
    const text =
      body !== "未提供"
        ? body
        : [lawName, article].filter((s) => s && s !== "未提供").join(" · ") || "未提供";
    const refRaw = item.ref_id != null ? String(item.ref_id).trim() : "";
    const refId = refRaw || `[${id}]`;
    const uv = item.source_url ?? item.sourceUrl;
    const urlApiRaw = uv == null ? null : String(uv);
    const urlTrimOnly = uv == null ? null : (() => {
      const t = String(uv).trim();
      return t ? t : null;
    })();
    const urlNormalized = pickUrl(item);
    if (isDev) {
      debugRows.push({
        id,
        refIdRaw: item.ref_id != null ? String(item.ref_id) : "",
        law: lawName,
        chapterArticle: chapterArticleFromParts(chapter, article),
        urlApiRaw,
        urlTrimOnly,
        urlNormalized,
      });
    }
    result.push({
      id,
      refId,
      lawName,
      lawType,
      effectiveStatus,
      publishDate,
      effectiveDate,
      chapter,
      article,
      text,
      sourceUrl: urlNormalized,
      score: typeof item.score === "number" ? item.score : undefined,
    });
  }
  if (isDev && debugRows.length > 0) {
    debugRows.sort((a, b) => a.id - b.id);
    debugLogCitationUrls("normalizeSources(answer.citations)", debugRows);
  }
  return result.sort((a, b) => a.id - b.id);
}

function deriveLastQuestionFromMessages(messages: ChatItem[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function deriveLastMetaFromMessages(messages: ChatItem[]): { model: string; retrievedCount: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.answerCard) {
      const ac = m.answerCard;
      const rcRaw = ac.retrievedCount ?? ac.sources?.length ?? 0;
      const rc = typeof rcRaw === "number" && Number.isFinite(rcRaw) ? rcRaw : 0;
      return { model: ac.modelName, retrievedCount: rc };
    }
  }
  return null;
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export default function NewFeatureChatPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState<{ id: string; username: string; display_name: string } | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "ready" | "denied">("checking");
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingEvents, setStreamingEvents] = useState<RagProcessEvent[]>([]);
  const [lastMeta, setLastMeta] = useState<{ model: string; retrievedCount: number } | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionSidebarCollapsed, setSessionSidebarCollapsed] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<QwenKbSource | null>(null);
  const [selectedCitationIndex, setSelectedCitationIndex] = useState<number | null>(null);
  const [citationSidebarOpen, setCitationSidebarOpen] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);

  const closeCitationSidebar = useCallback(() => {
    setCitationSidebarOpen(false);
    setSelectedCitation(null);
    setSelectedCitationIndex(null);
  }, []);
  const activeSessionIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentGenerationIdRef = useRef(0);
  const generationSessionIdRef = useRef<string | null>(null);
  const streamingDraftAccumulatorRef = useRef("");
  const inflightAnswerAttachedRef = useRef(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** 为 false 避免会话初次加载时强行滚到底；发送新问题时置 true */
  const shouldAutoScrollRef = useRef(false);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!citationSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCitationSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [citationSidebarOpen, closeCitationSidebar]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (!me) {
          setMessages([]);
          setAuthStatus("denied");
          router.replace("/login");
          return;
        }
        setAuthUser(me);
        setAuthStatus("ready");
      } catch {
        if (cancelled) return;
        setMessages([]);
        setAuthStatus("denied");
        router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (authStatus !== "ready") return;
    let cancelled = false;

    void (async () => {
      try {
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(LEGACY_CHAT_SESSIONS_STORAGE_KEY);
          } catch {
            /* ignore */
          }
        }

        let list = await apiListSessions();
        if (cancelled) return;

        const applyDetail = async (sessionId: string) => {
          const { session, messages } = await apiGetSessionMessages(sessionId);
          if (cancelled) return;
          persistActiveSessionId(session.id);
          activeSessionIdRef.current = session.id;
          setActiveSessionId(session.id);
          setMessages(messages);
          setLastQuestion(deriveLastQuestionFromMessages(messages));
          setLastMeta(deriveLastMetaFromMessages(messages));
        };

        const createFresh = async () => {
          const created = await apiCreateSession();
          if (cancelled) return;
          persistActiveSessionId(created.id);
          activeSessionIdRef.current = created.id;
          setActiveSessionId(created.id);
          setMessages([]);
          setLastQuestion("");
          setLastMeta(null);
        };

        const storedActive = getActiveSessionId();
        const preferred =
          storedActive != null && list.some((s) => s.id === storedActive) ? storedActive : null;

        try {
          if (preferred != null) {
            try {
              await applyDetail(preferred);
            } catch (e) {
              if (isChatApiUnauthorized(e)) throw e;
              list = await apiListSessions();
              if (cancelled) return;
              if (list.length > 0) {
                await applyDetail(list[0].id);
              } else {
                await createFresh();
              }
            }
          } else if (list.length > 0) {
            await applyDetail(list[0].id);
          } else {
            await createFresh();
          }
        } catch (e) {
          if (isChatApiUnauthorized(e)) throw e;
          await createFresh();
        }

        list = await apiListSessions();
        if (cancelled) return;
        setSessions(list);
      } catch (e) {
        if (cancelled) return;
        if (isChatApiUnauthorized(e)) {
          router.replace("/login");
          return;
        }
        setSessions([]);
        setMessages([]);
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authStatus, router]);

  const refreshSessionsList = useCallback(async () => {
    try {
      const list = await apiListSessions();
      setSessions(list);
    } catch (e) {
      if (isChatApiUnauthorized(e)) router.replace("/login");
    }
  }, [router]);

  const stopGeneration = useCallback((opts?: { persistDraft?: boolean }) => {
    const persistDraft = opts?.persistDraft !== false;

    const sessionForDraft = generationSessionIdRef.current;
    const draftFull = streamingDraftAccumulatorRef.current.trim();
    const hadAnswer = inflightAnswerAttachedRef.current;

    currentGenerationIdRef.current += 1;

    const ac = abortControllerRef.current;
    if (ac) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
      abortControllerRef.current = null;
    }

    generationSessionIdRef.current = null;
    streamingDraftAccumulatorRef.current = "";
    inflightAnswerAttachedRef.current = false;

    if (persistDraft && sessionForDraft && draftFull && !hadAnswer) {
      const msg: ChatItem = {
        id: `a_stop_${Date.now()}`,
        role: "assistant",
        content: `${draftFull}\n\n（已停止生成，以上内容可能不完整。）`,
        createdAt: new Date().toISOString(),
      };
      if (activeSessionIdRef.current === sessionForDraft) {
        setMessages((prev) => [...prev, msg]);
      }
      void (async () => {
        try {
          await apiAppendMessage(sessionForDraft, {
            role: "assistant",
            content: msg.content,
            created_at: msg.createdAt,
          });
          await refreshSessionsList();
        } catch (e) {
          if (isChatApiUnauthorized(e)) router.replace("/login");
        }
      })();
    }

    setLoading(false);
    setStreamingEvents([]);
    void refreshSessionsList();
  }, [refreshSessionsList, router]);

  const handleLogout = useCallback(async () => {
    closeCitationSidebar();
    stopGeneration({ persistDraft: false });
    setMessages([]);
    setInput("");
    setStreamingEvents([]);
    setLastMeta(null);
    setLastQuestion("");
    setSessions([]);
    setActiveSessionId(null);
    persistActiveSessionId(null);
    activeSessionIdRef.current = null;
    setSessionReady(false);
    setAuthUser(null);
    setMobileSessionsOpen(false);
    setCitationSidebarOpen(false);
    setSelectedCitation(null);
    setSelectedCitationIndex(null);
    try {
      await logoutRequest();
    } catch {
      /* 仍跳转登录页 */
    }
    router.replace("/login");
  }, [router, stopGeneration, closeCitationSidebar]);

  const handleNewSession = useCallback(() => {
    closeCitationSidebar();
    if (loading) {
      stopGeneration({ persistDraft: true });
    }
    void (async () => {
      try {
        const created = await apiCreateSession();
        persistActiveSessionId(created.id);
        activeSessionIdRef.current = created.id;
        setActiveSessionId(created.id);
        setMessages([]);
        setInput("");
        setStreamingEvents([]);
        setLastMeta(null);
        setLastQuestion("");
        await refreshSessionsList();
      } catch (e) {
        if (isChatApiUnauthorized(e)) router.replace("/login");
      }
    })();
  }, [loading, stopGeneration, closeCitationSidebar, refreshSessionsList, router]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      closeCitationSidebar();
      if (loading) {
        stopGeneration({ persistDraft: true });
      }
      void (async () => {
        try {
          const { session, messages } = await apiGetSessionMessages(sessionId);
          persistActiveSessionId(session.id);
          activeSessionIdRef.current = session.id;
          setActiveSessionId(session.id);
          setMessages(messages);
          setStreamingEvents([]);
          setInput("");
          setLastQuestion(deriveLastQuestionFromMessages(messages));
          setLastMeta(deriveLastMetaFromMessages(messages));
          await refreshSessionsList();
        } catch (e) {
          if (isChatApiUnauthorized(e)) {
            router.replace("/login");
            return;
          }
          try {
            let list = await apiListSessions();
            if (list.length > 0) {
              const first = await apiGetSessionMessages(list[0].id);
              persistActiveSessionId(first.session.id);
              activeSessionIdRef.current = first.session.id;
              setActiveSessionId(first.session.id);
              setMessages(first.messages);
              setStreamingEvents([]);
              setInput("");
              setLastQuestion(deriveLastQuestionFromMessages(first.messages));
              setLastMeta(deriveLastMetaFromMessages(first.messages));
            } else {
              const created = await apiCreateSession();
              persistActiveSessionId(created.id);
              activeSessionIdRef.current = created.id;
              setActiveSessionId(created.id);
              setMessages([]);
              setLastQuestion("");
              setLastMeta(null);
            }
            list = await apiListSessions();
            setSessions(list);
          } catch {
            router.replace("/login");
          }
        }
      })();
    },
    [loading, stopGeneration, closeCitationSidebar, refreshSessionsList, router],
  );

  const handleSelectSessionMobile = useCallback(
    (sessionId: string) => {
      handleSelectSession(sessionId);
      setMobileSessionsOpen(false);
    },
    [handleSelectSession],
  );

  const toggleSessionSidebarCollapsed = useCallback(() => {
    setSessionSidebarCollapsed((c) => !c);
  }, []);

  const openCitationDetail = useCallback((source: QwenKbSource, index: number) => {
    setSelectedCitation(source);
    setSelectedCitationIndex(index);
    setCitationSidebarOpen(true);
  }, []);

  const emptyHint = useMemo(() => "示例：竞业限制协议最多约定几年？", []);

  const topStatusBarLabel = useMemo(() => {
    const modelHint = lastMeta?.model ?? DEFAULT_STREAM_MODEL_NAME;
    if (loading) return `模型：${modelHint} · 正在检索`;
    if (lastMeta) return `模型：${lastMeta.model} · 检索片段：${lastMeta.retrievedCount}`;
    return `模型：${DEFAULT_STREAM_MODEL_NAME} · 等待提问`;
  }, [lastMeta, loading]);

  const streamingAnswerDraft = useMemo(() => {
    let acc = "";
    for (const e of streamingEvents) {
      if (e.type === "answer_delta" || e.stage === "answer_delta") {
        const d = e.data as Record<string, unknown> | undefined;
        if (d && d.delta != null) acc += String(d.delta);
      }
    }
    return acc;
  }, [streamingEvents]);

  const streamingKbSources = useMemo(() => kbSourcesFromRagEvents(streamingEvents), [streamingEvents]);

  const streamingNormalizedAnswer = useMemo(
    () => normalizeAnswer(streamingAnswerDraft),
    [streamingAnswerDraft],
  );

  const onMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > AUTO_SCROLL_PAUSE_BELOW_PX) {
      shouldAutoScrollRef.current = false;
    } else if (distanceFromBottom < AUTO_SCROLL_RESUME_BELOW_PX) {
      shouldAutoScrollRef.current = true;
    }
  }, []);

  const scrollMessagesToBottomIfPinned = useCallback(() => {
    if (!shouldAutoScrollRef.current) return;
    const el = messagesScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      if (!shouldAutoScrollRef.current) return;
      const box = messagesScrollRef.current;
      if (!box) return;
      box.scrollTop = box.scrollHeight;
    });
  }, []);

  useEffect(() => {
    scrollMessagesToBottomIfPinned();
  }, [messages, streamingEvents, streamingAnswerDraft, scrollMessagesToBottomIfPinned]);

  /** answer 已写入 messages 后不再展示底部加载区，避免与消息内 ProcessTimeline 重复 */
  const streamHasAnswer = useMemo(
    () => streamingEvents.some((e) => e.type === "answer"),
    [streamingEvents],
  );

  const persistAssistantMessage = useCallback(
    async (sessionId: string, msg: ChatItem) => {
      try {
        const saved = await apiAppendMessage(sessionId, {
          role: "assistant",
          content: msg.content,
          answer_card: msg.answerCard ?? null,
          process_events: msg.processEvents ?? null,
          created_at: msg.createdAt ?? null,
        });
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], id: saved.id };
          return next;
        });
        await refreshSessionsList();
      } catch (e) {
        if (isChatApiUnauthorized(e)) router.replace("/login");
      }
    },
    [refreshSessionsList, router],
  );

  const send = async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading || !sessionReady) return;

    const sessionIdAtStart = activeSessionIdRef.current;
    if (!sessionIdAtStart) return;

    closeCitationSidebar();

    shouldAutoScrollRef.current = true;

    /** 本轮尚未写入 messages；取当前会话最近 6 条作为历史，且不包含当前 question */
    const conversation_history = buildConversationHistoryForAskStream(
      messages.slice(-MAX_HISTORY_MESSAGES),
    );

    const myGenerationId = ++currentGenerationIdRef.current;
    generationSessionIdRef.current = sessionIdAtStart;
    streamingDraftAccumulatorRef.current = "";
    inflightAnswerAttachedRef.current = false;

    const ac = new AbortController();
    abortControllerRef.current = ac;

    const nowIso = new Date().toISOString();
    const userMsg: ChatItem = {
      id: `u_${Date.now()}`,
      role: "user",
      content: question,
      createdAt: nowIso,
    };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const savedUser = await apiAppendMessage(sessionIdAtStart, {
        role: "user",
        content: question,
        created_at: userMsg.createdAt,
      });
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "user") next[next.length - 1] = { ...last, id: savedUser.id };
        return next;
      });
    } catch (e) {
      if (isChatApiUnauthorized(e)) {
        router.replace("/login");
        setLoading(false);
        return;
      }
      setMessages((prev) => prev.slice(0, -1));
      setLoading(false);
      return;
    }

    try {
      const listAfter = await apiListSessions();
      const meta = listAfter.find((s) => s.id === sessionIdAtStart);
      if (meta && (meta.title === "新对话" || !String(meta.title ?? "").trim())) {
        await apiPatchSessionTitle(sessionIdAtStart, generateSessionTitle(question));
      }
      await refreshSessionsList();
    } catch (e) {
      if (isChatApiUnauthorized(e)) router.replace("/login");
    }

    if (!overrideQuestion) {
      setInput("");
    }
    setLastQuestion(question);
    setLoading(true);
    setStreamingEvents([]);

    const streamed: RagProcessEvent[] = [];
    let answerAttached = false;

    const pushEvent = (ev: RagProcessEvent) => {
      if (myGenerationId !== currentGenerationIdRef.current) {
        return "stale" as const;
      }
      if (ev.type === "answer_delta" || ev.stage === "answer_delta") {
        const d = ev.data as Record<string, unknown> | undefined;
        if (d && d.delta != null) {
          streamingDraftAccumulatorRef.current += String(d.delta);
        }
      }
      streamed.push(ev);
      setStreamingEvents([...streamed]);
      if (ev.type === "error") {
        const detail = (ev.message && ev.message.slice(0, 300)) || "流式处理失败";
        const errMsg: ChatItem = {
          id: `a_err_${Date.now()}`,
          role: "assistant",
          content: `调用失败：${detail}`,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
        void persistAssistantMessage(sessionIdAtStart, errMsg);
        return "error" as const;
      }
      if (ev.type === "answer" && !answerAttached && ev.data && typeof ev.data === "object") {
        answerAttached = true;
        inflightAnswerAttachedRef.current = true;
        const d = ev.data as Record<string, unknown>;
        const serverAns = String(d.answer ?? "").trim();
        const streamedAns = streamingDraftAccumulatorRef.current.trim();
        const finalAnswerText = streamedAns || serverAns;
        const model = String(d.model ?? DEFAULT_STREAM_MODEL_NAME);
        const rc = Number(d.retrieved_count ?? 0);
        const citations = (Array.isArray(d.citations) ? d.citations : []) as NewRagCitation[];
        // 保留 analysis_delta；排除 answer_delta 以减小落库体积（最终 answer 含 citations）
        const processSnapshot = streamed.filter(
          (e) =>
            e.type !== "done" &&
            e.type !== "error" &&
            e.type !== "answer" &&
            e.type !== "answer_delta",
        );
        const normalizedAnswer = normalizeAnswer(finalAnswerText);
        const normalizedSources = normalizeSources(citations);
        const retrievedCount = Number.isFinite(rc) ? rc : 0;
        const assistantMsg: ChatItem = {
          id: `a_${Date.now()}`,
          role: "assistant",
          content: finalAnswerText || serverAns || "未获取到回答",
          createdAt: new Date().toISOString(),
          processEvents: processSnapshot.length > 0 ? processSnapshot : undefined,
          answerCard: {
            answer: normalizedAnswer,
            sources: normalizedSources,
            question,
            modelName: model,
            retrievedCount,
          },
        };
        setMessages((prev) => [...prev, assistantMsg]);
        void persistAssistantMessage(sessionIdAtStart, assistantMsg);
        setLastMeta({ model, retrievedCount });
      }
      return "continue" as const;
    };

    const consumeNdjsonLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const ev = JSON.parse(trimmed) as RagProcessEvent;
        const r = pushEvent(ev);
        if (r === "error") {
          return "error" as const;
        }
      } catch {
        /* 忽略无法解析的行，不展示异常栈 */
      }
      return "continue" as const;
    };

    try {
      const resp = await fetch(`${getApiBaseUrl()}/new-rag/ask-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ question, conversation_history }),
        signal: ac.signal,
        credentials: "include",
      });
      if (resp.status === 401) {
        setMessages([]);
        router.replace("/login");
        setLoading(false);
        setStreamingEvents([]);
        return;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text ? text.slice(0, 500) : `HTTP ${resp.status}`);
      }
      const body = resp.body;
      if (!body) {
        throw new Error("响应体不可读");
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const r = consumeNdjsonLine(part);
          if (r === "error") {
            if (myGenerationId === currentGenerationIdRef.current) {
              setLoading(false);
              setStreamingEvents([]);
            }
            return;
          }
        }
      }
      if (buffer.trim()) {
        const r = consumeNdjsonLine(buffer);
        if (r === "error") {
          if (myGenerationId === currentGenerationIdRef.current) {
            setLoading(false);
            setStreamingEvents([]);
          }
          return;
        }
      }
      if (!answerAttached && myGenerationId === currentGenerationIdRef.current) {
        const incompleteMsg: ChatItem = {
          id: `a_err_${Date.now()}`,
          role: "assistant",
          content: "调用失败：未收到完整回答（流已结束）。",
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, incompleteMsg]);
        void persistAssistantMessage(sessionIdAtStart, incompleteMsg);
      }
    } catch (error) {
      if (isAbortLikeError(error)) {
        /* 用户停止或会话切换触发的中止，不展示调用失败 */
      } else if (myGenerationId === currentGenerationIdRef.current) {
        const msg = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        const failMsg: ChatItem = {
          id: `a_err_${Date.now()}`,
          role: "assistant",
          content: `调用失败：${msg}`,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, failMsg]);
        void persistAssistantMessage(sessionIdAtStart, failMsg);
      }
    } finally {
      if (abortControllerRef.current === ac) {
        abortControllerRef.current = null;
      }
      if (myGenerationId !== currentGenerationIdRef.current) {
        return;
      }
      generationSessionIdRef.current = null;
      streamingDraftAccumulatorRef.current = "";
      inflightAnswerAttachedRef.current = false;
      setLoading(false);
      setStreamingEvents([]);
    }
  };

  const chatContentMaxClass = sessionSidebarCollapsed ? "max-w-[1200px]" : "max-w-6xl";
  const assistantColMaxClass = sessionSidebarCollapsed
    ? "max-w-[min(100%,72rem)]"
    : "max-w-[min(100%,52rem)]";
  const userBubbleMaxClass = sessionSidebarCollapsed ? "max-w-[min(76%,44rem)]" : "max-w-[70%]";
  const composerMaxClass = sessionSidebarCollapsed ? "max-w-[860px]" : "max-w-[760px]";

  if (authStatus === "checking") {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[var(--app-bg)] text-[var(--app-text-muted)]">
        <p className="text-sm">验证登录…</p>
      </div>
    );
  }
  if (authStatus === "denied") {
    return null;
  }

  if (authStatus === "ready" && !sessionReady) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[var(--app-bg)] text-[var(--app-text-muted)]">
        <p className="text-sm">加载会话…</p>
      </div>
    );
  }

  return (
    <>
      {mobileSessionsOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="关闭历史对话"
            onClick={() => setMobileSessionsOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-[min(280px,85vw)] min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-surface)] shadow-xl">
            <div className="flex shrink-0 items-center justify-end border-b border-[var(--app-border)] px-2 py-2">
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-lg text-[var(--app-text-muted)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]"
                aria-label="关闭"
                onClick={() => setMobileSessionsOpen(false)}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatSessionSidebar
                sessions={sessions}
                activeSessionId={activeSessionId}
                loading={loading}
                loadingInteractionHint={loading ? "切换将停止当前生成" : undefined}
                onNewSession={handleNewSession}
                onSelectSession={handleSelectSessionMobile}
                collapsed={false}
                onToggleCollapsed={() => setMobileSessionsOpen(false)}
                showCollapseToggle={false}
              />
            </div>
          </aside>
        </div>
      ) : null}

      <div className="flex h-full min-h-0 min-w-0 w-full overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)]">
        <aside
          className={`hidden h-full min-h-0 shrink-0 overflow-hidden border-r border-[var(--app-border)] bg-[var(--app-surface)] transition-[width] duration-200 ease-out md:flex ${
            sessionSidebarCollapsed ? "w-16" : "w-[280px]"
          }`}
        >
          <ChatSessionSidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={loading}
            loadingInteractionHint={loading ? "切换将停止当前生成" : undefined}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
            collapsed={sessionSidebarCollapsed}
            onToggleCollapsed={toggleSessionSidebarCollapsed}
          />
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-surface)]/95 px-3 py-2 md:hidden">
            <button
              type="button"
              title={loading ? "切换将停止当前生成" : undefined}
              onClick={() => setMobileSessionsOpen(true)}
              className="shrink-0 rounded-xl border border-[var(--app-border)] bg-white/90 px-3 py-2 text-xs font-medium text-[var(--app-text)] shadow-[var(--app-shadow-sm)] transition hover:bg-[var(--app-surface-muted)]"
            >
              历史
            </button>
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-1 text-center">
              <span className="block text-sm font-semibold text-[var(--app-text)]">对话</span>
              <span
                className="mt-0.5 block max-w-full truncate text-[10px] text-[var(--app-text-muted)]"
                title={authUser?.display_name}
              >
                {authUser?.display_name ?? ""}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                title="退出登录"
                onClick={() => void handleLogout()}
                className="inline-flex size-9 items-center justify-center rounded-xl border border-[var(--app-border)] bg-white/90 text-[var(--app-text-muted)] shadow-[var(--app-shadow-sm)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]"
              >
                <LogOut className="size-4 shrink-0" aria-hidden />
              </button>
              <button
                type="button"
                title={loading ? "切换将停止当前生成" : undefined}
                disabled={!sessionReady}
                onClick={handleNewSession}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-3 py-2 text-xs font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <MessageSquarePlus className="size-3.5 shrink-0" aria-hidden />
                新对话
              </button>
            </div>
          </div>

          <div
            className={cn(
              "mx-auto flex min-h-10 w-full shrink-0 items-center gap-2 px-5 py-2 md:px-8",
              "justify-end lg:justify-between",
              chatContentMaxClass,
            )}
          >
            <button
              type="button"
              className="hidden shrink-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)]/90 px-2.5 py-1 text-[11px] font-medium text-[var(--app-text-muted)] shadow-[var(--app-shadow-sm)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)] lg:inline-flex"
              aria-expanded={citationSidebarOpen}
              aria-controls="citation-detail-sidebar"
              onClick={() => {
                if (citationSidebarOpen) closeCitationSidebar();
                else setCitationSidebarOpen(true);
              }}
            >
              {citationSidebarOpen ? "收起引用栏" : "引用详情"}
            </button>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2" title={topStatusBarLabel}>
              <span
                className="hidden max-w-[10rem] truncate text-[11px] text-[var(--app-text-muted)] lg:inline"
                title={authUser?.display_name}
              >
                {authUser?.display_name ?? ""}
              </span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="hidden shrink-0 items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)]/90 px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] shadow-[var(--app-shadow-sm)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)] lg:inline-flex"
              >
                <LogOut className="size-3.5 shrink-0" aria-hidden />
                退出
              </button>
              <span className="max-w-full truncate rounded-full border border-[var(--app-border)] bg-[var(--app-surface)]/90 px-2.5 py-0.5 text-[11px] leading-tight text-[var(--app-text-muted)]">
                {topStatusBarLabel}
              </span>
            </div>
          </div>

          <div
            ref={messagesScrollRef}
            onScroll={onMessagesScroll}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-pb-4"
          >
            <div className={cn("mx-auto w-full px-5 pb-4 pt-1 md:px-8", chatContentMaxClass)}>
              <div className="space-y-8 pb-2 pt-1">
                {messages.length === 0 ? (
                  <div className="space-y-2 rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4">
                    <p className="text-xs leading-relaxed text-[var(--app-text-muted)]">
                      输入法律问题，我会先检索知识库，再基于有效法条回答。
                    </p>
                    <p className="text-sm text-[var(--app-text-muted)]">{emptyHint}</p>
                  </div>
                ) : null}
                {messages.map((m) => {
                  const assistantWithCard = m.role === "assistant" && m.answerCard;
                  const answerCard = m.answerCard;
                  return (
                    <div
                      key={m.id}
                      className={`flex min-w-0 items-start gap-3 ${m.role === "user" ? "justify-end" : ""}`}
                    >
                      {m.role === "assistant" ? (
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                          <Bot className="size-4" />
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          m.role === "user"
                            ? "min-w-0 rounded-[20px] bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-4 py-3 text-sm font-normal leading-7 text-white shadow-[var(--app-shadow-sm)]"
                            : assistantWithCard
                              ? "min-w-0 w-full flex-1 space-y-3 text-[var(--app-text)]"
                              : "min-w-0 flex-1 rounded-[20px] border border-[var(--app-border)] bg-white/95 px-4 py-3 text-sm leading-7 text-[var(--app-text)] shadow-[var(--app-shadow-sm)]",
                          m.role === "user" ? userBubbleMaxClass : assistantColMaxClass,
                        )}
                      >
                        {assistantWithCard && answerCard ? (
                          <div className="space-y-3">
                            {m.processEvents && m.processEvents.length > 0 ? (
                              <ProcessTimeline events={m.processEvents} defaultOpen={false} />
                            ) : null}
                            <QwenKbAnswerCard
                              answer={answerCard.answer}
                              sources={answerCard.sources}
                              question={answerCard.question}
                              modelName={answerCard.modelName}
                              onRegenerate={() => void send(answerCard.question || lastQuestion)}
                              onCopy={() => {
                                // reserved for analytics hook
                              }}
                              onFeedback={() => {
                                // reserved for feedback API hook
                              }}
                              onCitationClick={openCitationDetail}
                              onSourceClick={openCitationDetail}
                            />
                          </div>
                        ) : (
                          m.content
                        )}
                      </div>
                      {m.role === "user" ? (
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                          <User className="size-4" />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {loading && !streamHasAnswer ? (
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                      <Bot className="size-4" />
                    </div>
                    <div className={cn("min-w-0 w-full flex-1 space-y-3 text-[var(--app-text)]", assistantColMaxClass)}>
                      {streamingEvents.length === 0 ? (
                        <p className="text-xs text-[var(--app-text-subtle)]">正在连接流式服务…</p>
                      ) : null}
                      {streamingEvents.length > 0 ? (
                        <ProcessTimeline events={streamingEvents} defaultOpen={true} />
                      ) : null}
                      {streamingAnswerDraft.trim() ? (
                        <QwenKbAnswerCard
                          answer={streamingNormalizedAnswer}
                          sources={streamingKbSources}
                          question={lastQuestion}
                          modelName={lastMeta?.model ?? DEFAULT_STREAM_MODEL_NAME}
                          pending
                          onRegenerate={() => void send(lastQuestion)}
                          onCopy={() => {
                            // reserved for analytics hook
                          }}
                          onFeedback={() => {
                            // reserved for feedback API hook
                          }}
                          onCitationClick={openCitationDetail}
                          onSourceClick={openCitationDetail}
                        />
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="shrink-0 bg-transparent px-3 pt-2 pb-5 md:px-4">
            <div
              className={cn(
                "mx-auto flex w-full min-w-0 items-end gap-2 rounded-[28px] border border-[var(--app-border)] bg-white p-2.5 shadow-[0_12px_40px_-12px_rgba(16,24,40,0.14)] dark:bg-[var(--app-surface)]",
                composerMaxClass,
              )}
            >
              <textarea
                className="min-h-12 max-h-48 min-w-0 flex-1 resize-y rounded-2xl border-0 bg-transparent px-2.5 py-2 text-sm leading-relaxed text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] outline-none focus:outline-none focus:ring-0"
                placeholder="输入问题，回车发送（Shift+Enter 换行）"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (loading) return;
                    void send();
                  }
                }}
              />
              <button
                type="button"
                disabled={!loading && (!input.trim() || !sessionReady)}
                aria-label={loading ? "停止生成" : "发送"}
                title={loading ? "停止生成" : "发送"}
                onClick={() => {
                  if (loading) {
                    stopGeneration({ persistDraft: true });
                  } else {
                    void send();
                  }
                }}
                className={cn(
                  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-[var(--app-shadow-sm)] transition",
                  loading
                    ? "border border-[var(--app-border)] bg-[var(--app-surface-muted)] text-[var(--app-text)] hover:bg-[var(--app-surface)]"
                    : "bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45",
                )}
              >
                {loading ? (
                  <Square className="size-4 shrink-0 fill-current" aria-hidden />
                ) : (
                  <Send className="size-4 shrink-0" aria-hidden />
                )}
              </button>
            </div>
          </div>
        </main>

        <aside
          id="citation-detail-sidebar"
          aria-hidden={!citationSidebarOpen}
          className={cn(
            "hidden h-full min-h-0 shrink-0 overflow-hidden border-[var(--app-border)] bg-white transition-[width] duration-200 ease-out dark:bg-[var(--app-surface)] lg:flex lg:flex-col",
            citationSidebarOpen ? "w-[380px] border-l" : "w-0 border-l-0",
          )}
        >
          {citationSidebarOpen ? (
            <CitationSidePanel
              open={citationSidebarOpen}
              onClose={closeCitationSidebar}
              source={selectedCitation}
              citationIndex={selectedCitationIndex}
            />
          ) : null}
        </aside>
      </div>
    </>
  );
}
