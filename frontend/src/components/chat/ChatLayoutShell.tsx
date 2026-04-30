"use client";

import type { ReactNode } from "react";

import { ChatHistorySidebar } from "@/components/chat/ChatHistorySidebar";
import { ChatSessionsProvider } from "@/contexts/chat-sessions-context";

export function ChatLayoutShell({ children }: { children: ReactNode }) {
  return (
    <ChatSessionsProvider>
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-[#F9FAFB] text-slate-900">
        <ChatHistorySidebar />
        <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </ChatSessionsProvider>
  );
}
