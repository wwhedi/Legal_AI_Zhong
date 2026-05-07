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
import { Check } from "lucide-react";

import { ActionStepsTable, parseActionStepsTable } from "@/components/chat/ActionStepsTable";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { QwenKbSource } from "@/types";
import { cn } from "@/lib/utils";

export type QwenAnswerDetail = {
  title: string;
  content: string;
};

/**
 * conclusion 为结论正文；details 与 basis / risks / actionAdvice 同步回填，兼容历史会话只含 details 的旧数据。
 */
export type QwenAnswer = {
  conclusion: string;
  details: QwenAnswerDetail[];
  actionAdvice?: string;
  risks?: string;
  basis?: string;
  actionStepsRaw?: string;
};

export const PLACEHOLDER_BASIS = "暂无明确法律依据摘要，请查看引用法条。";
export const PLACEHOLDER_RISK = "暂无明确风险提示。";
export const PLACEHOLDER_SUGGESTION = "暂无明确行动建议。";

export type { QwenKbSource };

const CITATION_SPLIT_RE = /(\[\d+\])/g;

const LIST_LINE_START =
  /^(?:[-*•]\s+|\d+[.)）]\s+|\d+[、，]\s+|[（(]\d+[）)]\s*)/;

/** 拆成清单行：项目符号、阿拉伯编号、中文顿号编号、多段空行；含 Markdown 表格行时整段保留 */
export function splitActionLines(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [];

  const lines = raw.split(/\r?\n/);
  if (lines.some((l) => /^\s*\|/.test(l))) {
    return [raw];
  }

  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isNewItem = LIST_LINE_START.test(trimmed);
    if (isNewItem || blocks.length === 0) {
      blocks.push(trimmed);
    } else {
      blocks[blocks.length - 1] += `\n${trimmed}`;
    }
  }

  if (blocks.length <= 1 && !LIST_LINE_START.test(raw.split(/\r?\n/).find((l) => l.trim()) ?? "")) {
    const paras = raw.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    if (paras.length > 1) return paras;
  }

  return blocks.length ? blocks : [raw];
}

function peelFirstLineListPrefix(block: string): {
  variant: "bullet" | "number" | "plain";
  num?: number;
  body: string;
} {
  const lines = block.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  const tail = lines.slice(1).join("\n").trim();
  const join = (main: string) => [main, tail].filter(Boolean).join("\n").trim();

  if (/^[-*•]\s+/.test(first)) {
    return { variant: "bullet", body: join(first.replace(/^[-*•]\s+/, "").trim()) };
  }
  const parenNum = /^[（(](\d+)[）)]\s*(.*)$/.exec(first);
  if (parenNum) {
    return { variant: "number", num: Number(parenNum[1]), body: join(parenNum[2].trim()) };
  }
  const dotNum = /^(\d+)[.)）]\s*(.*)$/.exec(first);
  if (dotNum) {
    return { variant: "number", num: Number(dotNum[1]), body: join(dotNum[2].trim()) };
  }
  const cnNum = /^(\d+)[、，]\s*(.*)$/.exec(first);
  if (cnNum) {
    return { variant: "number", num: Number(cnNum[1]), body: join(cnNum[2].trim()) };
  }
  return { variant: "plain", body: block.trim() };
}

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

function ActionChecklistBlock({
  items,
  sourceById,
  muted,
}: {
  items: string[];
  sourceById: Map<number, QwenKbSource>;
  muted?: boolean;
}) {
  return (
    <ul className={cn("m-0 list-none space-y-2.5 p-0", muted && "opacity-80")}>
      {items.map((block, idx) => {
        const parsed = peelFirstLineListPrefix(block);
        const label =
          parsed.variant === "number"
            ? parsed.num ?? idx + 1
            : parsed.variant === "bullet"
              ? null
              : idx + 1;
        return (
          <li key={`${idx}-${block.slice(0, 24)}`} className="flex gap-3">
            <span
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-emerald-400/45 bg-emerald-500/12 text-[11px] font-semibold text-emerald-900/90",
                muted && "border-emerald-400/25 bg-emerald-500/8 text-emerald-900/65",
              )}
              aria-hidden
            >
              {parsed.variant === "bullet" ? (
                <Check className="size-3.5 stroke-[2.5] text-emerald-700" aria-hidden />
              ) : (
                <span>{label}</span>
              )}
            </span>
            <div className={cn("min-w-0 flex-1 text-sm leading-relaxed text-emerald-950/90", muted && "text-emerald-950/65")}>
              {renderTextWithCitations(parsed.body, sourceById)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RiskBulletListBlock({
  items,
  sourceById,
}: {
  items: string[];
  sourceById: Map<number, QwenKbSource>;
}) {
  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {items.map((block, idx) => {
        const parsed = peelFirstLineListPrefix(block);
        const marker =
          parsed.variant === "number" ? (
            <span
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-amber-400/45 bg-amber-100/85 text-[11px] font-semibold text-amber-950/85"
              aria-hidden
            >
              {parsed.num ?? idx + 1}
            </span>
          ) : (
            <span className="mt-2 size-2 shrink-0 rounded-full bg-amber-500/55" aria-hidden />
          );
        return (
          <li key={`${idx}-${block.slice(0, 24)}`} className="flex gap-3">
            {marker}
            <div className="min-w-0 flex-1 text-sm leading-relaxed text-amber-950/88">
              {renderTextWithCitations(parsed.body, sourceById)}
            </div>
          </li>
        );
      })}
    </ul>
  );
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

/** 与 page.tsx SEC_P1 对齐；仅剥离开头小节标题，兼容旧会话已落库的 conclusion */
const DISP_P1 = "(?:[1１]\\s*(?:[)）]|[、,，]|[.．])\\s*|[一]\\s*[、,，.]\\s*)";

function sanitizeDisplayConclusion(text: string): string {
  if (!text.trim()) return text;
  const lines = text.split(/\r?\n/);
  let idx = 0;
  for (let guard = 0; guard < 8 && idx < lines.length; guard++) {
    const line = lines[idx] ?? "";
    if (!line.trim()) {
      idx++;
      guard--;
      continue;
    }
    const patterns: RegExp[] = [
      new RegExp(`^\\s*${DISP_P1}一句话结论\\s*(.*)$`),
      new RegExp(`^\\s*${DISP_P1}结论(?![性书及编])\\s*(.*)$`),
      new RegExp(`^\\s*${DISP_P1}简短结论\\s*(.*)$`),
      new RegExp(`^\\s*${DISP_P1}核心结论\\s*(.*)$`),
      new RegExp(`^\\s*${DISP_P1}直接回答\\s*(.*)$`),
      /^一句话结论\s*[：:]\s*(.*)$/,
      /^一句话结论\s+(.+)$/,
      /^一句话结论\s*$/,
      /^简短结论\s*[：:]\s*(.*)$/,
      /^简短结论\s+(.+)$/,
      /^简短结论\s*$/,
      /^核心结论\s*[：:]\s*(.*)$/,
      /^核心结论\s+(.+)$/,
      /^核心结论\s*$/,
      /^直接回答\s*[：:]\s*(.*)$/,
      /^直接回答\s+(.+)$/,
      /^直接回答\s*$/,
      /^结论(?![性书及编])\s*[：:]\s*(.*)$/,
      /^结论(?![性书及编])\s+(.+)$/,
      /^结论(?![性书及编])\s*$/,
    ];
    let matched = false;
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      matched = true;
      const body = m[1] != null ? String(m[1]).trim() : "";
      if (body) {
        lines[idx] = body;
        return lines.join("\n");
      }
      lines.splice(idx, 1);
      break;
    }
    if (!matched) break;
  }
  return lines.join("\n");
}

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

  const basisBodyRaw = (answer.basis ?? basisDetail.content ?? "").trim();
  const riskBodyRaw = (answer.risks ?? riskDetail.content ?? "").trim();
  const actionBodyRaw = (answer.actionAdvice ?? suggestionDetail.content ?? "").trim();

  const riskBody = riskBodyRaw ? riskBodyRaw : PLACEHOLDER_RISK;
  const suggestionBody = actionBodyRaw ? actionBodyRaw : PLACEHOLDER_SUGGESTION;

  const hasMeaningfulBasis =
    basisBodyRaw.length > 0 && basisBodyRaw !== PLACEHOLDER_BASIS;

  const isActionPlaceholder = suggestionBody === PLACEHOLDER_SUGGESTION;

  const conclusionDisplay = useMemo(
    () => sanitizeDisplayConclusion(answer.conclusion ?? ""),
    [answer.conclusion],
  );

  const [basisOpen, setBasisOpen] = useState(false);

  const actionItems = useMemo(() => splitActionLines(suggestionBody), [suggestionBody]);
  const riskItems = useMemo(() => splitActionLines(riskBody), [riskBody]);

  const stepsRawTrimmed = answer.actionStepsRaw?.trim() ?? "";
  const parsedStepsTable = useMemo(
    () => (stepsRawTrimmed ? parseActionStepsTable(stepsRawTrimmed) : null),
    [stepsRawTrimmed],
  );
  const stepsDisplayMode = useMemo(() => {
    if (!stepsRawTrimmed) return "none" as const;
    if (parsedStepsTable) return "table" as const;
    if (stepsRawTrimmed.split(/\r?\n/).some((l) => l.includes("|"))) return "prewrap" as const;
    return "list" as const;
  }, [stepsRawTrimmed, parsedStepsTable]);

  const stepBlocks = useMemo(() => {
    if (!stepsRawTrimmed || parsedStepsTable) return [];
    const lines = stepsRawTrimmed.split(/\r?\n/);
    if (lines.some((l) => l.includes("|"))) return [stepsRawTrimmed];
    const parts = splitActionLines(stepsRawTrimmed);
    return parts.length ? parts : [stepsRawTrimmed];
  }, [stepsRawTrimmed, parsedStepsTable]);

  return (
    <div className="rounded-2xl border border-[var(--app-border)] bg-white p-5 shadow-[var(--app-shadow-sm)]">
      <div className="border-b border-[var(--app-border)]/70 pb-4 text-[11px] leading-relaxed text-[var(--app-text-muted)]">
        问题：{question}
        <span className="ml-2 text-[var(--app-text-subtle)]">模型：{modelName}</span>
      </div>

      <div className="mt-4 border-l-[3px] border-[var(--app-primary)]/35 bg-[var(--app-primary-soft)]/25 py-3 pl-4 pr-3">
        <div className="mb-2 text-sm font-semibold tracking-tight text-[var(--app-text)]">结论</div>
        <div className="text-[15px] font-medium leading-[1.65] text-[var(--app-text)]">
          {conclusionDisplay
            ? renderTextWithCitations(conclusionDisplay, sourceById)
            : "未获取到回答。"}
        </div>
      </div>

      <div className="mt-5 divide-y divide-[var(--app-border)]/60">
        <div
          className={cn(
            "py-4 first:pt-0",
            "bg-emerald-500/[0.04] px-1 -mx-1 rounded-lg",
            isActionPlaceholder && "opacity-90",
          )}
        >
          <div
            className={cn(
              "mb-2 text-sm font-semibold text-emerald-900/85",
              isActionPlaceholder && "text-emerald-900/55",
            )}
          >
            你现在最该做
          </div>
          <ActionChecklistBlock items={actionItems} sourceById={sourceById} muted={isActionPlaceholder} />
        </div>

        <div className="bg-amber-500/[0.04] px-1 -mx-1 py-4 rounded-lg">
          <div className="mb-2 text-sm font-semibold text-amber-950/80">风险提示</div>
          <RiskBulletListBlock items={riskItems} sourceById={sourceById} />
        </div>

        {stepsRawTrimmed ? (
          <div className="bg-sky-500/[0.04] px-1 -mx-1 py-4 rounded-lg">
            <div className="mb-2 text-sm font-semibold text-sky-950/80">可执行操作步骤</div>
            {stepsDisplayMode === "table" && parsedStepsTable ? (
              <ActionStepsTable
                rows={parsedStepsTable.rows}
                renderCell={(t) => renderTextWithCitations(t, sourceById)}
              />
            ) : stepsDisplayMode === "prewrap" ? (
              <div className="overflow-x-auto text-sm leading-relaxed text-sky-950/85">
                <div className="min-w-0 whitespace-pre-wrap break-words">
                  {renderTextWithCitations(stepsRawTrimmed, sourceById)}
                </div>
              </div>
            ) : (
              <ul className="m-0 list-none space-y-2 p-0">
                {stepBlocks.map((block, idx) => (
                  <li key={`step-${idx}-${block.slice(0, 20)}`} className="flex gap-2.5">
                    <span
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-sky-500/45"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1 text-sm leading-relaxed text-sky-950/85">
                      {renderTextWithCitations(block.trim(), sourceById)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {hasMeaningfulBasis ? (
          <div className="py-4">
            <button
              type="button"
              onClick={() => setBasisOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-1 py-1 text-left text-xs text-[var(--app-text-muted)] transition hover:border-[var(--app-border)]/80 hover:bg-[var(--app-surface-muted)]/50"
              aria-expanded={basisOpen}
            >
              <span>
                引用依据 · <span className="text-[var(--app-primary)]">{basisOpen ? "收起" : "展开"}</span>
              </span>
            </button>
            {basisOpen ? (
              <div className="mt-2 text-sm leading-relaxed text-[var(--app-text)]">
                {renderTextWithCitations(basisBodyRaw, sourceById)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-5">
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
