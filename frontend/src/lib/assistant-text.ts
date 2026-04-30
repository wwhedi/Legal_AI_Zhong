/**
 * 助手回答正文清洗：贴近法律意见书排版，减少孤行标点与引用错位。
 */

/** 将单独成行的 [n] 拼回上一行末尾，使其紧跟前文标点 */
export function attachOrphanCitationLines(text: string): string {
  return text.replace(/\n+\s*(\[\d+\])/g, "$1");
}

/** 将「[n]」后的换行与句号合并到同一行，便于后续统一为「句末标点 + [n]」 */
function mergeCitationAfterNewlinePeriod(text: string): string {
  return text.replace(/(\[\d+\])\s*\n+\s*([。．])/g, "$1$2");
}

/**
 * 规范为「句末标点 + [n]」：将「…文字[1]。」规范为「…文字。[1]」（符合「标点在前、引用紧跟其后」）。
 */
function reorderPeriodBeforeCitationBracket(text: string): string {
  return text.replace(/([^。\[\]\n]+)\[(\d+)\]\s*([。．])/g, "$1$3[$2]");
}

function mergeLonePunctuationLines(lines: string[]): string[] {
  const out: string[] = [];
  const lone = /^[。．，、；：！？\s]+$/;
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      out.push("");
      continue;
    }
    if (lone.test(t) && out.length > 0 && out[out.length - 1].trim() !== "") {
      out[out.length - 1] = `${out[out.length - 1].trimEnd()}${t}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * 清洗助手全文：去段首无意义项目符号、压缩空行、合并孤行标点、合并单独成行的引用。
 */
export function sanitizeAssistantAnswerText(raw: string): string {
  let t = raw.trim();
  if (!t) return t;

  t = t.replace(/^\uFEFF/, "");
  t = t.replace(/^\s*[-*•]\s+/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = attachOrphanCitationLines(t);
  t = mergeCitationAfterNewlinePeriod(t);
  t = reorderPeriodBeforeCitationBracket(t);

  const merged = mergeLonePunctuationLines(t.split("\n"));
  t = merged.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

/** 对单个文本块（非引用片段）做轻量清洗：去段首项目符号、合并单独成行的 [n] */
export function sanitizeMarkdownPart(part: string): string {
  let t = part.trim();
  if (!t) return t;
  t = t.replace(/^\s*[-*•]\s+/, "");
  t = attachOrphanCitationLines(t);
  return t;
}

/** 避免 [1] 与句号拆成独立片段导致「句号单独成行」；孤行标点不拼到纯 [n] token 上 */
function mergeOrphanSegments(parts: string[]): string[] {
  const out: string[] = [];
  const lonePunct = /^[。．，、；：！？,.!?;:]+$/;
  for (const p of parts) {
    if (!p) continue;
    const tr = p.trim();
    if (lonePunct.test(tr) && out.length > 0) {
      const last = out[out.length - 1] ?? "";
      if (/^\[\d+\]$/.test(last.trim()) && out.length >= 2) {
        out[out.length - 2] = `${out[out.length - 2].trimEnd()}${tr}`;
      } else if (/^\[\d+\]$/.test(last.trim())) {
        out.push(p);
      } else {
        out[out.length - 1] = `${last}${p}`;
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * 若片段在 [n] 之后且以句读开头，将句读挪到引用前的正文末尾（与 sanitize 中的「标点 + [n]」一致）。
 */
function moveLeadingPeriodBeforeCitation(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0 && /^\[\d+\]$/.test(parts[i - 1] ?? "") && p) {
      const m = /^\s*([。．])(\s*\n*)/.exec(p);
      if (m && out.length >= 2 && /^\[\d+\]$/.test(out[out.length - 1] ?? "")) {
        out[out.length - 2] = `${out[out.length - 2].trimEnd()}${m[1]}`;
        const rest = p.slice(m[0].length);
        if (rest.trim()) {
          out.push(rest);
        }
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** 按 [n] 拆分助手正文，供行内引用按钮与 Markdown 混排 */
export function splitCitationParts(text: string): string[] {
  const raw = text.split(/(\[\d+\])/g).filter(Boolean);
  return moveLeadingPeriodBeforeCitation(mergeOrphanSegments(raw));
}
