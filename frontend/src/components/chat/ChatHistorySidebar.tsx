"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, MessageSquarePlus, Settings, User } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChatSessions } from "@/contexts/chat-sessions-context";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "legal_ai_chat_history_collapsed";

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function groupLabel(ts: number): "今天" | "昨天" | "最近 7 天" | "更早" {
  const now = new Date();
  const t0 = startOfDay(now);
  const t1 = t0 - 86400000;
  const t7 = t0 - 7 * 86400000;
  if (ts >= t0) return "今天";
  if (ts >= t1) return "昨天";
  if (ts >= t7) return "最近 7 天";
  return "更早";
}

export function ChatHistorySidebar() {
  const { sessions, activeSessionId, createSession, selectSession } = useChatSessions();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  });

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const grouped = useMemo(() => {
    const order: Array<"今天" | "昨天" | "最近 7 天" | "更早"> = [
      "今天",
      "昨天",
      "最近 7 天",
      "更早",
    ];
    const buckets: Record<string, typeof sessions> = {
      今天: [],
      昨天: [],
      "最近 7 天": [],
      更早: [],
    };
    sessions.forEach((s) => {
      const label = groupLabel(s.updatedAt);
      buckets[label].push(s);
    });
    return order.map((label) => ({ label, items: buckets[label] }));
  }, [sessions]);

  if (collapsed) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center border-r border-slate-200/80 bg-white/70 py-3 backdrop-blur-sm">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9"
          title="展开历史"
          onClick={toggleCollapsed}
        >
          <ChevronRight className="size-4" />
        </Button>
        <div className="mt-2 flex flex-1 flex-col items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            title="新对话"
            onClick={() => createSession()}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-slate-200/80 bg-white/75 backdrop-blur-md">
      <div className="border-b border-slate-100 p-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            title="收起历史"
            onClick={toggleCollapsed}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            className="h-10 flex-1 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
            onClick={() => createSession()}
          >
            <MessageSquarePlus className="mr-2 size-4" />
            新对话
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="space-y-4 py-2 pr-2">
          {grouped.map(({ label, items }) =>
            items.length === 0 ? null : (
              <div key={label}>
                <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  {label}
                </div>
                <div className="space-y-1">
                  {items.map((s) => {
                    const active = s.id === activeSessionId;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => selectSession(s.id)}
                        className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          active
                            ? "bg-blue-50 text-blue-900 ring-1 ring-blue-200"
                            : "text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        <div className="line-clamp-2 font-medium">{s.title}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ),
          )}
          {sessions.length === 0 ? (
            <p className="px-2 text-xs text-slate-500">暂无历史，点击「新对话」开始。</p>
          ) : null}
        </div>
      </ScrollArea>

      <div className="border-t border-slate-100 p-3">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50/80 px-2 py-2">
          <div className="flex size-9 items-center justify-center rounded-full bg-slate-200 text-slate-600">
            <User className="size-4" />
          </div>
          <div className="min-w-0 flex-1 text-xs text-slate-600">
            <div className="font-medium text-slate-800">访客</div>
            <Link href="/chat" className="text-slate-500 hover:text-slate-700">
              返回对话
            </Link>
          </div>
          <Link
            href="/chat"
            title="设置"
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon", className: "size-9 shrink-0" }),
            )}
          >
            <Settings className="size-4" />
          </Link>
        </div>
      </div>
    </aside>
  );
}
