import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ActionStepsTableRow = {
  step: string;
  operation: string;
  time: string;
};

export type ParsedActionStepsTable = {
  rows: ActionStepsTableRow[];
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

function headerMatchesRequirements(cells: string[]): boolean {
  const joined = cells.join("\u0001");
  if (!joined.includes("步骤")) return false;
  const opOk =
    cells.some((c) => c.includes("操作内容")) || cells.some((c) => c.trim() === "操作");
  const timeOk = cells.some(
    (c) => c.includes("法律时限") || c.includes("时限") || c.includes("时间"),
  );
  return opOk && timeOk;
}

function parseDataRow(cells: string[]): ActionStepsTableRow | null {
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

/**
 * 将「可执行操作步骤」中的 Markdown 风格表格解析为结构化行；不满足条件时返回 null。
 */
export function parseActionStepsTable(raw: string): ParsedActionStepsTable | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|")) continue;
    const cells = splitTableRow(line);
    if (cells.length < 2) continue;
    if (!headerMatchesRequirements(cells)) continue;
    headerIdx = i;
    break;
  }

  if (headerIdx === -1) return null;

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
    const row = parseDataRow(cells);
    if (row) rows.push(row);
  }

  if (rows.length < 1) return null;

  const normalized = rows.map((r, idx) => ({
    step: r.step.trim() || String(idx + 1),
    operation: r.operation.trim(),
    time: normalizeTimeCell(r.time),
  }));

  return { rows: normalized };
}

type ActionStepsTableProps = {
  rows: ActionStepsTableRow[];
  renderCell: (text: string) => ReactNode;
};

export function ActionStepsTable({ rows, renderCell }: ActionStepsTableProps) {
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
            <th className="w-[4.25rem] max-w-[5rem] shrink-0 whitespace-nowrap px-2.5 py-2 text-xs font-semibold text-[var(--app-text)] md:w-[5rem]">
              步骤
            </th>
            <th className="min-w-[10rem] px-2.5 py-2 text-xs font-semibold text-[var(--app-text)]">
              操作内容
            </th>
            <th className="w-[6.5rem] min-w-[5.5rem] max-w-[9rem] whitespace-normal px-2.5 py-2 text-xs font-semibold text-[var(--app-text)] md:w-[7.5rem]">
              时间/时限
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
                {r.step.trim() || String(idx + 1)}
              </td>
              <td className="align-top break-words px-2.5 py-2 text-sm leading-relaxed">
                {renderCell(r.operation)}
              </td>
              <td className="align-top break-words px-2.5 py-2 text-xs leading-relaxed text-[var(--app-text-muted)] md:text-sm">
                {renderCell(r.time)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
