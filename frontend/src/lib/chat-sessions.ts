/**
 * 仅保留 UI 辅助：上次选中会话 id（避免刷新丢失）。
 * 会话列表与消息主体已由服务端 SQLite + /chat API 提供，请勿再读写 LEGACY_CHAT_SESSIONS_STORAGE_KEY。
 */

export const ACTIVE_SESSION_ID_KEY = "legal-ai-active-session-id-v1";

/** 旧版 localStorage 会话清单键（仅用于迁移时一次性移除，不作为数据源） */
export const LEGACY_CHAT_SESSIONS_STORAGE_KEY = "legal-ai-chat-sessions-v1";

/** 标题展示上限（约 18～24 字；取码位上限 24） */
const TITLE_MAX_CHARS = 24;

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
