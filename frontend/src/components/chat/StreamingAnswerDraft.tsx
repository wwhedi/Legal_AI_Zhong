"use client";

import { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

type StreamingAnswerDraftProps = {
  text: string;
  pending: boolean;
  className?: string;
};

/** 流式阶段的原始回答预览（不做四段解析、不展示 citations） */
export function StreamingAnswerDraft({ text, pending, className }: StreamingAnswerDraftProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const threshold = 100;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < threshold) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  return (
    <div
      className={cn(
        "rounded-[20px] border border-[var(--app-border)] bg-white p-3 text-sm text-[var(--app-text)] shadow-[var(--app-shadow-sm)]",
        className,
      )}
    >
      <div className="mb-2 text-xs font-medium text-[var(--app-text-muted)]">回答生成中（预览）</div>
      <div
        ref={scrollerRef}
        className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-[var(--app-text)]"
      >
        {text ? text : pending ? <span className="text-[var(--app-text-subtle)]">正在生成回答……</span> : null}
      </div>
    </div>
  );
}
