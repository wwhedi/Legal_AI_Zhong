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

import {
  ActionStepsTable,
  parseActionStepsTable,
  type ParsedActionStepsTable,
} from "@/components/chat/ActionStepsTable";
import { CitationLawTextDisplay, getDisplayChapterArticle } from "@/components/chat/CitationSidePanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { QwenKbSource } from "@/types";
import { cn, normalizeExternalUrl } from "@/lib/utils";

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
  /** 判断类问题下的「影响结果的关键事实」等；旧会话通常无此字段 */
  keyFacts?: string;
  actionAdvice?: string;
  risks?: string;
  basis?: string;
  actionStepsRaw?: string;
};

export const PLACEHOLDER_BASIS = "暂无明确法律依据摘要，请查看引用法条。";
export const PLACEHOLDER_RISK = "暂无明确风险提示。";
export const PLACEHOLDER_SUGGESTION = "暂无明确行动建议。";

/** 显示层：将正文里残留的小节标题「风险提示」归一为「需要注意」 */
function sanitizeRiskHeadingLabels(text: string): string {
  const t = text.trim();
  if (!t || t === PLACEHOLDER_RISK) return text;
  return text.replace(/^(\s*)风险提示(\s*[：:]|\s*$)/gm, "$1需要注意$2");
}

/** 是否为单独成行的小节标题（误留在结论/行动/列表中的「3) 需要注意」等） */
function isStandaloneNoticeHeadingLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (/^需要注意\s*[：:]?\s*$/.test(s)) return true;
  if (/^风险提示\s*[：:]?\s*$/.test(s)) return true;
  if (/^三[、.,．]\s*需要注意\s*[：:]?\s*$/.test(s)) return true;
  if (/^三[、.,．]\s*风险提示\s*[：:]?\s*$/.test(s)) return true;
  if (/^3\s+需要注意\s*[：:]?\s*$/.test(s)) return true;
  if (/^3\s+风险提示\s*[：:]?\s*$/.test(s)) return true;
  return /^(?:(?:[3３]\s*(?:[)）]|[、,，]|[.．])\s*|[三]\s*[、,，.]\s*|3\s*\.)\s*)(需要注意|风险提示)(\s*[：:]|\s*)?$/.test(s);
}

/** 从任意正文中剔除误混入的「需要注意」标题行，避免与下方独立 section 重复 */
function stripLeakedNoticeHeadingLines(text: string): string {
  const t = text.trim();
  if (!t) return text;
  return text
    .split(/\r?\n/)
    .filter((ln) => !isStandaloneNoticeHeadingLine(ln))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPlaceholderRiskContent(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  if (t === PLACEHOLDER_RISK) return true;
  return /^暂无明确(?:风险提示|需要注意)/.test(t);
}

/** 去掉块内误混入的标题行后再判断是否有有效条目 */
function normalizeRiskBlocksForDisplay(blocks: string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\r?\n/).filter((ln) => !isStandaloneNoticeHeadingLine(ln.trim()));
    const cleaned = lines.join("\n").trim();
    if (!cleaned) continue;
    out.push(cleaned);
  }
  return out;
}

/** 「需要注意」排序：依据不足 / 知识库边界类固定排在最后（与警示符号条目一致） */
const RISK_BOUNDARY_SORT_PHRASES = [
  "当前知识库未提供",
  "当前知识库未检索到",
  "无法直接判断",
  "需结合个案证据",
  "仍需补充事实",
  "需要进一步核实",
  "当前知识库依据不足",
] as const;

function isRiskBoundarySortCategory(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return RISK_BOUNDARY_SORT_PHRASES.some((p) => t.includes(p));
}

function sortRiskBlocksBoundaryLast(blocks: string[]): string[] {
  const normal: string[] = [];
  const boundary: string[] = [];
  for (const b of blocks) {
    const body = peelFirstLineListPrefix(b).body;
    if (isRiskBoundarySortCategory(body)) boundary.push(b);
    else normal.push(b);
  }
  return [...normal, ...boundary];
}

const KNOWLEDGE_LEAD_CLAUSES = [
  "当前知识库未提供",
  "当前知识库未检索到",
  "当前知识库依据不足",
  "当前知识库检索结果不足",
] as const;

/** 将「当前知识库未提供…」等_clause 尽量前置，便于一眼看到依据边界 */
function promoteKnowledgeBoundaryClause(text: string): string {
  const s = text.trim();
  if (!s) return text;
  let earliest = -1;
  for (const p of KNOWLEDGE_LEAD_CLAUSES) {
    const i = s.indexOf(p);
    if (i !== -1 && (earliest === -1 || i < earliest)) {
      earliest = i;
    }
  }
  if (earliest <= 0) return text;
  const fromKw = s.slice(earliest);
  let end = fromKw.length;
  for (const sep of ["。", "；", "\n"] as const) {
    const j = fromKw.indexOf(sep);
    if (j !== -1) end = Math.min(end, j + sep.length);
  }
  const clause = fromKw.slice(0, end).trim();
  const before = s.slice(0, earliest).replace(/[，,、]\s*$/u, "").trim();
  const after = fromKw.slice(end).trim();
  const rest = [before, after].filter(Boolean).join("，").replace(/^，+|，+$/gu, "").trim();
  if (!rest) return clause;
  return `${clause}；${rest}`;
}

/** 若未改写句序，则高亮从首个边界关键词到句末（。；或换行）的片段 */
function extractBoundaryHighlightSpan(text: string): { before: string; hit: string; after: string } | null {
  const s = text.trim();
  if (!s) return null;
  let idx = -1;
  for (const p of RISK_BOUNDARY_SORT_PHRASES) {
    const i = s.indexOf(p);
    if (i !== -1 && (idx === -1 || i < idx)) {
      idx = i;
    }
  }
  if (idx < 0) return null;
  const from = s.slice(idx);
  let endRel = from.length;
  for (const sep of ["。", "；", "\n"] as const) {
    const j = from.indexOf(sep);
    if (j !== -1) endRel = Math.min(endRel, j + sep.length);
  }
  const hit = from.slice(0, endRel).trim();
  if (!hit) return null;
  const before = s.slice(0, idx);
  const after = from.slice(endRel);
  return { before, hit, after };
}

function renderNoticeItemBody(
  body: string,
  sourceById: Map<number, QwenKbSource>,
  onCitationClick?: (source: QwenKbSource, index: number) => void,
): ReactNode {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const promoted = promoteKnowledgeBoundaryClause(trimmed);
  const display = promoted.trim();
  if (display !== trimmed && display.length > 0) {
    return renderTextWithCitations(display, sourceById, onCitationClick);
  }
  const span = extractBoundaryHighlightSpan(display);
  if (span && span.hit.length > 0) {
    return (
      <>
        {span.before ? renderTextWithCitations(span.before, sourceById, onCitationClick) : null}
        <span className="font-semibold text-[var(--app-text)]">
          {renderTextWithCitations(span.hit, sourceById, onCitationClick)}
        </span>
        {span.after ? renderTextWithCitations(span.after, sourceById, onCitationClick) : null}
      </>
    );
  }
  return renderTextWithCitations(display, sourceById, onCitationClick);
}

function normalizeLooseCompare(s: string): string {
  return s.replace(/\[\d+\]/g, "").replace(/\s+/g, "");
}

function stepsRawLooksLikeProcessFlow(raw: string): boolean {
  const t = raw.replace(/\s+/g, "");
  const keys = [
    "流程",
    "办理",
    "申请",
    "提交",
    "法院",
    "仲裁",
    "受理",
    "审查",
    "期限",
    "材料",
    "立案",
    "起诉",
    "上诉",
    "执行",
    "公证",
    "调解",
    "听证",
    "答辩",
    "举证",
    "诉讼时效",
  ];
  return keys.some((k) => t.includes(k));
}

function tableHasConcreteTimeLimit(rows: { time: string }[]): boolean {
  return rows.some((r) => {
    const t = r.time.trim();
    if (!t) return false;
    return !t.includes("未提供明确时限");
  });
}

function isGenericEvidenceOnlyTable(parsed: ParsedActionStepsTable): boolean {
  const blob = parsed.rows.map((r) => `${r.step}${r.operation}`).join("");
  const genericHits = ["保存", "核查", "整理", "证据", "备份", "截图", "复印", "核实"].filter((k) =>
    blob.includes(k),
  ).length;
  return genericHits >= 2 && !stepsRawLooksLikeProcessFlow(blob);
}

function actionStepsRedundantWithAdvice(
  stepsRaw: string,
  adviceRaw: string,
  parsed: ParsedActionStepsTable | null,
): boolean {
  const adv = normalizeLooseCompare(adviceRaw);
  if (adv.length < 12) return false;
  if (parsed && parsed.rows.length > 0) {
    let hits = 0;
    for (const r of parsed.rows) {
      const op = normalizeLooseCompare(r.operation);
      if (op.length < 8) continue;
      const probe = op.slice(0, Math.min(28, op.length));
      if (adv.includes(probe)) hits++;
    }
    if (parsed.rows.length >= 2 && hits >= Math.ceil(parsed.rows.length * 0.85)) return true;
    if (parsed.rows.length === 1 && hits === 1) return true;
  }
  const sn = normalizeLooseCompare(stepsRaw);
  if (sn.length > 35 && adv.includes(sn.slice(0, Math.min(48, sn.length)))) return true;
  return false;
}

function shouldShowActionStepsSection(
  stepsRaw: string,
  adviceRaw: string,
  parsed: ParsedActionStepsTable | null,
): boolean {
  const raw = stepsRaw.trim();
  if (!raw) return false;
  const flowRaw = stepsRawLooksLikeProcessFlow(raw);

  if (parsed && parsed.rows.length > 0) {
    if (parsed.format === "legal_points") {
      if (actionStepsRedundantWithAdvice(raw, adviceRaw, parsed)) return false;
      return true;
    }

    const rows = parsed.rows;
    const concreteTime = tableHasConcreteTimeLimit(rows);
    const flowTable = rows.some((r) => stepsRawLooksLikeProcessFlow(`${r.step}${r.operation}${r.time}`));
    const signal = concreteTime || flowTable || flowRaw;

    if (!signal && !flowRaw && isGenericEvidenceOnlyTable(parsed)) return false;

    if (actionStepsRedundantWithAdvice(raw, adviceRaw, parsed)) return false;
    return true;
  }

  if (!flowRaw) return false;
  if (actionStepsRedundantWithAdvice(raw, adviceRaw, null)) return false;
  return true;
}

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
  return getDisplayChapterArticle(source);
}

function knowledgeSourceClickIndex(source: QwenKbSource, listIdx: number): number {
  if (typeof source.id === "number" && Number.isFinite(source.id) && source.id > 0) {
    return source.id;
  }
  return listIdx + 1;
}

function KnowledgeSourcesBlock({
  sources,
  compactHeader,
  onSourceClick,
}: {
  sources: QwenKbSource[];
  compactHeader?: boolean;
  onSourceClick?: (source: QwenKbSource, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="text-xs text-[var(--app-text-muted)]">
      <div className="flex items-center justify-between gap-2 py-0.5">
        <span className="min-w-0 flex-1 truncate">
          {compactHeader ? (
            <>
              已引用 <span className="font-medium text-[var(--app-text)]">{sources.length}</span> 条有效法条
            </>
          ) : (
            <>
              知识库来源 · 已引用 <span className="font-medium text-[var(--app-text)]">{sources.length}</span> 条有效法条
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--app-text-subtle)] transition hover:bg-[var(--app-surface-muted)]/50 hover:text-[var(--app-text)]"
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "展开"}
        </button>
      </div>

      {expanded ? (
        <div className="mt-2 space-y-3 border-t border-[var(--app-border)]/20 pt-3">
          {sources.map((source, listIdx) => {
            const safeUrl = normalizeExternalUrl(source.sourceUrl ?? null);
            const clickIndex = knowledgeSourceClickIndex(source, listIdx);
            const rowKey = `${source.id}-${listIdx}`;
            return (
              <div
                key={rowKey}
                className={cn(
                  "border-b border-[var(--app-border)]/15 pb-3 last:border-b-0 last:pb-0",
                  onSourceClick &&
                    "cursor-pointer rounded-lg px-0.5 outline-none transition hover:bg-[var(--app-surface-muted)]/40 focus-visible:ring-2 focus-visible:ring-[var(--app-primary)]/35",
                )}
                role={onSourceClick ? "button" : undefined}
                tabIndex={onSourceClick ? 0 : undefined}
                onClick={
                  onSourceClick
                    ? () => {
                        onSourceClick(source, clickIndex);
                      }
                    : undefined
                }
                onKeyDown={
                  onSourceClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSourceClick(source, clickIndex);
                        }
                      }
                    : undefined
                }
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] leading-snug text-[var(--app-text)]">
                  <span className="shrink-0 font-medium text-[var(--app-primary)]">[{source.id}]</span>
                  <span className="text-[var(--app-text-subtle)]/80">｜</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{source.lawName}</span>
                  <span className="text-[var(--app-text-subtle)]/80">｜</span>
                  <span className="max-w-[40%] truncate text-[var(--app-text-muted)]" title={chapterArticleLine(source)}>
                    {chapterArticleLine(source)}
                  </span>
                  <span className="text-[var(--app-text-subtle)]/80">｜</span>
                  <span className="shrink-0 truncate text-[var(--app-text-muted)]">{source.effectiveStatus}</span>
                  <span className="text-[var(--app-text-subtle)]/80">｜</span>
                  {safeUrl ? (
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener"
                      className="shrink-0 font-medium text-[var(--app-primary)] underline-offset-2 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      查看法规页面
                    </a>
                  ) : (
                    <span className="shrink-0 text-[var(--app-text-subtle)]">未提供</span>
                  )}
                </div>
                {source.text ? (
                  <div className="mt-1.5">
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
  const safeUrl = normalizeExternalUrl(source.sourceUrl ?? null);
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
              <div className="whitespace-pre-wrap break-words pr-2 text-[var(--app-text)]">
                <CitationLawTextDisplay source={source} />
              </div>
            </ScrollArea>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--app-text-subtle)]">来源链接</dt>
          <dd>
            {safeUrl ? (
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener"
                className="font-medium text-[var(--app-primary)] underline-offset-2 hover:underline"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                查看法规页面
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
  citationIndex,
  onCitationClick,
}: {
  label: string;
  source: QwenKbSource | undefined;
  citationIndex: number;
  onCitationClick?: (source: QwenKbSource, index: number) => void;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const useSidebar = Boolean(onCitationClick && source);
  const visible = !useSidebar && (open || hover);

  const toggle = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    },
    [],
  );

  const onSidebarMarkClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (source && onCitationClick) {
        onCitationClick(source, citationIndex);
      }
    },
    [citationIndex, onCitationClick, source],
  );

  useEffect(() => {
    if (useSidebar || !open) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      const el = rootRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, useSidebar]);

  if (!source) {
    return <span className="text-[var(--app-text)]">{label}</span>;
  }

  return (
    <span
      ref={rootRef}
      data-citation-root
      className={cn("inline align-baseline", !useSidebar && "relative")}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={cn(
          "mx-0.5 inline cursor-pointer rounded px-0.5 align-baseline font-medium text-[var(--app-primary)] underline decoration-dotted decoration-[var(--app-primary)]/55 underline-offset-[3px] hover:bg-[var(--app-primary-soft)] hover:text-[var(--app-primary-strong)]",
          !useSidebar && open && "bg-[var(--app-primary-soft)] text-[var(--app-primary-strong)]",
        )}
        aria-expanded={useSidebar ? undefined : open}
        aria-label={`引用 ${label}`}
        onClick={useSidebar ? onSidebarMarkClick : toggle}
      >
        {label}
      </button>
      {visible ? <CitationPopover source={source} /> : null}
    </span>
  );
}

export function renderTextWithCitations(
  text: string,
  sourceById: Map<number, QwenKbSource>,
  onCitationClick?: (source: QwenKbSource, index: number) => void,
): ReactNode {
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
    return (
      <InlineCitationMark
        key={`${idx}-${part}`}
        label={part}
        source={src}
        citationIndex={num}
        onCitationClick={onCitationClick}
      />
    );
  });
}

function ActionChecklistBlock({
  items,
  sourceById,
  muted,
  useModelNumbers,
  onCitationClick,
}: {
  items: string[];
  sourceById: Map<number, QwenKbSource>;
  muted?: boolean;
  /** 为 true 时优先显示模型给出的行首编号，不强制重排为 1.2.3. */
  useModelNumbers?: boolean;
  onCitationClick?: (source: QwenKbSource, index: number) => void;
}) {
  return (
    <ol className={cn("m-0 list-none space-y-3 p-0", muted && "opacity-80")}>
      {items.map((block, idx) => {
        const parsed = peelFirstLineListPrefix(block);
        const n = useModelNumbers && parsed.variant === "number" && parsed.num != null ? parsed.num : idx + 1;
        return (
          <li key={`${idx}-${block.slice(0, 24)}`} className="flex gap-3">
            <span
              className="mt-[0.35em] min-w-[1.5rem] shrink-0 text-right text-sm font-semibold tabular-nums text-[var(--app-text-muted)]"
              aria-hidden
            >
              {n}.
            </span>
            <div
              className={cn(
                "min-w-0 flex-1 text-base leading-relaxed text-[var(--app-text)]",
                muted && "text-[var(--app-text-muted)]",
              )}
            >
              {renderTextWithCitations(parsed.body, sourceById, onCitationClick)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function RiskBulletListBlock({
  items,
  sourceById,
  onCitationClick,
}: {
  items: string[];
  sourceById: Map<number, QwenKbSource>;
  onCitationClick?: (source: QwenKbSource, index: number) => void;
}) {
  return (
    <ul className="m-0 list-none space-y-2.5 p-0">
      {items.map((block, idx) => {
        const parsed = peelFirstLineListPrefix(block);
        const boundary = isRiskBoundarySortCategory(parsed.body);
        return (
          <li key={`${idx}-${block.slice(0, 24)}`} className="flex gap-2.5">
            {boundary ? (
              <span className="mt-[0.42em] flex w-4 shrink-0 justify-center text-amber-600/90 dark:text-amber-500/90" aria-hidden title="提示">
                ⚠
              </span>
            ) : (
              <span className="mt-[0.5em] shrink-0 text-[var(--app-text-muted)]" aria-hidden>
                •
              </span>
            )}
            <div
              className={cn(
                "min-w-0 flex-1 text-base leading-relaxed text-[var(--app-text)]",
                boundary && "font-medium",
              )}
            >
              {boundary
                ? renderNoticeItemBody(parsed.body, sourceById, onCitationClick)
                : renderTextWithCitations(parsed.body, sourceById, onCitationClick)}
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
  /** 流式生成中：文末光标、隐藏底部操作按钮，避免误点 */
  pending?: boolean;
  onRegenerate?: () => void;
  onCopy?: () => void;
  onFeedback?: () => void;
  /** 存在时：点击正文 [n] 仅触发回调并交给宿主展示详情（不弹出内联 Popover） */
  onCitationClick?: (source: QwenKbSource, index: number) => void;
  /** 存在时：知识库来源列表条目点击打开宿主侧栏；未传时回退为 onCitationClick */
  onSourceClick?: (source: QwenKbSource, index: number) => void;
};

/** 与 page.tsx SEC_P1 / SEC_P2 对齐；剥离开头小节标题 */
const DISP_P1 = "(?:[1１]\\s*(?:[)）]|[、,，]|[.．])\\s*|[一]\\s*[、,，.]\\s*)";
const DISP_P2 = "(?:[2２]\\s*(?:[)）]|[、,，]|[.．])\\s*|[二]\\s*[、,，.]\\s*)";

function sanitizeDisplayKeyFacts(text: string): string {
  if (!text.trim()) return text;
  const lines = text.split(/\r?\n/);
  let idx = 0;
  for (let guard = 0; guard < 6 && idx < lines.length; guard++) {
    const line = lines[idx] ?? "";
    if (!line.trim()) {
      idx++;
      guard--;
      continue;
    }
    const patterns: RegExp[] = [
      new RegExp(`^\\s*${DISP_P2}影响结果的关键事实\\s*(.*)$`),
      /^影响结果的关键事实\s*[：:]\s*(.*)$/,
      /^影响结果的关键事实\s+(.+)$/,
      /^影响结果的关键事实\s*$/,
      /^关键事实\s*[：:]\s*(.*)$/,
      /^关键事实\s+(.+)$/,
      /^关键事实\s*$/,
      /^核心判断要点\s*[：:]\s*(.*)$/,
      /^核心判断要点\s+(.+)$/,
      /^核心判断要点\s*$/,
      /^关键判断标准\s*[：:]\s*(.*)$/,
      /^关键判断标准\s+(.+)$/,
      /^关键判断标准\s*$/,
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
      new RegExp(`^\\s*${DISP_P1}直接结论\\s*(.*)$`),
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
      /^直接结论\s*[：:]\s*(.*)$/,
      /^直接结论\s+(.+)$/,
      /^直接结论\s*$/,
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
  pending,
  onRegenerate,
  onCopy,
  onFeedback,
  onCitationClick,
  onSourceClick,
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

  const suggestionBody = actionBodyRaw ? actionBodyRaw : PLACEHOLDER_SUGGESTION;

  const hasMeaningfulBasis =
    basisBodyRaw.length > 0 && basisBodyRaw !== PLACEHOLDER_BASIS;

  const isActionPlaceholder = suggestionBody === PLACEHOLDER_SUGGESTION;

  const keyFactsRaw = (answer.keyFacts ?? "").trim();
  const keyFactsDisplay = useMemo(() => {
    if (!keyFactsRaw) return "";
    return sanitizeDisplayKeyFacts(stripLeakedNoticeHeadingLines(keyFactsRaw));
  }, [keyFactsRaw]);

  const keyFactsItems = useMemo(() => {
    if (!keyFactsDisplay.trim()) return [];
    return splitActionLines(keyFactsDisplay);
  }, [keyFactsDisplay]);

  const showKeyFactsSection = keyFactsItems.length > 0;
  const showActionSection = !isActionPlaceholder;

  const conclusionDisplay = useMemo(() => {
    const stripped = stripLeakedNoticeHeadingLines(answer.conclusion ?? "");
    return sanitizeDisplayConclusion(stripped);
  }, [answer.conclusion]);

  const [basisOpen, setBasisOpen] = useState(false);

  const actionItems = useMemo(
    () => splitActionLines(stripLeakedNoticeHeadingLines(suggestionBody)),
    [suggestionBody],
  );

  const riskItems = useMemo(() => {
    if (isPlaceholderRiskContent(riskBodyRaw)) return [];
    let t = sanitizeRiskHeadingLabels(riskBodyRaw);
    t = stripLeakedNoticeHeadingLines(t);
    if (!t.trim()) return [];
    const blocks = splitActionLines(t);
    return sortRiskBlocksBoundaryLast(normalizeRiskBlocksForDisplay(blocks));
  }, [riskBodyRaw]);

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

  const showActionStepsSection = useMemo(
    () => shouldShowActionStepsSection(stepsRawTrimmed, actionBodyRaw, parsedStepsTable),
    [stepsRawTrimmed, actionBodyRaw, parsedStepsTable],
  );

  const sectionTitleClass = "mb-3 text-lg font-semibold tracking-tight text-[var(--app-text)]";

  return (
    <div className="w-full max-w-none bg-transparent py-0.5">
      <p className="mb-8 text-xs leading-relaxed text-[var(--app-text-muted)]">
        <span className="text-[var(--app-text-subtle)]">问题</span>
        {question ? ` · ${question}` : ""}
        <span className="mx-1.5 text-[var(--app-border)]/35">·</span>
        <span className="text-[var(--app-text-subtle)]">模型</span> {modelName}
      </p>

      <article className="max-w-none space-y-10 text-[var(--app-text)]">
        <section>
          <h2 className={sectionTitleClass}>结论</h2>
          <div className="text-base leading-relaxed text-[var(--app-text)]">
            {conclusionDisplay
              ? renderTextWithCitations(conclusionDisplay, sourceById, onCitationClick)
              : "未获取到回答。"}
          </div>
        </section>

        {showKeyFactsSection ? (
          <section>
            <h2 className={sectionTitleClass}>影响结果的关键事实</h2>
            <ActionChecklistBlock
              items={keyFactsItems}
              sourceById={sourceById}
              useModelNumbers
              onCitationClick={onCitationClick}
            />
          </section>
        ) : null}

        {showActionSection ? (
          <section>
            <h2 className={sectionTitleClass}>你现在可以这样处理</h2>
            <ActionChecklistBlock
              items={actionItems}
              sourceById={sourceById}
              useModelNumbers
              onCitationClick={onCitationClick}
            />
          </section>
        ) : null}

        {showActionStepsSection ? (
          <section>
            <h2 className={sectionTitleClass}>可执行操作步骤</h2>
            {stepsDisplayMode === "table" && parsedStepsTable ? (
              <ActionStepsTable
                rows={parsedStepsTable.rows}
                format={parsedStepsTable.format}
                headers={parsedStepsTable.headers}
                renderCell={(t) => renderTextWithCitations(t, sourceById, onCitationClick)}
              />
            ) : stepsDisplayMode === "prewrap" ? (
              <div className="overflow-x-auto text-base leading-relaxed text-[var(--app-text)]">
                <div className="min-w-0 whitespace-pre-wrap break-words">
                  {renderTextWithCitations(stepsRawTrimmed, sourceById, onCitationClick)}
                </div>
              </div>
            ) : (
              <ul className="m-0 list-none space-y-2.5 p-0">
                {stepBlocks.map((block, idx) => (
                  <li key={`step-${idx}-${block.slice(0, 20)}`} className="flex gap-2.5">
                    <span className="mt-[0.5em] shrink-0 text-[var(--app-text-muted)]" aria-hidden>
                      •
                    </span>
                    <div className="min-w-0 flex-1 text-base leading-relaxed text-[var(--app-text)]">
                      {renderTextWithCitations(block.trim(), sourceById, onCitationClick)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {riskItems.length > 0 ? (
          <section>
            <h2 className={sectionTitleClass}>需要注意</h2>
            <RiskBulletListBlock items={riskItems} sourceById={sourceById} onCitationClick={onCitationClick} />
          </section>
        ) : null}

        {hasMeaningfulBasis ? (
          <section className="space-y-2">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-lg font-semibold tracking-tight text-[var(--app-text)]">引用依据</h2>
              <button
                type="button"
                onClick={() => setBasisOpen((v) => !v)}
                className="text-xs text-[var(--app-text-muted)] transition hover:text-[var(--app-text)]"
                aria-expanded={basisOpen}
              >
                {basisOpen ? "收起" : "展开"}
              </button>
            </div>
            {basisOpen ? (
              <div className="text-base leading-relaxed text-[var(--app-text)]">
                {renderTextWithCitations(basisBodyRaw, sourceById, onCitationClick)}
              </div>
            ) : null}
          </section>
        ) : null}

        {sources.length > 0 ? (
          <section className="space-y-2">
            <h2 className={sectionTitleClass}>知识库来源</h2>
            <KnowledgeSourcesBlock
              sources={sources}
              compactHeader
              onSourceClick={onSourceClick ?? onCitationClick}
            />
          </section>
        ) : null}

        {pending ? (
          <span
            className="mt-2 inline-block h-[1.1em] w-0.5 translate-y-0.5 animate-pulse bg-[var(--app-primary)] align-baseline"
            aria-hidden
          />
        ) : null}
      </article>

      {!pending ? (
        <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--app-border)]/15 pt-4">
          <button
            type="button"
            onClick={onRegenerate}
            className="text-xs font-medium text-[var(--app-text-muted)] transition hover:text-[var(--app-primary)]"
          >
            重新生成
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="text-xs font-medium text-[var(--app-text-muted)] transition hover:text-[var(--app-primary)]"
          >
            复制
          </button>
          <button
            type="button"
            onClick={onFeedback}
            className="text-xs font-medium text-[var(--app-text-muted)] transition hover:text-[var(--app-primary)]"
          >
            反馈
          </button>
        </div>
      ) : null}
    </div>
  );
}
