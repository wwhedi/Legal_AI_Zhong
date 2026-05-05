"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

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
};

export function ProcessTimeline({ events, className }: ProcessTimelineProps) {
  const [open, setOpen] = useState(true);

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

  const rows = useMemo(() => {
    return events.filter((e) => {
      if (e.type === "done" || e.type === "error" || e.type === "answer" || e.type === "analysis") return false;
      if (e.type === "analysis_delta" || e.stage === "analysis_delta") return false;
      if (e.type === "answer_delta" || e.stage === "answer_delta") return false;
      if (LOW_VALUE_STAGES.has(e.stage)) return false;
      if (e.stage === "analysis_start" || e.stage === "analysis_done") return false;
      return true;
    });
  }, [events]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const threshold = 80;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < threshold) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  if (rows.length === 0 && !analysisRelevant) {
    return null;
  }

  return (
    <div
      className={cn(
        "rounded-[18px] border border-[var(--app-border)] bg-white text-[var(--app-text)] shadow-[var(--app-shadow-sm)]",
        className,
      )}
    >
      <div className="flex flex-col gap-1 border-b border-[var(--app-border)] px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--app-text)]">检索与依据分析</div>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--app-text-muted)]">用于说明本次回答依据</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 self-start rounded-lg border border-[var(--app-border)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--app-primary)] hover:bg-[var(--app-surface-soft)] sm:mt-0.5"
        >
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open ? (
        <div
          ref={scrollerRef}
          className="max-h-72 overflow-y-auto overscroll-contain bg-[var(--app-surface-muted)]/35 p-3"
        >
          <ul className="space-y-3">
            {rows.map((ev, idx) => (
              <TimelineRow
                key={`${ev.stage}-${ev.timestamp ?? idx}-${idx}`}
                ev={ev}
                compact={ev.stage === "answer_generation_start"}
              />
            ))}
          </ul>
          {analysisRelevant ? <AnalysisBody events={events} sourceById={sourceById} /> : null}
        </div>
      ) : null}
    </div>
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
      <EventDetail ev={ev} />
    </li>
  );
}

function AnalysisBody({
  events,
  sourceById,
}: {
  events: RagProcessEvent[];
  sourceById: Map<number, QwenKbSource>;
}) {
  const hasStart = events.some((e) => e.stage === "analysis_start");

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

  return (
    <div className="mt-3 border-t border-[var(--app-border)] pt-3">
      <div className="mb-1.5 text-[11px] font-semibold text-[var(--app-text)]">依据分析</div>
      {loading ? (
        <p className="mb-2 text-[11px] text-[var(--app-text-muted)]">正在生成依据分析……</p>
      ) : null}
      {displayText ? (
        <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-lg border border-[var(--app-border)]/90 bg-white px-2.5 py-2 text-[12px] leading-relaxed text-[var(--app-text)] shadow-[var(--app-shadow-sm)]">
          {renderTextWithCitations(displayText, sourceById)}
        </div>
      ) : null}
    </div>
  );
}

function EventDetail({ ev }: { ev: RagProcessEvent }) {
  const d = asRecord(ev.data);
  if (!d) return null;

  if (ev.stage === "query_rewrite_done") {
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

  if (ev.stage === "kb_retrieve_done") {
    const count = d.retrieved_count != null ? Number(d.retrieved_count) : 0;
    const summary = Array.isArray(d.citations_summary) ? d.citations_summary : [];
    return (
      <div className="mt-2 space-y-1.5 text-[11px]">
        <div className="text-[var(--app-text-muted)]">
          检索命中 <span className="font-semibold text-[var(--app-text)]">{Number.isFinite(count) ? count : 0}</span> 条片段
        </div>
        {summary.length > 0 ? (
          <ul className="space-y-1 rounded-[10px] border border-[var(--app-border)] bg-white p-2 shadow-[var(--app-shadow-sm)]">
            {summary.map((raw, i) => {
              const row = asRecord(raw);
              if (!row) return null;
              const refId = row.ref_id != null ? String(row.ref_id) : "";
              const name = row.law_name != null ? String(row.law_name) : "";
              const ch = row.chapter;
              const ar = row.article;
              const st = row.effective_status != null ? String(row.effective_status) : "";
              const sc = row.score;
              const sim =
                typeof sc === "number" && Number.isFinite(sc)
                  ? sc.toFixed(3)
                  : sc != null && String(sc).trim()
                    ? String(sc)
                    : "—";
              return (
                <li
                  key={`${refId}-${i}`}
                  className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 leading-snug text-[var(--app-text-muted)]"
                >
                  <span className="shrink-0 font-medium text-[var(--app-primary)]">{refId || "—"}</span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="min-w-0 font-medium text-[var(--app-text)]">{name || "未提供"}</span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="max-w-[42%] truncate" title={chapterArticle(ch, ar)}>
                    {chapterArticle(ch, ar)}
                  </span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="shrink-0">{st || "未提供"}</span>
                  <span className="text-[var(--app-text-subtle)]">｜</span>
                  <span className="shrink-0">相似度 {sim}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    );
  }

  if (ev.stage === "effective_filter_done") {
    const eff = d.effective_count != null ? Number(d.effective_count) : 0;
    const rem = d.removed_count != null ? Number(d.removed_count) : 0;
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--app-text-muted)]">
        已保留{" "}
        <span className="font-semibold tabular-nums text-[var(--app-text)]">{Number.isFinite(eff) ? eff : 0}</span>{" "}
        条有效法条，未纳入{" "}
        <span className="font-semibold tabular-nums text-[var(--app-text)]">{Number.isFinite(rem) ? rem : 0}</span>{" "}
        条。
      </p>
    );
  }

  if (ev.stage === "answer_generation_start") {
    return null;
  }

  return null;
}
