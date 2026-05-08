"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StreamingAnswerCardProps = {
  text: string;
  /** 仍为流式中时在文末显示闪烁光标 */
  pending: boolean;
  className?: string;
};

const NUM_SECTION_RE = /^\s*\d+[.)）]\s*\S/;
const BULLET_RE = /^\s*[-*•]\s+(.+)$/;
const TABLE_LINE_RE = /^\s*\|/;

function renderLine(line: string, index: number): ReactNode {
  const trimmedEnd = line.trimEnd();
  if (!trimmedEnd.trim()) {
    return <div key={`sp-${index}`} className="h-2 shrink-0" aria-hidden />;
  }
  if (NUM_SECTION_RE.test(line)) {
    return (
      <p key={`ln-${index}`} className="whitespace-pre-wrap break-words font-semibold text-[var(--app-text)]">
        {trimmedEnd}
      </p>
    );
  }
  const bul = BULLET_RE.exec(line);
  if (bul) {
    return (
      <div key={`ln-${index}`} className="flex gap-2.5 pl-0.5">
        <span className="mt-0.5 shrink-0 text-[var(--app-text-muted)]" aria-hidden>
          •
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--app-text)]">{bul[1]}</span>
      </div>
    );
  }
  return (
    <p key={`ln-${index}`} className="whitespace-pre-wrap break-words text-[var(--app-text)]">
      {trimmedEnd}
    </p>
  );
}

function renderStreamingBody(text: string): ReactNode {
  const lines = text.split(/\n/);
  const chunks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (TABLE_LINE_RE.test(line)) {
      const block: string[] = [];
      while (i < lines.length && TABLE_LINE_RE.test(lines[i] ?? "")) {
        block.push(lines[i] ?? "");
        i++;
      }
      chunks.push(
        <pre
          key={`tbl-${key++}`}
          className="overflow-x-auto rounded-lg border border-[var(--app-border)]/80 bg-[var(--app-surface-muted)]/40 p-2.5 text-sm leading-relaxed text-[var(--app-text)]"
        >
          {block.join("\n")}
        </pre>,
      );
      continue;
    }
    chunks.push(renderLine(line, key++));
    i++;
  }

  return <div className="space-y-1">{chunks}</div>;
}

/** 流式阶段正式回答区：外壳接近 QwenKbAnswerCard，[n] 保持纯文本，无来源与按钮 */
export function StreamingAnswerCard({ text, pending, className }: StreamingAnswerCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-[var(--app-border)] bg-white p-5 shadow-[var(--app-shadow-sm)]",
        className,
      )}
    >
      <div className="text-base font-normal leading-relaxed">
        {renderStreamingBody(text)}
        {pending ? (
          <span
            className="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-0.5 animate-pulse bg-[var(--app-primary)] align-baseline"
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}
