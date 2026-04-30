"use client";

import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { Citation } from "@/types";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  answerNeedsHumanReview?: boolean;
  agentDebug?: Record<string, unknown> | null;
};

export type CitationDetail = {
  ref_id: string;
  law_name: string;
  article: string;
  evidence_status_display?: string;
  /** 引用校验：Verified / Unverified（展示时转中文） */
  status: "Verified" | "Unverified";
  excerpt: string;
  verify_source?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  citationDetails: Record<string, CitationDetail>;
};

type ChatSessionsContextValue = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  createSession: () => string;
  selectSession: (id: string) => void;
  updateActiveSession: (patch: Partial<Pick<ChatSession, "messages" | "citationDetails" | "title" | "updatedAt">>) => void;
  replaceActiveMessages: (messages: ChatMessage[]) => void;
};

const ChatSessionsContext = createContext<ChatSessionsContextValue | null>(null);
const CHAT_SESSIONS_STORAGE_KEY = "legal_ai_chat_sessions_v1";

function newId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const initialStore = (() => {
  const id = newId();
  return {
    sessions: [
      {
        id,
        title: "新对话",
        updatedAt: Date.now(),
        messages: [],
        citationDetails: {},
      },
    ] satisfies ChatSession[],
    activeSessionId: id,
  };
})();

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<ChatSession[]>(initialStore.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    initialStore.activeSessionId,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        sessions?: ChatSession[];
        activeSessionId?: string | null;
      };
      const loadedSessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.filter(
            (s) =>
              s &&
              typeof s.id === "string" &&
              typeof s.title === "string" &&
              typeof s.updatedAt === "number" &&
              Array.isArray(s.messages) &&
              typeof s.citationDetails === "object" &&
              s.citationDetails !== null,
          )
        : [];
      if (loadedSessions.length === 0) return;
      setSessions(loadedSessions);
      const loadedActiveId = parsed.activeSessionId ?? loadedSessions[0].id;
      const activeExists = loadedSessions.some((s) => s.id === loadedActiveId);
      setActiveSessionId(activeExists ? loadedActiveId : loadedSessions[0].id);
    } catch {
      // Ignore malformed localStorage content and keep runtime defaults.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CHAT_SESSIONS_STORAGE_KEY,
        JSON.stringify({ sessions, activeSessionId }),
      );
    } catch {
      // Ignore quota/private mode errors and keep app functional.
    }
  }, [sessions, activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const createSession = useCallback(() => {
    const id = newId();
    const session: ChatSession = {
      id,
      title: "新对话",
      updatedAt: Date.now(),
      messages: [],
      citationDetails: {},
    };
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(id);
    return id;
  }, []);

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const updateActiveSession = useCallback(
    (patch: Partial<Pick<ChatSession, "messages" | "citationDetails" | "title" | "updatedAt">>) => {
      if (!activeSessionId) return;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? {
                ...s,
                ...patch,
                updatedAt: patch.updatedAt ?? Date.now(),
              }
            : s,
        ),
      );
    },
    [activeSessionId],
  );

  const replaceActiveMessages = useCallback(
    (messages: ChatMessage[]) => {
      updateActiveSession({ messages, updatedAt: Date.now() });
    },
    [updateActiveSession],
  );

  const value = useMemo(
    () => ({
      sessions,
      activeSessionId,
      activeSession,
      createSession,
      selectSession,
      updateActiveSession,
      replaceActiveMessages,
    }),
    [
      sessions,
      activeSessionId,
      activeSession,
      createSession,
      selectSession,
      updateActiveSession,
      replaceActiveMessages,
    ],
  );

  return (
    <ChatSessionsContext.Provider value={value}>{children}</ChatSessionsContext.Provider>
  );
}

export function useChatSessions() {
  const ctx = useContext(ChatSessionsContext);
  if (!ctx) {
    throw new Error("useChatSessions must be used within ChatSessionsProvider");
  }
  return ctx;
}
