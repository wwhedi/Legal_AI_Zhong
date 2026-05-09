"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { normalizeExternalUrl } from "@/lib/utils";
import type { QwenKbSource } from "@/types";

export type CitationSidePanelProps = {
  open: boolean;
  onClose: () => void;
  source: QwenKbSource | null;
  citationIndex: number | null;
};

/** 中文数字条号，如第十八条、第一千零七十九条 */
const ARTICLE_RE = /第[一二三四五六七八九十百千万零〇两]+条/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractArticleNumber(text?: string): string | null {
  if (!text?.trim()) return null;
  const matches = text.match(ARTICLE_RE);
  if (!matches?.length) return null;
  return matches[matches.length - 1] ?? null;
}

export function cleanChapterText(text: string, articleNumber: string | null): string {
  let s = text.trim();
  if (!s || s === "未提供") return s;
  if (!articleNumber) return s;

  const segments = s
    .split(/[；;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((seg) => seg !== articleNumber);
  s = segments.join(" ").trim();

  const trailingSpaced = new RegExp(`\\s+${escapeRegExp(articleNumber)}\\s*$`);
  s = s.replace(trailingSpaced, "").trim();

  s = s.replace(/[、，,\s]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[；;、，,]+|[；;、，,]+$/g, "").trim();

  if (!s) return articleNumber;
  return s;
}

export function buildDisplayLawText(lawText?: string, articleNumber?: string | null): string {
  const body = (lawText ?? "").trim();
  if (!articleNumber || !body) return body;
  const re = new RegExp(`^\\s*${escapeRegExp(articleNumber)}(\\s|　|[、，。])*`);
  if (re.test(body)) return body;
  return `${articleNumber}  ${body}`;
}

export function combineChapterArticleFields(source: QwenKbSource): string {
  const ch = source.chapter;
  const ar = source.article;
  if (ch === "未提供" && ar === "未提供") return "未提供";
  if (ch !== "未提供" && ar !== "未提供") return `${ch}；${ar}`;
  return ch !== "未提供" ? ch : ar;
}

export function getDisplayChapterArticle(source: QwenKbSource): string {
  const raw = combineChapterArticleFields(source);
  if (raw === "未提供") return "未提供";
  const article = extractArticleNumber(raw);
  return cleanChapterText(raw, article);
}

export function CitationLawTextDisplay({ source }: { source: QwenKbSource }) {
  const raw = combineChapterArticleFields(source);
  const articleNumber = extractArticleNumber(raw);
  const display = buildDisplayLawText(source.text, articleNumber);
  if (!display) return null;
  if (articleNumber && display.startsWith(articleNumber)) {
    const rest = display.slice(articleNumber.length);
    return (
      <>
        <strong className="font-semibold text-[var(--app-text)]">{articleNumber}</strong>
        {rest}
      </>
    );
  }
  return <>{display}</>;
}

function buildPlainCitationBody(src: QwenKbSource): string {
  const chapLine = getDisplayChapterArticle(src);
  const raw = combineChapterArticleFields(src);
  const art = extractArticleNumber(raw);
  const body = (buildDisplayLawText(src.text, art) ?? "").trim();
  const lines: string[] = [];
  if (src.lawName?.trim()) lines.push(src.lawName.trim());
  if (chapLine && chapLine !== "未提供") lines.push(chapLine);
  if (body) lines.push(body);
  return lines.join("\n\n");
}

export function CitationSidePanel({ open, onClose, source, citationIndex }: CitationSidePanelProps) {
  const safeUrl = normalizeExternalUrl(source?.sourceUrl ?? null);
  const indexLabel = citationIndex ?? source?.id;

  const [copyLinkFeedback, setCopyLinkFeedback] = useState<{ kind: "ok" | "fail"; sourceId: number } | null>(
    null,
  );
  const [copyTextFeedback, setCopyTextFeedback] = useState<{ kind: "ok" | "fail"; sourceId: number } | null>(
    null,
  );
  const copyLinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyLinkTimer.current) clearTimeout(copyLinkTimer.current);
      if (copyTextTimer.current) clearTimeout(copyTextTimer.current);
    };
  }, []);

  const copyLink = async () => {
    if (!safeUrl || !source) return;
    const sid = source.id;
    try {
      await navigator.clipboard.writeText(safeUrl);
      setCopyLinkFeedback({ kind: "ok", sourceId: sid });
      setCopyTextFeedback(null);
    } catch {
      setCopyLinkFeedback({ kind: "fail", sourceId: sid });
    }
    if (copyLinkTimer.current) clearTimeout(copyLinkTimer.current);
    copyLinkTimer.current = setTimeout(() => setCopyLinkFeedback(null), 2000);
  };

  const copyLawText = async () => {
    if (!source) return;
    const sid = source.id;
    const plain = buildPlainCitationBody(source);
    if (!plain) return;
    try {
      await navigator.clipboard.writeText(plain);
      setCopyTextFeedback({ kind: "ok", sourceId: sid });
      setCopyLinkFeedback(null);
    } catch {
      setCopyTextFeedback({ kind: "fail", sourceId: sid });
    }
    if (copyTextTimer.current) clearTimeout(copyTextTimer.current);
    copyTextTimer.current = setTimeout(() => setCopyTextFeedback(null), 2000);
  };

  const showLinkOk = copyLinkFeedback?.kind === "ok" && copyLinkFeedback.sourceId === source?.id;
  const showLinkFail = copyLinkFeedback?.kind === "fail" && copyLinkFeedback.sourceId === source?.id;
  const showTextOk = copyTextFeedback?.kind === "ok" && copyTextFeedback.sourceId === source?.id;
  const showTextFail = copyTextFeedback?.kind === "fail" && copyTextFeedback.sourceId === source?.id;

  return (
    <div
      aria-hidden={!open}
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-white text-[var(--app-text)] dark:bg-[var(--app-surface)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--app-border)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--app-text)]">引用详情</h2>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--app-text-muted)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]"
          aria-label="关闭引用详情"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
        {!source ? (
          <p className="text-sm leading-relaxed text-[var(--app-text-muted)]">点击正文中的引用编号查看详情</p>
        ) : (
          <>
            <div className="mb-4 border-b border-[var(--app-border)] pb-3 font-semibold text-[var(--app-text)]">
              引用{" "}
              <span className="text-[var(--app-primary)]">
                [{typeof indexLabel === "number" ? indexLabel : source.id}]
              </span>
            </div>
            <dl className="space-y-3 text-xs leading-relaxed">
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
                <dd className="break-words text-[var(--app-text)]">{getDisplayChapterArticle(source)}</dd>
              </div>
              <div>
                <dt className="text-[var(--app-text-subtle)]">法规正文</dt>
                <dd>
                  <div className="mb-1.5 flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyLawText();
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="text-[11px] font-medium text-[var(--app-text-subtle)] underline-offset-2 transition hover:text-[var(--app-primary)] hover:underline"
                    >
                      复制条文
                    </button>
                    {showTextOk ? (
                      <span className="text-[11px] text-[var(--app-text-muted)]" aria-live="polite">
                        已复制
                      </span>
                    ) : showTextFail ? (
                      <span className="text-[11px] text-[var(--app-text-muted)]" aria-live="polite">
                        复制失败
                      </span>
                    ) : null}
                  </div>
                  <ScrollArea className="h-40 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-2">
                    <div className="whitespace-pre-wrap break-words pr-2 text-[var(--app-text)]">
                      <CitationLawTextDisplay source={source} />
                    </div>
                  </ScrollArea>
                </dd>
              </div>
              <div>
                <dt className="text-[var(--app-text-subtle)]">来源链接</dt>
                <dd className="space-y-1.5">
                  {safeUrl ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyLink();
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="font-medium text-[var(--app-text-subtle)] underline-offset-2 transition hover:text-[var(--app-primary)] hover:underline"
                      >
                        复制链接
                      </button>
                      {showLinkOk ? (
                        <span className="text-[var(--app-text-muted)]" aria-live="polite">
                          已复制
                        </span>
                      ) : showLinkFail ? (
                        <span className="text-[var(--app-text-muted)]" aria-live="polite">
                          复制失败
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-[var(--app-text-muted)]">链接：未提供</span>
                  )}
                  <p className="text-[10px] leading-relaxed text-[var(--app-text-muted)]">
                    该链接可能指向法规页面，未必能直接定位到本条文；请以本面板展示的条文正文为准。
                  </p>
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
