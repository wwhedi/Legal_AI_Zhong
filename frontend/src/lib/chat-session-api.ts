import { apiFetch, getApiBaseUrl } from "@/lib/auth-client";
import type { ChatItem, ChatSession } from "@/types";
import type { RagProcessEvent } from "@/types";

export class ChatApiUnauthorizedError extends Error {
  override name = "ChatApiUnauthorizedError";
}

export class ChatApiNotFoundError extends Error {
  override name = "ChatApiNotFoundError";
}

export function isChatApiUnauthorized(e: unknown): boolean {
  return e instanceof ChatApiUnauthorizedError;
}

export function isChatApiNotFound(e: unknown): boolean {
  return e instanceof ChatApiNotFoundError;
}

function summaryRowToSession(row: { id: string; title: string; created_at: string; updated_at: string }): ChatSession {
  return {
    schemaVersion: 1,
    id: row.id,
    title: row.title,
    messages: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function apiMessageToChatItem(m: Record<string, unknown>): ChatItem {
  const id = String(m.id ?? "");
  const role = m.role === "assistant" ? "assistant" : "user";
  const content = m.content != null ? String(m.content) : "";
  const createdAt = String(m.created_at ?? "");
  const item: ChatItem = { id, role, content, createdAt };
  if (m.answer_card != null && typeof m.answer_card === "object") {
    item.answerCard = m.answer_card as ChatItem["answerCard"];
  }
  if (m.process_events != null && Array.isArray(m.process_events)) {
    item.processEvents = m.process_events as RagProcessEvent[];
  }
  return item;
}

async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.status === 401) throw new ChatApiUnauthorizedError();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
}

export async function apiListSessions(): Promise<ChatSession[]> {
  const res = await apiFetch(`${getApiBaseUrl()}/chat/sessions`);
  await ensureOk(res, "GET /chat/sessions");
  const rows = (await res.json()) as Array<{ id: string; title: string; created_at: string; updated_at: string }>;
  return rows.map(summaryRowToSession);
}

export async function apiCreateSession(title?: string): Promise<ChatSession> {
  const res = await apiFetch(`${getApiBaseUrl()}/chat/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ title: title ?? null }),
  });
  await ensureOk(res, "POST /chat/sessions");
  const row = (await res.json()) as { id: string; title: string; created_at: string; updated_at: string };
  return summaryRowToSession(row);
}

export async function apiGetSessionMessages(sessionId: string): Promise<{ session: ChatSession; messages: ChatItem[] }> {
  const res = await apiFetch(`${getApiBaseUrl()}/chat/sessions/${encodeURIComponent(sessionId)}`);
  if (res.status === 401) throw new ChatApiUnauthorizedError();
  if (res.status === 404) throw new ChatApiNotFoundError();
  await ensureOk(res, "GET /chat/sessions/{id}");
  const data = (await res.json()) as {
    session: { id: string; title: string; created_at: string; updated_at: string };
    messages: Record<string, unknown>[];
  };
  return {
    session: summaryRowToSession(data.session),
    messages: data.messages.map((row) => apiMessageToChatItem(row)),
  };
}

export async function apiPatchSessionTitle(sessionId: string, title: string): Promise<void> {
  const res = await apiFetch(`${getApiBaseUrl()}/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ title }),
  });
  await ensureOk(res, "PATCH /chat/sessions/{id}");
}

export async function apiDeleteSession(sessionId: string): Promise<void> {
  const res = await apiFetch(`${getApiBaseUrl()}/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  await ensureOk(res, "DELETE /chat/sessions/{id}");
}

export async function apiAppendMessage(
  sessionId: string,
  body: {
    role: "user" | "assistant";
    content?: string | null;
    answer_card?: unknown;
    process_events?: unknown;
    created_at?: string | null;
  },
): Promise<ChatItem> {
  const payload: Record<string, unknown> = {
    role: body.role,
    content: body.content ?? null,
    answer_card: body.answer_card ?? null,
    process_events: body.process_events ?? null,
    created_at: body.created_at ?? null,
  };
  const res = await apiFetch(`${getApiBaseUrl()}/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new ChatApiUnauthorizedError();
  if (res.status === 404) throw new ChatApiNotFoundError();
  await ensureOk(res, "POST /chat/sessions/{id}/messages");
  const row = (await res.json()) as Record<string, unknown>;
  return apiMessageToChatItem(row);
}
