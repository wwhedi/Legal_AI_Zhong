"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, MessageSquarePlus, Send, User, X } from "lucide-react";
import {
  PLACEHOLDER_BASIS,
  PLACEHOLDER_RISK,
  PLACEHOLDER_SUGGESTION,
  QwenKbAnswerCard,
  type QwenAnswer,
} from "@/components/chat/QwenKbAnswerCard";
import { ChatSessionSidebar } from "@/components/chat/ChatSessionSidebar";
import { ProcessTimeline } from "@/components/chat/ProcessTimeline";
import { StreamingAnswerDraft } from "@/components/chat/StreamingAnswerDraft";
import {
  createChatSession,
  generateSessionTitle,
  getActiveSessionId,
  getChatSessions,
  saveChatSessions,
  setActiveSessionId as persistActiveSessionId,
  updateChatSession,
} from "@/lib/chat-sessions";
import { cn } from "@/lib/utils";
import type { ChatItem, ChatSession, QwenKbSource, RagProcessEvent } from "@/types";

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

const DEFAULT_BASE_URL = "http://localhost:8000";

function getApiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

function parseRefIdToNumber(refId?: string): number | null {
  const raw = String(refId ?? "").trim();
  const m = /^\[(\d+)\]$/.exec(raw) || /^(\d+)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

type SectionKind = "conclusion" | "basis" | "risks" | "actionAdvice" | "actionSteps";

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
  kind: "basis" | "risks" | "actionAdvice" | "actionSteps",
): { head: string; tail: string } {
  const patterns: Record<typeof kind, RegExp[]> = {
    basis: [
      /(?<![0-9０-９])(?:(?:[5５]\s*(?:[)）]|[、,，]|[.．])\s*|[五]\s*[、,，.]\s*|5\s*\.)\s*)法律依据\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)依据\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)(?:引用依据|相关依据)\s*[：:]?\s*/,
    ],
    risks: [
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险提示\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)主要风险\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)注意风险\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险点\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)风险(?![点示])\s*[：:]?\s*/,
    ],
    actionAdvice: [
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)你现在最该做\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[2２]\s*(?:[)）]|[、,，]|[.．])\s*|[二]\s*[、,，.]\s*|2\s*\.)\s*)现在最该做\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)建议\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)建议\s*[：:]?\s*/,
    ],
    actionSteps: [
      /(?<![0-9０-９])(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)可执行操作步骤\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[4４]\s*(?:[)）]|[、,，]|[.．])\s*|[四]\s*[、,，.]\s*|4\s*\.)\s*)(?:操作步骤|办理步骤|处理步骤|执行步骤|流程步骤)\s*[：:]?\s*/,
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
    const riskHead = /^(?:风险点|风险|风险提示)\s*[：:]/.test(t);
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
  kinds: Array<"basis" | "risks" | "actionAdvice" | "actionSteps">,
  parts: { basis: string; risks: string; actionAdvice: string; actionSteps: string },
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
      if (rule.friendly || rule.kind === "actionSteps") sawFriendlyDetailTitles = true;
      mode = rule.kind;
      if (rest) buckets[rule.kind].push(rest);
      continue;
    }
    buckets[mode].push(line);
  }

  let conclusion = buckets.conclusion.join("\n").trim();
  let basis = buckets.basis.join("\n").trim();
  let risks = buckets.risks.join("\n").trim();
  let actionAdvice = buckets.actionAdvice.join("\n").trim();
  let actionSteps = buckets.actionSteps.join("\n").trim();

  const parts = { basis, risks, actionAdvice, actionSteps };
  conclusion = applyPeelChain(conclusion, ["basis", "risks", "actionAdvice", "actionSteps"], parts);
  parts.basis = applyPeelChain(parts.basis, ["risks", "actionAdvice", "actionSteps"], parts);
  parts.risks = applyPeelChain(parts.risks, ["actionAdvice", "actionSteps"], parts);
  parts.actionAdvice = applyPeelChain(parts.actionAdvice, ["actionSteps"], parts);
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
    !textHasAnySectionHeader(text) && !basis.trim() && !risks.trim() && !actionAdvice.trim() && !actionSteps.trim();

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
  const d1 = sawFriendlyDetailTitles ? "风险提示" : "风险点";
  const d2 = sawFriendlyDetailTitles ? "你现在最该做" : "建议";

  return {
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
  const s = String(v).trim();
  return s ? s : null;
}

function normalizeSources(citations: NewRagResponse["citations"]): QwenKbSource[] {
  const seen = new Set<number>();
  const result: QwenKbSource[] = [];
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
      sourceUrl: pickUrl(item),
      score: typeof item.score === "number" ? item.score : undefined,
    });
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

export default function NewFeatureChatPage() {
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
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const stored = getChatSessions();
    const activeId = getActiveSessionId();
    const session = activeId ? stored.find((s) => s.id === activeId) : undefined;

    if (session) {
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setMessages(session.messages);
      setLastQuestion(deriveLastQuestionFromMessages(session.messages));
      setLastMeta(deriveLastMetaFromMessages(session.messages));
    } else {
      const newSess = createChatSession("新对话");
      saveChatSessions([newSess, ...stored]);
      persistActiveSessionId(newSess.id);
      activeSessionIdRef.current = newSess.id;
      setActiveSessionId(newSess.id);
      setMessages([]);
      setLastQuestion("");
      setLastMeta(null);
    }
    setSessions(getChatSessions());
    setSessionReady(true);
  }, []);

  const refreshSessionsList = useCallback(() => {
    setSessions(getChatSessions());
  }, []);

  const handleNewSession = useCallback(() => {
    if (loading) return;
    const newSess = createChatSession("新对话");
    const rest = getChatSessions();
    saveChatSessions([newSess, ...rest]);
    persistActiveSessionId(newSess.id);
    activeSessionIdRef.current = newSess.id;
    setActiveSessionId(newSess.id);
    setMessages([]);
    setInput("");
    setStreamingEvents([]);
    setLastMeta(null);
    setLastQuestion("");
    setSessions(getChatSessions());
  }, [loading]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (loading) return;
      const session = getChatSessions().find((s) => s.id === sessionId);
      if (!session) return;
      persistActiveSessionId(session.id);
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setMessages(session.messages);
      setStreamingEvents([]);
      setInput("");
      setLastQuestion(deriveLastQuestionFromMessages(session.messages));
      setLastMeta(deriveLastMetaFromMessages(session.messages));
    },
    [loading],
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

  const emptyHint = useMemo(() => "示例：竞业限制协议最多约定几年？", []);

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

  const answerGenerationLive = useMemo(
    () =>
      streamingEvents.some((e) => e.stage === "answer_generation_start") &&
      !streamingEvents.some((e) => e.type === "answer"),
    [streamingEvents],
  );

  const send = async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading || !sessionReady || !activeSessionIdRef.current) return;

    const nowIso = new Date().toISOString();
    const userMsg: ChatItem = {
      id: `u_${Date.now()}`,
      role: "user",
      content: question,
      createdAt: nowIso,
    };
    setMessages((prev) => {
      const next = [...prev, userMsg];
      const sid = activeSessionIdRef.current;
      if (sid) {
        const all = getChatSessions();
        const sess = all.find((s) => s.id === sid);
        const needTitle =
          sess != null && (sess.title === "新对话" || !String(sess.title ?? "").trim());
        updateChatSession(sid, {
          messages: next,
          ...(needTitle ? { title: generateSessionTitle(question) } : {}),
        });
      }
      return next;
    });
    queueMicrotask(refreshSessionsList);
    if (!overrideQuestion) {
      setInput("");
    }
    setLastQuestion(question);
    setLoading(true);
    setStreamingEvents([]);

    const streamed: RagProcessEvent[] = [];
    let answerAttached = false;

    const pushEvent = (ev: RagProcessEvent) => {
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
        setMessages((prev) => {
          const next = [...prev, errMsg];
          const sid = activeSessionIdRef.current;
          if (sid) {
            updateChatSession(sid, { messages: next });
          }
          return next;
        });
        queueMicrotask(refreshSessionsList);
        return "error" as const;
      }
      if (ev.type === "answer" && !answerAttached && ev.data && typeof ev.data === "object") {
        answerAttached = true;
        const d = ev.data as Record<string, unknown>;
        const ans = String(d.answer ?? "");
        const model = String(d.model ?? "qwen-plus");
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
        const normalizedAnswer = normalizeAnswer(ans);
        const normalizedSources = normalizeSources(citations);
        const retrievedCount = Number.isFinite(rc) ? rc : 0;
        const assistantMsg: ChatItem = {
          id: `a_${Date.now()}`,
          role: "assistant",
          content: ans || "未获取到回答",
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
        setMessages((prev) => {
          const next = [...prev, assistantMsg];
          const sid = activeSessionIdRef.current;
          if (sid) {
            updateChatSession(sid, { messages: next });
          }
          return next;
        });
        queueMicrotask(refreshSessionsList);
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
        body: JSON.stringify({ question }),
      });
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
            setLoading(false);
            setStreamingEvents([]);
            return;
          }
        }
      }
      if (buffer.trim()) {
        const r = consumeNdjsonLine(buffer);
        if (r === "error") {
          setLoading(false);
          setStreamingEvents([]);
          return;
        }
      }
      if (!answerAttached) {
        const incompleteMsg: ChatItem = {
          id: `a_err_${Date.now()}`,
          role: "assistant",
          content: "调用失败：未收到完整回答（流已结束）。",
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => {
          const next = [...prev, incompleteMsg];
          const sid = activeSessionIdRef.current;
          if (sid) {
            updateChatSession(sid, { messages: next });
          }
          return next;
        });
        queueMicrotask(refreshSessionsList);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const failMsg: ChatItem = {
        id: `a_err_${Date.now()}`,
        role: "assistant",
        content: `调用失败：${msg}`,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => {
        const next = [...prev, failMsg];
        const sid = activeSessionIdRef.current;
        if (sid) {
          updateChatSession(sid, { messages: next });
        }
        return next;
      });
      queueMicrotask(refreshSessionsList);
    } finally {
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
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
            collapsed={sessionSidebarCollapsed}
            onToggleCollapsed={toggleSessionSidebarCollapsed}
          />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-surface)]/95 px-3 py-2 md:hidden">
            <button
              type="button"
              disabled={loading}
              onClick={() => setMobileSessionsOpen(true)}
              className="shrink-0 rounded-xl border border-[var(--app-border)] bg-white/90 px-3 py-2 text-xs font-medium text-[var(--app-text)] shadow-[var(--app-shadow-sm)] transition hover:bg-[var(--app-surface-muted)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              历史
            </button>
            <span className="min-w-0 flex-1 text-center text-sm font-semibold text-[var(--app-text)]">对话</span>
            <button
              type="button"
              disabled={loading || !sessionReady}
              onClick={handleNewSession}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-3 py-2 text-xs font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <MessageSquarePlus className="size-3.5 shrink-0" aria-hidden />
              新对话
            </button>
          </div>

          <div
            className={cn(
              "mx-auto flex w-full shrink-0 items-center justify-between gap-4 px-5 py-4 md:px-8",
              chatContentMaxClass,
            )}
          >
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--app-text)]">
                Qwen + 阿里云知识库
              </h1>
              <p className="mt-1 text-xs text-[var(--app-text-muted)]">每次提问先检索知识库，再由 Qwen 生成答案</p>
            </div>
            {lastMeta ? (
              <div className="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-1.5 text-xs text-[var(--app-text-muted)] shadow-[var(--app-shadow-sm)]">
                模型：{lastMeta.model} · 检索片段：{lastMeta.retrievedCount}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-pb-4">
            <div className={cn("mx-auto w-full px-5 pb-4 pt-1 md:px-8", chatContentMaxClass)}>
              <div className="space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)]/90 p-5 shadow-[var(--app-shadow-sm)] backdrop-blur-sm">
                {messages.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-text-muted)]">
                    {emptyHint}
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
                              <ProcessTimeline events={m.processEvents} />
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
                {loading ? (
                  <div className="space-y-2 rounded-[20px] border border-[var(--app-border)] bg-white/85 p-3 shadow-[var(--app-shadow-sm)] backdrop-blur-sm">
                    {streamingEvents.length === 0 ? (
                      <p className="text-xs text-[var(--app-text-subtle)]">正在连接流式服务…</p>
                    ) : null}
                    <ProcessTimeline events={streamingEvents} />
                    {answerGenerationLive ? (
                      <StreamingAnswerDraft
                        text={streamingAnswerDraft}
                        pending={!streamingAnswerDraft}
                      />
                    ) : null}
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
                    void send();
                  }
                }}
              />
              <button
                type="button"
                disabled={loading || !input.trim() || !sessionReady}
                onClick={() => void send()}
                className="inline-flex h-10 min-w-[5.25rem] shrink-0 items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-3.5 text-sm font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {loading ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Send className="size-4 shrink-0" aria-hidden />
                )}
                {loading ? "发送中" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
