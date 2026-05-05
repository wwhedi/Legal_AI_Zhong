"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { QwenKbSource } from "@/types";
import { cn } from "@/lib/utils";

export type QwenAnswerDetail = {
  title: string;
  content: string;
};

/** conclusion 为「结论」正文；details 顺序为 依据、风险点、建议（由 normalizeAnswer 保证） */
export type QwenAnswer = {
  conclusion: string;
  details: QwenAnswerDetail[];
};

export const PLACEHOLDER_BASIS = "暂无明确依据摘要，请查看引用法条。";
export const PLACEHOLDER_RISK = "暂无明确风险点。";
export const PLACEHOLDER_SUGGESTION = "暂无明确建议。";

export type { QwenKbSource };

const CITATION_SPLIT_RE = /(\[\d+\])/g;

function chapterArticleLine(source: QwenKbSource): string {
  const ch = source.chapter;
  const ar = source.article;
  if (ch === "未提供" && ar === "未提供") return "未提供";
  if (ch !== "未提供" && ar !== "未提供") return `${ch}；${ar}`;
  return ch !== "未提供" ? ch : ar;
}

function KnowledgeSourcesBlock({ sources }: { sources: QwenKbSource[] }) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) {
    return (
      <div className="rounded-[12px] border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 text-[11px] text-[var(--app-text-muted)]">
        暂无来源
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[12px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/90 text-[11px] text-[var(--app-text-muted)]",
        expanded && "shadow-[var(--app-shadow-sm)]",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate">
          知识库来源 · 已引用 <span className="font-semibold text-[var(--app-text)]">{sources.length}</span>{" "}
          条有效法条
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-lg border border-[var(--app-border)] bg-white px-2 py-1 text-[11px] font-medium text-[var(--app-primary)] hover:bg-[var(--app-surface-soft)]"
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "展开"}
        </button>
      </div>

      {expanded ? (
        <div className="space-y-2 border-t border-[var(--app-border)]/80 bg-white/70 px-3 py-2.5">
          {sources.map((source) => {
            const url = source.sourceUrl?.trim();
            return (
              <div key={source.id} className="rounded-lg border border-[var(--app-border)]/90 bg-white px-2.5 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] leading-snug text-[var(--app-text)]">
                  <span className="shrink-0 font-semibold text-[var(--app-primary)]">[{source.id}]</span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{source.lawName}</span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="max-w-[40%] truncate text-[var(--app-text-muted)]" title={chapterArticleLine(source)}>
                    {chapterArticleLine(source)}
                  </span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="shrink-0 truncate text-[var(--app-text-muted)]">{source.effectiveStatus}</span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-medium text-[var(--app-primary)] underline-offset-2 hover:underline"
                    >
                      查看原文
                    </a>
                  ) : (
                    <span className="shrink-0 text-[var(--app-text-subtle)]">未提供</span>
                  )}
                </div>
                {source.text ? (
                  <div className="mt-1.5 border-t border-[var(--app-border)]/70 pt-1.5">
                    <div className="mb-0.5 text-[10px] text-[var(--app-text-subtle)]">
                      正文摘要（完整条文请点正文 [n] 或悬浮卡片）
                    </div>
                    <p className="line-clamp-2 whitespace-pre-wrap break-words leading-snug text-[var(--app-text-muted)]">
                      {source.text}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function CitationPopover({ source }: { source: QwenKbSource }) {
  const url = source.sourceUrl?.trim();
  return (
    <div
      className={cn(
        "pointer-events-auto absolute left-1/2 top-full z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-[14px] border border-[var(--app-border)] bg-white p-3 text-left text-xs text-[var(--app-text)] shadow-[var(--app-shadow-md)]",
        "ring-1 ring-[var(--app-border-strong)]/40",
      )}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="mb-2 border-b border-[var(--app-border)] pb-2 font-semibold text-[var(--app-text)]">
        引用 <span className="text-[var(--app-primary)]">[{source.id}]</span>
      </div>
      <dl className="space-y-1.5 leading-relaxed">
        <div>
          <dt className="text-[var(--app-text-subtle)]">法规名称</dt>
          <dd className="text-[var(--app-text)]">{source.lawName}</dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">类型</dt>
          <dd className="text-[var(--app-text)]">{source.lawType}</dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">时效性</dt>
          <dd className="text-[var(--app-text)]">{source.effectiveStatus}</dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">公布日期</dt>
          <dd className="text-[var(--app-text)]">{source.publishDate}</dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">生效日期</dt>
          <dd className="text-[var(--app-text)]">{source.effectiveDate}</dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">章节/条文</dt>
          <dd className="break-words text-[var(--app-text)]">{chapterArticleLine(source)}</dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">法规正文</dt>
          <dd>
            <ScrollArea className="h-32 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-2">
              <div className="whitespace-pre-wrap break-words pr-2 text-[var(--app-text)]">{source.text}</div>
            </ScrollArea>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">来源链接</dt>
          <dd>
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[var(--app-primary)] underline-offset-2 hover:underline"
              >
                查看原文
              </a>
            ) : (
              <span className="text-[var(--app-text-muted)]">链接：未提供</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function InlineCitationMark({
  label,
  source,
}: {
  label: string;
  source: QwenKbSource | undefined;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const visible = open || hover;

  const toggle = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      const el = rootRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!source) {
    return <span className="text-[var(--app-text)]">{label}</span>;
  }

  return (
    <span
      ref={rootRef}
      data-citation-root
      className="relative inline align-baseline"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={cn(
          "mx-0.5 inline cursor-pointer rounded px-0.5 align-baseline font-medium text-[var(--app-primary)] underline decoration-dotted decoration-[var(--app-primary)]/55 underline-offset-[3px] hover:bg-[var(--app-primary-soft)] hover:text-[var(--app-primary-strong)]",
          open && "bg-[var(--app-primary-soft)] text-[var(--app-primary-strong)]",
        )}
        aria-expanded={open}
        aria-label={`引用 ${label}`}
        onClick={toggle}
      >
        {label}
      </button>
      {visible ? <CitationPopover source={source} /> : null}
    </span>
  );
}

export function renderTextWithCitations(text: string, sourceById: Map<number, QwenKbSource>): ReactNode {
  if (!text) return null;
  const parts = text.split(CITATION_SPLIT_RE);
  return parts.map((part, idx) => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (!m) {
      return (
        <span key={idx} className="whitespace-pre-wrap break-words">
          {part}
        </span>
      );
    }
    const num = Number(m[1]);
    const src = Number.isFinite(num) ? sourceById.get(num) : undefined;
    return <InlineCitationMark key={`${idx}-${part}`} label={part} source={src} />;
  });
}

type QwenKbAnswerCardProps = {
  answer: QwenAnswer;
  sources: QwenKbSource[];
  question: string;
  modelName: string;
  onRegenerate?: () => void;
  onCopy?: () => void;
  onFeedback?: () => void;
};

export function QwenKbAnswerCard({
  answer,
  sources,
  question,
  modelName,
  onRegenerate,
  onCopy,
  onFeedback,
}: QwenKbAnswerCardProps) {
  const sourceById = useMemo(() => {
    const m = new Map<number, QwenKbSource>();
    for (const s of sources) {
      m.set(s.id, s);
    }
    return m;
  }, [sources]);

  const basisDetail = answer.details[0] ?? { title: "依据", content: "" };
  const riskDetail = answer.details[1] ?? { title: "风险点", content: "" };
  const suggestionDetail = answer.details[2] ?? {
    title: "建议",
    content: PLACEHOLDER_SUGGESTION,
  };

  const basisBody = basisDetail.content?.trim() ? basisDetail.content : PLACEHOLDER_BASIS;
  const riskBody = riskDetail.content?.trim() ? riskDetail.content : PLACEHOLDER_RISK;
  const suggestionBody = suggestionDetail.content?.trim() ? suggestionDetail.content : PLACEHOLDER_SUGGESTION;

  const suggestionBlocks = useMemo(() => {
    const s = suggestionBody.trim();
    const parts = s.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts : [s];
  }, [suggestionBody]);

  return (
    <div className="rounded-[20px] border border-[var(--app-border)] bg-white p-4 shadow-[var(--app-shadow-sm)]">
      <div className="rounded-[16px] border border-[var(--app-primary)]/15 bg-gradient-to-b from-[var(--app-primary-softer)] to-[var(--app-primary-soft)] p-4">
        <div className="mb-3 text-[11px] leading-relaxed text-[var(--app-text-muted)]">
          问题：{question}
          <span className="ml-2 text-[var(--app-text-subtle)]">模型：{modelName}</span>
        </div>
        <div className="mb-2 text-base font-semibold tracking-wide text-[var(--app-text)]">结论</div>
        <div className="text-[15px] font-medium leading-8 text-[var(--app-text)]">
          {answer.conclusion ? renderTextWithCitations(answer.conclusion, sourceById) : "未获取到回答。"}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="rounded-[14px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/85 p-3.5">
          <div className="mb-1.5 text-xs font-semibold text-[var(--app-text-muted)]">{basisDetail.title}</div>
          <div className="text-sm leading-relaxed text-[var(--app-text-muted)]">
            {renderTextWithCitations(basisBody, sourceById)}
          </div>
        </div>

        <div className="rounded-[14px] border border-amber-200/90 bg-amber-50/95 p-3.5">
          <div className="mb-2 text-sm font-semibold text-amber-950/90">风险点</div>
          <div className="text-sm leading-relaxed text-amber-950/85">
            {renderTextWithCitations(riskBody, sourceById)}
          </div>
        </div>

        <div className="rounded-[14px] border border-emerald-200/85 bg-emerald-50/90 p-3.5">
          <div className="mb-2 text-sm font-semibold text-emerald-950/90">建议</div>
          <div className="space-y-2.5">
            {suggestionBlocks.map((block, idx) => (
              <div
                key={`${idx}-${block.slice(0, 12)}`}
                className="relative border-l-2 border-emerald-400/70 pl-3 text-sm leading-relaxed text-emerald-950/90 last:pb-0"
              >
                {renderTextWithCitations(block, sourceById)}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <KnowledgeSourcesBlock sources={sources} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--app-border)]/80 pt-3">
        <button
          type="button"
          onClick={onRegenerate}
          className="rounded-lg border border-[var(--app-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--app-text)] hover:bg-[var(--app-surface-soft)]"
        >
          重新生成
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-lg border border-[var(--app-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--app-text)] hover:bg-[var(--app-surface-soft)]"
        >
          复制
        </button>
        <button
          type="button"
          onClick={onFeedback}
          className="rounded-lg border border-[var(--app-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--app-text)] hover:bg-[var(--app-surface-soft)]"
        >
          反馈
        </button>
      </div>
    </div>
  );
}
