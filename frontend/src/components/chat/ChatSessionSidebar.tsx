"use client";

import { ChevronLeft, ChevronRight, MessageSquarePlus } from "lucide-react";

import type { ChatSession } from "@/types";
import { cn } from "@/lib/utils";

export type ChatSessionSidebarProps = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  loading?: boolean;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** When false, hide the desktop collapse chevron (e.g. mobile drawer). Default true. */
  showCollapseToggle?: boolean;
};

function formatSessionUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startToday.getTime() - startMsg.getTime()) / 86_400_000);
  const hm = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (diffDays === 0) return `今天 ${hm}`;
  if (diffDays === 1) return `昨天 ${hm}`;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  if (y === now.getFullYear()) {
    return `${m}-${day} ${hm}`;
  }
  return `${y}-${m}-${day}`;
}

export function ChatSessionSidebar({
  sessions,
  activeSessionId,
  loading = false,
  onNewSession,
  onSelectSession,
  collapsed,
  onToggleCollapsed,
  showCollapseToggle = true,
}: ChatSessionSidebarProps) {
  if (collapsed) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col items-stretch border-0 border-[var(--app-border)] bg-[var(--app-surface)]/95">
        <div className="flex shrink-0 flex-col items-center gap-2 border-b border-[var(--app-border)] px-2 py-3">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex size-9 items-center justify-center rounded-xl border border-transparent text-[var(--app-text-muted)] transition hover:border-[var(--app-border)] hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]"
            aria-label="展开会话列表"
          >
            <ChevronRight className="size-4 shrink-0" aria-hidden />
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onNewSession}
            className="inline-flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="新对话"
          >
            <MessageSquarePlus className="size-4 shrink-0" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col border-0 border-[var(--app-border)] bg-[var(--app-surface)]/95">
      <div className="shrink-0 space-y-3 border-b border-[var(--app-border)] p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-[var(--app-text)]">对话</div>
          {showCollapseToggle ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--app-text-muted)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]"
              aria-label="收起会话列表"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-3 py-2.5 text-sm font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <MessageSquarePlus className="size-4 shrink-0" aria-hidden />
          新对话
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--app-text-muted)]">暂无历史对话</p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => {
              const active = activeSessionId != null && s.id === activeSessionId;
              return (
                <li key={s.id} className="min-w-0">
                  <button
                    type="button"
                    disabled={loading}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelectSession(s.id)}
                    className={cn(
                      "flex w-full min-w-0 flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left text-sm transition",
                      active
                        ? "border-[var(--app-primary)]/35 bg-[var(--app-primary-soft)] text-[var(--app-text)] ring-1 ring-[var(--app-primary)]/20"
                        : "border-transparent bg-white/80 text-[var(--app-text)] hover:border-[var(--app-border)] hover:bg-[var(--app-surface-muted)]",
                      loading && "cursor-not-allowed opacity-50 hover:border-transparent hover:bg-white/80",
                    )}
                  >
                    <span className="line-clamp-2 font-medium leading-snug">{s.title || "新对话"}</span>
                    <span className="text-[11px] text-[var(--app-text-muted)] tabular-nums">
                      {formatSessionUpdatedAt(s.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
