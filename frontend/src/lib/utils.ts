import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const ZW_CHARS = /[\u200B\u200C\u200D\uFEFF]/g
const CTRL_BREAK = /[\n\r\t]/g

/** 国家法律法规数据库 detail 链接：从 query 中抽取 id，仅保留字母数字并去掉 id 内空格 */
function normalizeFlkNpcDetailUrl(s: string): string | null {
  const flkIdx = s.search(/https?:\/\/flk\.npc\.gov\.cn\/detail\?id=/i)
  if (flkIdx < 0) return null
  const slice = s.slice(flkIdx)
  const m = slice.match(/^(https?:\/\/flk\.npc\.gov\.cn\/detail\?id=)(.*)$/i)
  if (!m) return null
  let id = ""
  for (const ch of m[2]) {
    if (/[A-Za-z0-9]/.test(ch)) id += ch
    else if (/\s/.test(ch)) continue
    else break
  }
  if (!id) return null
  const built = `${m[1]}${id}`
  try {
    const u = new URL(built)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return u.href
  } catch {
    return null
  }
}

/** 取首个 http(s) 片段，在空白或「【」前截断，避免尾随中文说明 */
function extractGenericHttpUrl(s: string): string | null {
  const gen = s.match(/https?:\/\/[^\s【]+/i)
  if (!gen) return null
  const candidate = gen[0].replace(/[，,;；。）)]+$/g, "")
  try {
    const u = new URL(candidate)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return u.href
  } catch {
    return null
  }
}

/**
 * 进入 QwenKbSource.sourceUrl 前强清洗：零宽/换行、npc 平台 id 拼接污染、尾随章节说明等。
 * 非法或非 http(s) 返回 null。
 */
export function normalizeExternalUrl(url?: string | null): string | null {
  if (url == null) return null
  let s = String(url).trim()
  if (!s) return null
  s = s.replace(ZW_CHARS, "").replace(CTRL_BREAK, "").trim()
  if (!s) return null

  const lower = s.toLowerCase()
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return null

  const flk = normalizeFlkNpcDetailUrl(s)
  if (flk) return flk

  return extractGenericHttpUrl(s)
}

/** 与 normalizeExternalUrl 一致：清洗后能解析为 http(s) 即视为合法 */
export function isValidExternalUrl(url?: string | null): boolean {
  return normalizeExternalUrl(url) !== null
}
