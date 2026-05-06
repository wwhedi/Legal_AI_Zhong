import type { ChatSession } from "@/types";

export const CHAT_SESSIONS_KEY = "legal-ai-chat-sessions-v1";
export const ACTIVE_SESSION_ID_KEY = "legal-ai-active-session-id-v1";

const MAX_STORED_SESSIONS = 50;
/** 标题展示上限（约 18～24 字；取码位上限 24） */
const TITLE_MAX_CHARS = 24;

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isChatSession(value: unknown): value is ChatSession {
  if (value == null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.schemaVersion === 1 &&
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    Array.isArray(o.messages) &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string"
  );
}

function sortSessionsByUpdatedAtDesc(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return 0;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

function newSessionId(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** 读取本地会话列表；按 `updatedAt` 从新到旧排序；SSR 或异常时返回 [] */
export function getChatSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_KEY);
    if (raw == null || raw === "") return [];
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    const sessions = parsed.filter(isChatSession);
    return sortSessionsByUpdatedAtDesc(sessions);
  } catch {
    return [];
  }
}

/**
 * 持久化会话列表；保存前按 `updatedAt` 倒序并最多保留 50 条。
 */
export function saveChatSessions(sessions: ChatSession[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = sortSessionsByUpdatedAtDesc(sessions).slice(0, MAX_STORED_SESSIONS);
    window.localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded, private mode, or storage disabled */
  }
}

/** 新建会话对象（不自动写入 localStorage） */
export function createChatSession(initialTitle?: string): ChatSession {
  const now = new Date().toISOString();
  const trimmedTitle =
    typeof initialTitle === "string" ? initialTitle.trim() : "";
  return {
    schemaVersion: 1,
    id: newSessionId(),
    title: trimmedTitle || "新对话",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 按 id 合并 patch 并写回存储；禁止通过 patch 修改会话 id。
 * 成功时刷新 `updatedAt`；找不到会话时返回当前列表（不变）。
 */
export function updateChatSession(sessionId: string, patch: Partial<ChatSession>): ChatSession[] {
  if (typeof window === "undefined") return [];
  const sessions = getChatSessions();
  const prev = sessions.find((s) => s.id === sessionId);
  if (!prev) return sessions;

  const next: ChatSession = {
    ...prev,
    ...patch,
    schemaVersion: 1,
    id: prev.id,
    updatedAt: new Date().toISOString(),
  };

  const others = sessions.filter((s) => s.id !== sessionId);
  saveChatSessions([next, ...others]);
  return getChatSessions();
}

/** 删除会话并写回；返回更新后的列表 */
export function deleteChatSession(sessionId: string): ChatSession[] {
  if (typeof window === "undefined") return [];
  const next = getChatSessions().filter((s) => s.id !== sessionId);
  saveChatSessions(next);
  return getChatSessions();
}

export function getActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(ACTIVE_SESSION_ID_KEY);
    if (v == null || v === "") return null;
    return v;
  } catch {
    return null;
  }
}

export function setActiveSessionId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id == null || id === "") {
      window.localStorage.removeItem(ACTIVE_SESSION_ID_KEY);
      return;
    }
    window.localStorage.setItem(ACTIVE_SESSION_ID_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * 由用户首句生成会话标题：去换行、压缩空白；最长约 24 个 Unicode 码位，超出加省略号。
 */
export function generateSessionTitle(question: string): string {
  const normalized = question.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "新对话";

  const chars = Array.from(normalized);
  if (chars.length <= TITLE_MAX_CHARS) {
    return normalized;
  }
  return `${chars.slice(0, TITLE_MAX_CHARS).join("")}…`;
}
