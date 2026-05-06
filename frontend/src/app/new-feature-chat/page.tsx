"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, MessageSquarePlus, Send, User } from "lucide-react";
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

type SectionKind = "conclusion" | "basis" | "risk" | "suggestion";

/** 列表项「- [1] …」不是小节标题 */
function isCitationListLine(line: string): boolean {
  return /^\s*[-*•]\s*\[\d+\]/.test(line.trimStart());
}

/** 识别 1)结论 / 2)依据 / 3)风险点 / 4)建议 等标题；不把 [n] 当结构编号 */
function detectSectionHeaderLine(line: string): SectionKind | null {
  const t = line.trimStart();
  if (isCitationListLine(line)) return null;

  if (
    /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)结论\b/.test(t) ||
    /^\s*结论(?![性书及编])(?:\s*[：:]|\s+$|\s+)/.test(t) ||
    /^\s*结论\s*$/.test(t)
  ) {
    return "conclusion";
  }
  if (
    /^\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据\b/.test(t) ||
    /^\s*依据(?:\s*[：:]|\s+$|\s+)/.test(t)
  ) {
    return "basis";
  }
  if (
    /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险点\b/.test(t) ||
    /^\s*风险点(?:\s*[：:]|\s+$|\s+)/.test(t) ||
    /^\s*风险点\s*$/.test(t) ||
    /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险\b/.test(t) ||
    /^\s*风险(?![点])(?:\s*[：:]|\s+$|\s+)/.test(t) ||
    /^\s*风险\s*$/.test(t)
  ) {
    return "risk";
  }
  if (
    /^\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议\b/.test(t) ||
    /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议\b/.test(t) ||
    /^\s*建议(?:\s*[：:]|\s+$|\s+)/.test(t)
  ) {
    return "suggestion";
  }
  return null;
}

function stripSectionHeaderLine(line: string, kind: SectionKind): { rest: string; stripped: boolean } {
  const patterns: Record<SectionKind, RegExp[]> = {
    conclusion: [
      /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)结论(?![性书及编])\s*(.*)$/s,
      /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)结论\s*$/s,
      /^\s*结论(?![性书及编])\s*$/s,
      /^\s*结论\s*$/s,
    ],
    basis: [
      /^\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*依据(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据\s*$/s,
      /^\s*依据\s*$/s,
    ],
    risk: [
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险点(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*风险点(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险点\s*$/s,
      /^\s*风险点\s*$/s,
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*风险(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险\s*$/s,
      /^\s*风险\s*$/s,
    ],
    suggestion: [
      /^\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*建议(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议\s*$/s,
      /^\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议\s*$/s,
      /^\s*建议\s*$/s,
    ],
  };
  for (const re of patterns[kind]) {
    const m = re.exec(line);
    if (!m) continue;
    const body = m[2] ?? m[1];
    if (typeof body === "string") {
      return { rest: body.trim(), stripped: true };
    }
    return { rest: "", stripped: true };
  }
  return { rest: line, stripped: false };
}

/** 从一段文字中拆出后续小节（用于标题挤在同一行的情况） */
function peelFollowingSection(
  content: string,
  kind: "basis" | "risk" | "suggestion",
): { head: string; tail: string } {
  const patterns: Record<typeof kind, RegExp[]> = {
    basis: [
      /(?<![0-9０-９])(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)依据\s*[：:]?\s*/,
    ],
    risk: [
      /(?<![0-9０-９])(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险点\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)风险\s*[：:]?\s*/,
    ],
    suggestion: [
      /(?<![0-9０-９])(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)建议\s*[：:]?\s*/,
      /(?<![0-9０-９])(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)建议\s*[：:]?\s*/,
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

function fallbackFourPart(text: string): { conclusion: string; basis: string; risk: string; suggestion: string } {
  const paras = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 4) {
    return {
      conclusion: paras[0] ?? "",
      basis: paras[1] ?? "",
      risk: paras[2] ?? "",
      suggestion: paras.slice(3).join("\n\n"),
    };
  }
  if (paras.length === 3) {
    return { conclusion: paras[0] ?? "", basis: paras[1] ?? "", risk: "", suggestion: paras[2] ?? "" };
  }
  if (paras.length === 2) {
    return { conclusion: paras[0] ?? "", basis: paras[1] ?? "", risk: "", suggestion: "" };
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
    const riskHead = /^(?:风险点|风险)\s*[：:]/.test(t);
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
    risk: riskLike.join("\n").trim(),
    suggestion: suggestLike.join("\n").trim(),
  };
}

function mergeTail(prefix: string, existing: string): string {
  return [prefix, existing].filter(Boolean).join("\n\n").trim();
}

function normalizeAnswer(answer: string): QwenAnswer {
  const text = (answer || "").trim();
  if (!text) {
    return {
      conclusion: "未获取到回答。",
      details: [
        { title: "依据", content: PLACEHOLDER_BASIS },
        { title: "风险点", content: PLACEHOLDER_RISK },
        { title: "建议", content: PLACEHOLDER_SUGGESTION },
      ],
    };
  }

  let mode: SectionKind = "conclusion";
  const buckets: Record<SectionKind, string[]> = {
    conclusion: [],
    basis: [],
    risk: [],
    suggestion: [],
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const kind = detectSectionHeaderLine(line);
    if (kind) {
      const { rest, stripped } = stripSectionHeaderLine(line, kind);
      if (!stripped) {
        buckets[mode].push(line);
        continue;
      }
      mode = kind;
      if (rest) buckets[kind].push(rest);
      continue;
    }
    buckets[mode].push(line);
  }

  let conclusion = buckets.conclusion.join("\n").trim();
  let basis = buckets.basis.join("\n").trim();
  let risk = buckets.risk.join("\n").trim();
  let suggestion = buckets.suggestion.join("\n").trim();

  const peelBFromC = peelFollowingSection(conclusion, "basis");
  if (peelBFromC.tail) {
    conclusion = peelBFromC.head.trim();
    basis = mergeTail(peelBFromC.tail, basis);
  }
  const peelRFromC = peelFollowingSection(conclusion, "risk");
  if (peelRFromC.tail) {
    conclusion = peelRFromC.head.trim();
    risk = mergeTail(peelRFromC.tail, risk);
  }
  const peelSFromC = peelFollowingSection(conclusion, "suggestion");
  if (peelSFromC.tail) {
    conclusion = peelSFromC.head.trim();
    suggestion = mergeTail(peelSFromC.tail, suggestion);
  }

  const peelRFromB = peelFollowingSection(basis, "risk");
  if (peelRFromB.tail) {
    basis = peelRFromB.head.trim();
    risk = mergeTail(peelRFromB.tail, risk);
  }
  const peelSFromB = peelFollowingSection(basis, "suggestion");
  if (peelSFromB.tail) {
    basis = peelSFromB.head.trim();
    suggestion = mergeTail(peelSFromB.tail, suggestion);
  }

  const peelSFromR = peelFollowingSection(risk, "suggestion");
  if (peelSFromR.tail) {
    risk = peelSFromR.head.trim();
    suggestion = mergeTail(peelSFromR.tail, suggestion);
  }

  if (!suggestion.trim()) {
    const bl = basis.split(/\r?\n/);
    const heur = heuristicAppendSuggestionFromBasisLines(bl);
    basis = heur.basisLines.join("\n").trim();
    suggestion = mergeTail(heur.suggestionLines.join("\n").trim(), suggestion);
  }

  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const looksUnstructured =
    !detectSectionHeaderLine(firstLine) &&
    !/\r?\n\s*(?:(?:[2２]\s*[)）、.]|[二]\s*[、,，.]|2\s*\.)\s*)?依据\b/m.test(text) &&
    !/\r?\n\s*(?:(?:[3３]\s*[)）、.]|[三]\s*[、,，.]|3\s*\.)\s*)?风险点?\b/m.test(text) &&
    !/\r?\n\s*(?:(?:[4４]\s*[)）、.]|[四]\s*[、,，.]|4\s*\.)\s*)?建议\b/m.test(text) &&
    !/\r?\n\s*建议\b/m.test(text);

  if (looksUnstructured && !basis && !risk && !suggestion) {
    const fb = fallbackFourPart(text);
    conclusion = fb.conclusion;
    basis = fb.basis;
    risk = fb.risk;
    suggestion = fb.suggestion;
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
  if (!risk.trim()) {
    risk = PLACEHOLDER_RISK;
  }
  if (!suggestion.trim()) {
    suggestion = PLACEHOLDER_SUGGESTION;
  }

  return {
    conclusion: conclusion.trim() || text,
    details: [
      { title: "依据", content: basis },
      { title: "风险点", content: risk },
      { title: "建议", content: suggestion },
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

  return (
    <div className="flex min-h-full min-w-0 flex-col overflow-x-hidden bg-[var(--app-bg)] text-[var(--app-text)]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row md:items-stretch">
        <aside className="hidden h-auto min-h-0 w-[280px] max-w-full shrink-0 border-[var(--app-border)] bg-[var(--app-surface)] md:flex md:border-r">
          <ChatSessionSidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={loading}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
          />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-surface)]/95 px-3 py-2 md:hidden">
            <span className="text-sm font-semibold text-[var(--app-text)]">对话</span>
            <button
              type="button"
              disabled={loading || !sessionReady}
              onClick={handleNewSession}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-3 py-2 text-xs font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <MessageSquarePlus className="size-3.5 shrink-0" aria-hidden />
              新对话
            </button>
          </div>

      <div className="mx-auto flex w-full max-w-6xl min-w-0 items-center justify-between gap-4 px-5 py-6 md:px-8">
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

      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col gap-4 px-5 pb-44 md:px-8">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)]/90 p-5 shadow-[var(--app-shadow-sm)] backdrop-blur-sm">
          <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden scroll-pb-32 pb-36">
          {messages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-text-muted)]">
              {emptyHint}
            </div>
          ) : null}
          {messages.map((m) => {
            const assistantWithCard = m.role === "assistant" && m.answerCard;
            const answerCard = m.answerCard;
            return (
            <div key={m.id} className={`flex min-w-0 items-start gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
              {m.role === "assistant" ? (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                  <Bot className="size-4" />
                </div>
              ) : null}
              <div
                className={
                  m.role === "user"
                    ? "max-w-[70%] min-w-0 rounded-[20px] bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-4 py-3 text-sm font-normal leading-7 text-white shadow-[var(--app-shadow-sm)]"
                    : assistantWithCard
                      ? "min-w-0 w-full max-w-[min(100%,48rem)] flex-1 space-y-3 text-[var(--app-text)]"
                      : "min-w-0 max-w-[min(100%,48rem)] flex-1 rounded-[20px] border border-[var(--app-border)] bg-white/95 px-4 py-3 text-sm leading-7 text-[var(--app-text)] shadow-[var(--app-shadow-sm)]"
                }
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
        </div>
      </div>

      <div className="fixed bottom-0 left-14 right-0 z-10 border-t border-[var(--app-border)]/70 bg-gradient-to-t from-[var(--app-surface)] via-[var(--app-surface)]/95 to-[var(--app-bg)]/35 pt-10 shadow-[0_-12px_40px_-16px_rgba(16,24,40,0.08)] backdrop-blur-[10px]">
        <div className="mx-auto flex w-full max-w-6xl min-w-0 items-end gap-3 px-5 pb-5 pt-0 md:px-8">
          <textarea
            className="min-h-12 max-h-48 min-w-0 flex-1 resize-y rounded-[20px] border border-[var(--app-border)] bg-white p-3.5 text-sm text-[var(--app-text)] shadow-[var(--app-shadow-sm)] outline-none transition-[box-shadow,border-color] focus:border-[var(--app-primary)] focus:ring-2 focus:ring-[var(--app-primary)]/20"
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
            className="inline-flex h-12 min-w-[5.5rem] shrink-0 items-center justify-center gap-2 rounded-[20px] bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-4 text-sm font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : <Send className="size-4 shrink-0" aria-hidden />}
            {loading ? "发送中" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
