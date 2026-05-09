import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ActionStepsTableRow = {
  step: string;
  operation: string;
  time: string;
};

export type ActionStepsTableFormat = "legacy" | "legal_points";

export type ParsedActionStepsTable = {
  rows: ActionStepsTableRow[];
  format: ActionStepsTableFormat;
  /** 表头三列文案，与原文一致 */
  headers: [string, string, string];
};

const TIME_PLACEHOLDER = "未提供明确时限";

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1).trimStart();
  if (s.endsWith("|")) s = s.slice(0, -1).trimEnd();
  return s.split("|").map((c) => c.trim());
}

function isSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) {
    return /^[\s\-:]+$/.test(t) && /-/.test(t);
  }
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.replace(/\s+/g, "")));
}

function normalizeTimeCell(raw: string): string {
  const t = raw.trim();
  if (
    t === "" ||
    t === "-" ||
    t === "—" ||
    t === "–" ||
    t === "━" ||
    t === "无" ||
    t === "未提供" ||
    /^n\/?a$/i.test(t)
  ) {
    return TIME_PLACEHOLDER;
  }
  return t;
}

/** 新格式：阶段｜应对措施｜法律要点 */
function headerMatchesLegalPoints(cells: string[]): boolean {
  const joined = cells.join("\u0001");
  if (!joined.includes("阶段")) return false;
  const measureOk = cells.some((c) => c.includes("应对措施") || c.trim() === "措施");
  const pointOk = cells.some((c) => c.includes("法律要点") || c.trim() === "要点");
  return measureOk && pointOk;
}

/** 旧格式：步骤｜操作内容｜时间/时限 */
function headerMatchesLegacySteps(cells: string[]): boolean {
  const joined = cells.join("\u0001");
  if (!joined.includes("步骤")) return false;
  const opOk =
    cells.some((c) => c.includes("操作内容")) || cells.some((c) => c.trim() === "操作");
  const timeOk = cells.some(
    (c) => c.includes("法律时限") || c.includes("时限") || c.includes("时间"),
  );
  return opOk && timeOk;
}

function detectFormat(cells: string[]): ActionStepsTableFormat | null {
  if (headerMatchesLegalPoints(cells)) return "legal_points";
  if (headerMatchesLegacySteps(cells)) return "legacy";
  return null;
}

function headerLabelsFromCells(cells: string[]): [string, string, string] {
  if (cells.length <= 3) {
    return [
      (cells[0] ?? "").trim(),
      (cells[1] ?? "").trim(),
      (cells[2] ?? "").trim(),
    ];
  }
  const step = (cells[0] ?? "").trim();
  const last = (cells[cells.length - 1] ?? "").trim();
  const mid = cells
    .slice(1, -1)
    .map((c) => c.trim())
    .filter(Boolean)
    .join(" ");
  return [step, mid, last];
}

function parseDataRowLegacy(cells: string[]): ActionStepsTableRow | null {
  if (cells.length < 2) return null;

  if (cells.length === 2) {
    return {
      step: cells[0].trim(),
      operation: cells[1].trim(),
      time: TIME_PLACEHOLDER,
    };
  }

  if (cells.length === 3) {
    return {
      step: cells[0].trim(),
      operation: cells[1].trim(),
      time: normalizeTimeCell(cells[2]),
    };
  }

  const step = cells[0].trim();
  const timeRaw = cells[cells.length - 1].trim();
  const operation = cells
    .slice(1, -1)
    .map((c) => c.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    step,
    operation,
    time: normalizeTimeCell(timeRaw),
  };
}

/** 第三列为法律要点，不做「时限占位」归一化，保留 emoji 与原文（含「知识库未提供明确时限」等） */
function parseDataRowLegalPoints(cells: string[]): ActionStepsTableRow | null {
  if (cells.length < 2) return null;

  if (cells.length === 2) {
    return {
      step: cells[0].trim(),
      operation: cells[1].trim(),
      time: "",
    };
  }

  if (cells.length === 3) {
    return {
      step: cells[0].trim(),
      operation: cells[1].trim(),
      time: cells[2].trim(),
    };
  }

  const step = cells[0].trim();
  const last = cells[cells.length - 1].trim();
  const operation = cells
    .slice(1, -1)
    .map((c) => c.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    step,
    operation,
    time: last,
  };
}

function parseRow(cells: string[], format: ActionStepsTableFormat): ActionStepsTableRow | null {
  return format === "legal_points" ? parseDataRowLegalPoints(cells) : parseDataRowLegacy(cells);
}

/**
 * 将「可执行操作步骤」中的 Markdown 风格表格解析为结构化行；不满足条件时返回 null。
 */
export function parseActionStepsTable(raw: string): ParsedActionStepsTable | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let headerIdx = -1;
  let format: ActionStepsTableFormat | null = null;
  let headerCells: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|")) continue;
    const cells = splitTableRow(line);
    if (cells.length < 2) continue;
    const fmt = detectFormat(cells);
    if (!fmt) continue;
    headerIdx = i;
    format = fmt;
    headerCells = cells;
    break;
  }

  if (headerIdx === -1 || format == null) return null;

  const headers = headerLabelsFromCells(headerCells);

  let i = headerIdx + 1;
  if (i < lines.length && isSeparatorLine(lines[i])) {
    i += 1;
  }

  const rows: ActionStepsTableRow[] = [];

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|")) break;
    if (isSeparatorLine(line)) continue;

    const cells = splitTableRow(line);
    const row = parseRow(cells, format);
    if (row) rows.push(row);
  }

  if (rows.length < 1) return null;

  const normalized = rows.map((r, idx) =>
    format === "legal_points"
      ? {
          step: r.step.trim() || String(idx + 1),
          operation: r.operation.trim(),
          time: r.time,
        }
      : {
          step: r.step.trim() || String(idx + 1),
          operation: r.operation.trim(),
          time: normalizeTimeCell(r.time),
        },
  );

  return { rows: normalized, format, headers };
}

type ActionStepsTableProps = {
  rows: ActionStepsTableRow[];
  renderCell: (text: string) => ReactNode;
  format?: ActionStepsTableFormat;
  headers?: [string, string, string];
};

export function ActionStepsTable({
  rows,
  renderCell,
  format = "legacy",
  headers,
}: ActionStepsTableProps) {
  const [h0, h1, h2] = headers ?? [
    format === "legal_points" ? "阶段" : "步骤",
    format === "legal_points" ? "应对措施" : "操作内容",
    format === "legal_points" ? "法律要点" : "时间/时限",
  ];

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-lg border border-[var(--app-border)] bg-white",
        "shadow-[var(--app-shadow-sm)]",
      )}
    >
      <table className="w-full min-w-[280px] border-collapse text-left text-sm md:min-w-[480px]">
        <thead>
          <tr className="border-b border-[var(--app-border)] bg-[var(--app-surface-muted)]/95">
            <th className="w-[4.25rem] max-w-[6rem] shrink-0 whitespace-normal px-2.5 py-2 text-xs font-semibold text-[var(--app-text)] md:w-[5.5rem]">
              {h0}
            </th>
            <th className="min-w-[10rem] px-2.5 py-2 text-xs font-semibold text-[var(--app-text)]">{h1}</th>
            <th className="min-w-[5.5rem] max-w-[14rem] whitespace-normal px-2.5 py-2 text-xs font-semibold text-[var(--app-text)] md:min-w-[7rem]">
              {h2}
            </th>
          </tr>
        </thead>
        <tbody className="text-[var(--app-text)]">
          {rows.map((r, idx) => (
            <tr
              key={`${idx}-${r.step}-${r.operation.slice(0, 8)}`}
              className="border-b border-[var(--app-border)]/90 last:border-b-0"
            >
              <td className="align-top px-2.5 py-2 text-xs font-medium text-[var(--app-text-muted)] md:text-sm">
                {renderCell(r.step.trim() || String(idx + 1))}
              </td>
              <td className="align-top break-words px-2.5 py-2 text-sm leading-relaxed">
                {renderCell(r.operation)}
              </td>
              <td
                className={cn(
                  "align-top break-words px-2.5 py-2 text-xs leading-relaxed md:text-sm",
                  format === "legacy" ? "text-[var(--app-text-muted)]" : "text-[var(--app-text)]",
                )}
              >
                {renderCell(r.time)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
