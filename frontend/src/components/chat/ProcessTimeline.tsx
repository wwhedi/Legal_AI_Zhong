"use client";

import { useMemo, useState } from "react";

import { renderTextWithCitations } from "@/components/chat/QwenKbAnswerCard";
import type { QwenKbSource, RagProcessEvent } from "@/types";
import { cn } from "@/lib/utils";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function formatKeywords(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean).join("、");
  }
  return "";
}

function chapterArticle(ch: unknown, ar: unknown): string {
  const c = ch != null ? String(ch).trim() : "";
  const a = ar != null ? String(ar).trim() : "";
  if (c === "未提供" && a === "未提供") return "未提供";
  if (c && c !== "未提供" && a && a !== "未提供") return `${c}；${a}`;
  return c && c !== "未提供" ? c : a || "未提供";
}

const LOW_VALUE_STAGES = new Set([
  "start",
  "query_rewrite_start",
  "kb_retrieve_start",
  "answer_generation_done",
]);

const MAX_KB_PREVIEW_ROWS = 3;
const ANALYSIS_SUMMARY_MAX_LINES = 5;

function parseRefNum(refId: unknown): number | null {
  const s = String(refId ?? "").trim();
  const m = /^\[(\d+)\]$/.exec(s) || /^(\d+)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function sourcesFromCitationSummary(summary: unknown[]): QwenKbSource[] {
  const out: QwenKbSource[] = [];
  for (const raw of summary) {
    const row = asRecord(raw);
    if (!row) continue;
    const id = parseRefNum(row.ref_id);
    if (!id) continue;
    const lawName = row.law_name != null ? String(row.law_name) : "未提供";
    const chapter = row.chapter != null ? String(row.chapter) : "未提供";
    const article = row.article != null ? String(row.article) : "未提供";
    const refRaw = row.ref_id != null ? String(row.ref_id).trim() : "";
    out.push({
      id,
      refId: refRaw || `[${id}]`,
      lawName,
      lawType: "未提供",
      effectiveStatus: row.effective_status != null ? String(row.effective_status) : "未提供",
      publishDate: row.publish_date != null ? String(row.publish_date) : "未提供",
      effectiveDate: row.effective_date != null ? String(row.effective_date) : "未提供",
      chapter,
      article,
      text: `${lawName} · ${chapterArticle(chapter, article)}`,
      sourceUrl: (() => {
        const su = row.source_url ?? row.sourceUrl;
        if (su == null) return null;
        const s = String(su).trim();
        return s ? s : null;
      })(),
      score: typeof row.score === "number" ? row.score : undefined,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

type ProcessTimelineProps = {
  events: RagProcessEvent[];
  className?: string;
  /** 未传时与历史行为一致：默认展开 */
  defaultOpen?: boolean;
  /** 收起时中间摘要文案；不传则根据事件推导「已引用 X 条…」或默认说明 */
  summaryText?: string;
};

function effectiveLawCountHint(events: RagProcessEvent[], citationCount: number): string | null {
  const filterEv = events.find((e) => e.stage === "effective_filter_done");
  const fd = asRecord(filterEv?.data);
  const eff = fd?.effective_count;
  if (typeof eff === "number" && Number.isFinite(eff) && eff > 0) {
    return `已引用 ${eff} 条有效法条`;
  }
  if (citationCount > 0) {
    return `已引用 ${citationCount} 条有效法条`;
  }
  return null;
}

export function ProcessTimeline({
  events,
  className,
  defaultOpen,
  summaryText,
}: ProcessTimelineProps) {
  const [open, setOpen] = useState(defaultOpen ?? true);

  const timingEvents = useMemo(() => events.filter((e) => e.type === "timing"), [events]);

  const timingSummaryLine = useMemo(() => {
    if (timingEvents.length === 0) return null;
    const done = [...timingEvents].reverse().find((e) => e.stage === "request_done");
    if (done) {
      const d = asRecord(done.data);
      const ms = d && typeof d.elapsed_ms === "number" ? d.elapsed_ms : null;
      if (ms != null && Number.isFinite(ms) && ms >= 0) {
        return `总耗时约 ${Math.round(ms)} ms`;
      }
      return "已完成";
    }
    return "处理进行中…";
  }, [timingEvents]);

  const analysisRelevant = useMemo(
    () =>
      events.some(
        (e) =>
          e.stage === "analysis_start" ||
          e.type === "analysis" ||
          e.stage === "analysis_done" ||
          e.type === "analysis_delta" ||
          e.stage === "analysis_delta",
      ),
    [events],
  );

  const citationSources = useMemo(() => {
    const hit = [...events].reverse().find((e) => e.stage === "kb_retrieve_done");
    const d = asRecord(hit?.data);
    const arr = d && Array.isArray(d.citations_summary) ? d.citations_summary : [];
    return sourcesFromCitationSummary(arr);
  }, [events]);

  const sourceById = useMemo(() => {
    const m = new Map<number, QwenKbSource>();
    for (const s of citationSources) {
      m.set(s.id, s);
    }
    return m;
  }, [citationSources]);

  const kbRetrieveEvent = useMemo(
    () => events.find((e) => e.stage === "kb_retrieve_done"),
    [events],
  );
  const effectiveFilterEvent = useMemo(
    () => events.find((e) => e.stage === "effective_filter_done"),
    [events],
  );

  const rows = useMemo(() => {
    return events.filter((e) => {
      if (e.type === "timing") return false;
      if (e.type === "done" || e.type === "error" || e.type === "answer" || e.type === "analysis") return false;
      if (e.type === "analysis_delta" || e.stage === "analysis_delta") return false;
      if (e.type === "answer_delta" || e.stage === "answer_delta") return false;
      if (LOW_VALUE_STAGES.has(e.stage)) return false;
      if (e.stage === "analysis_start" || e.stage === "analysis_done") return false;
      if (e.stage === "kb_retrieve_done" || e.stage === "effective_filter_done") return false;
      return true;
    });
  }, [events]);

  const shouldShow = useMemo(() => {
    if (rows.length > 0) return true;
    if (kbRetrieveEvent) return true;
    if (analysisRelevant) return true;
    if (timingEvents.length > 0) return true;
    return false;
  }, [rows.length, kbRetrieveEvent, analysisRelevant, timingEvents.length]);

  const collapsedSummaryMiddle = useMemo(() => {
    const trimmed = summaryText?.trim();
    if (trimmed) return trimmed;
    return effectiveLawCountHint(events, citationSources.length) ?? "用于说明本次回答依据";
  }, [summaryText, events, citationSources.length]);

  if (!shouldShow) {
    return null;
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-[var(--app-border)] bg-white/95 text-[var(--app-text)]",
        className,
      )}
    >
      {open ? (
        <>
          <div className="flex flex-col gap-1 border-b border-[var(--app-border)] px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--app-text)]">检索与依据分析</div>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--app-text-muted)]">用于说明本次回答依据</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 self-start rounded-lg border border-[var(--app-border)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--app-primary)] hover:bg-[var(--app-surface-soft)] sm:mt-0.5"
            >
              收起
            </button>
          </div>
          <div className="bg-[var(--app-surface-muted)]/35 p-3">
            <ul className="space-y-3">
              {rows.map((ev, idx) => (
                <TimelineRow
                  key={`${ev.stage}-${ev.timestamp ?? idx}-${idx}`}
                  ev={ev}
                  compact={ev.stage === "answer_generation_start"}
                />
              ))}
              {kbRetrieveEvent ? (
                <MergedKbRetrievalSection kbEv={kbRetrieveEvent} filterEv={effectiveFilterEvent} />
              ) : null}
            </ul>
            {analysisRelevant ? <AnalysisBody events={events} sourceById={sourceById} /> : null}
            {timingSummaryLine ? (
              <p className="mt-3 border-t border-[var(--app-border)]/80 pt-2.5 text-[10px] leading-snug text-[var(--app-text-subtle)]">
                {timingSummaryLine}
              </p>
            ) : null}
            {timingEvents.length > 0 ? <TimingDebugDetails events={timingEvents} /> : null}
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-x-1.5 gap-y-1 px-3 py-2.5 text-left transition hover:bg-[var(--app-surface-muted)]/25"
        >
          <span className="shrink-0 text-sm font-semibold text-[var(--app-text)]">检索与依据分析</span>
          <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">·</span>
          <span className="min-w-0 flex-1 truncate text-[11px] leading-snug text-[var(--app-text-muted)]">
            {collapsedSummaryMiddle}
          </span>
          <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">·</span>
          <span className="shrink-0 text-[11px] font-medium text-[var(--app-primary)]">展开</span>
        </button>
      )}
    </div>
  );
}


function MergedKbRetrievalSection({
  kbEv,
  filterEv,
}: {
  kbEv: RagProcessEvent;
  filterEv: RagProcessEvent | undefined;
}) {
  const dKb = asRecord(kbEv.data);
  const dFl = filterEv ? asRecord(filterEv.data) : null;
  const count = dKb && dKb.retrieved_count != null ? Number(dKb.retrieved_count) : 0;
  const summary = dKb && Array.isArray(dKb.citations_summary) ? dKb.citations_summary : [];
  const preview = summary.slice(0, MAX_KB_PREVIEW_ROWS);
  const eff = dFl && dFl.effective_count != null ? Number(dFl.effective_count) : null;
  const rem = dFl && dFl.removed_count != null ? Number(dFl.removed_count) : null;

  return (
    <li className="list-none border-l-2 border-[var(--app-primary)]/25 pl-3">
      <div className="text-[12px] font-semibold text-[var(--app-text)]">知识库检索结果</div>
      <div className="mt-1 space-y-1 text-[11px] leading-relaxed text-[var(--app-text-muted)]">
        <p>
          返回片段{" "}
          <span className="font-semibold tabular-nums text-[var(--app-text)]">
            {Number.isFinite(count) ? count : 0}
          </span>{" "}
          条
          {eff != null && Number.isFinite(eff) ? (
            <>
              ，有效法条{" "}
              <span className="font-semibold tabular-nums text-[var(--app-text)]">{eff}</span> 条
            </>
          ) : null}
          {rem != null && Number.isFinite(rem) && rem > 0 ? (
            <>
              ，未纳入{" "}
              <span className="font-semibold tabular-nums text-[var(--app-text)]">{rem}</span> 条
            </>
          ) : null}
        </p>
        {!filterEv ? <p className="text-[var(--app-text-subtle)]">有效法条筛选进行中…</p> : null}
      </div>
      {preview.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-[var(--app-border)]/60 pt-2 text-[11px]">
          {preview.map((raw, i) => {
            const row = asRecord(raw);
            if (!row) return null;
            const refId = row.ref_id != null ? String(row.ref_id) : "";
            const name = row.law_name != null ? String(row.law_name) : "";
            const ch = row.chapter;
            const ar = row.article;
            return (
              <li key={`${refId}-${i}`} className="leading-snug text-[var(--app-text-muted)]">
                <span className="font-medium text-[var(--app-primary)]">{refId || "—"}</span>
                <span className="text-[var(--app-text-subtle)]"> · </span>
                <span className="text-[var(--app-text)]">{name || "未提供"}</span>
                <span className="text-[var(--app-text-subtle)]"> · </span>
                <span>{chapterArticle(ch, ar)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {summary.length > MAX_KB_PREVIEW_ROWS ? (
        <p className="mt-1.5 text-[10px] text-[var(--app-text-subtle)]">
          另有 {summary.length - MAX_KB_PREVIEW_ROWS} 条片段未展开
        </p>
      ) : null}
    </li>
  );
}

function TimingDebugDetails({ events }: { events: RagProcessEvent[] }) {
  return (
    <details className="mt-2 rounded-lg border border-dashed border-[var(--app-border)] bg-white/60 px-2 py-1.5">
      <summary className="cursor-pointer text-[10px] text-[var(--app-text-subtle)]">技术详情（调试）</summary>
      <ul className="mt-1.5 space-y-0.5 text-[10px] text-[var(--app-text-muted)]">
        {events.map((e, i) => (
          <li key={`${e.stage}-${e.timestamp ?? i}`}>
            <span className="font-mono text-[var(--app-text-subtle)]">{e.stage}</span>
            {e.message ? <span className="ml-1 opacity-80">{e.message}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TimelineRow({ ev, compact }: { ev: RagProcessEvent; compact?: boolean }) {
  if (compact) {
    return (
      <li className="list-none py-0.5 text-[10px] leading-relaxed text-[var(--app-text-subtle)]">
        <span className="text-[var(--app-text-muted)]">· {ev.title}</span>
        {ev.message ? <span className="ml-1 text-[var(--app-text-muted)]">{ev.message}</span> : null}
      </li>
    );
  }

  return (
    <li className="border-l-2 border-[var(--app-primary)]/25 pl-3">
      <div className="text-[12px] font-semibold text-[var(--app-text)]">{ev.title}</div>
      {ev.message && ev.stage !== "query_rewrite_done" && ev.stage !== "kb_retrieve_done" ? (
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--app-text-muted)]">{ev.message}</p>
      ) : null}
      <QueryRewriteDetail ev={ev} />
    </li>
  );
}

function QueryRewriteDetail({ ev }: { ev: RagProcessEvent }) {
  if (ev.stage !== "query_rewrite_done") return null;
  const d = asRecord(ev.data);
  if (!d) return null;
  const intent = d.legal_intent != null ? String(d.legal_intent) : "";
  const kw = formatKeywords(d.core_keywords);
  const sq = d.search_query != null ? String(d.search_query) : "";
  if (!intent && !kw && !sq) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[11px]">
      {intent ? (
        <div className="flex flex-wrap items-start gap-1.5">
          <span className="shrink-0 rounded-md bg-[var(--app-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-text-subtle)]">
            法律意图
          </span>
          <span className="min-w-0 flex-1 rounded-md bg-[var(--app-primary-soft)]/80 px-2 py-0.5 text-[11px] text-[var(--app-text)]">
            {intent}
          </span>
        </div>
      ) : null}
      {kw ? (
        <div className="flex flex-wrap items-start gap-1.5">
          <span className="shrink-0 rounded-md bg-[var(--app-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-text-subtle)]">
            核心关键词
          </span>
          <span className="min-w-0 flex-1 rounded-md border border-[var(--app-border)]/90 bg-white px-2 py-0.5 text-[11px] text-[var(--app-text)]">
            {kw}
          </span>
        </div>
      ) : null}
      {sq ? (
        <div className="flex flex-wrap items-start gap-1.5">
          <span className="shrink-0 rounded-md bg-[var(--app-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-text-subtle)]">
            检索语句
          </span>
          <span className="min-w-0 flex-1 break-words rounded-md border border-dashed border-[var(--app-border)] bg-white px-2 py-0.5 text-[11px] text-[var(--app-text-muted)]">
            {sq}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function analysisSummarySnippet(text: string): { summary: string; needsExpand: boolean } {
  const t = text.trim();
  if (!t) return { summary: "", needsExpand: false };
  const lines = t.split(/\r?\n/);
  if (lines.length > ANALYSIS_SUMMARY_MAX_LINES) {
    return {
      summary: lines.slice(0, ANALYSIS_SUMMARY_MAX_LINES).join("\n").trim(),
      needsExpand: true,
    };
  }
  const long = t.length > 480;
  if (long) {
    return { summary: t.slice(0, 480).trimEnd() + "…", needsExpand: true };
  }
  return { summary: t, needsExpand: false };
}

function AnalysisBody({
  events,
  sourceById,
}: {
  events: RagProcessEvent[];
  sourceById: Map<number, QwenKbSource>;
}) {
  const hasStart = events.some((e) => e.stage === "analysis_start");
  /** 默认全文展开；用户点「收起依据分析」后保持其选择，不因新事件重置 */
  const [analysisExpanded, setAnalysisExpanded] = useState(true);

  const streamedAnalysis = useMemo(() => {
    let acc = "";
    for (const e of events) {
      if (e.type === "analysis_delta" || e.stage === "analysis_delta") {
        const d = asRecord(e.data);
        if (d && d.delta != null) acc += String(d.delta);
      }
    }
    return acc;
  }, [events]);

  const finalAnalysis = useMemo(() => {
    const doneEv = [...events].reverse().find((e) => e.type === "analysis" || e.stage === "analysis_done");
    const d = asRecord(doneEv?.data);
    return d && d.analysis != null ? String(d.analysis) : "";
  }, [events]);

  const finalTrim = finalAnalysis.trim();
  const displayText = finalTrim ? finalTrim : streamedAnalysis;
  const loading = hasStart && !displayText;

  if (!hasStart && !displayText) {
    return null;
  }

  const { summary, needsExpand } = analysisSummarySnippet(displayText);
  const showToggle = needsExpand || (displayText && summary !== displayText.trim());

  return (
    <div className="mt-4 border-t border-[var(--app-border)]/80 pt-3">
      {loading ? (
        <p className="text-[11px] text-[var(--app-text-muted)]">正在生成依据分析……</p>
      ) : displayText ? (
        <>
          <div className="text-[12px] leading-relaxed text-[var(--app-text)]">
            {analysisExpanded || !showToggle ? (
              renderTextWithCitations(displayText, sourceById)
            ) : (
              renderTextWithCitations(summary, sourceById)
            )}
          </div>
          {showToggle ? (
            <button
              type="button"
              onClick={() => setAnalysisExpanded((v) => !v)}
              className="mt-2 text-[11px] font-medium text-[var(--app-primary)] hover:underline"
            >
              {analysisExpanded ? "收起依据分析" : "展开依据分析"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
