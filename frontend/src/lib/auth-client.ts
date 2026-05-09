const DEFAULT_BASE_URL = "http://localhost:8000";

/** 与后端 CORS + Cookie 登录一致：所有 auth / chat / new-rag 请求需携带凭证 */
export const credentialsInclude = { credentials: "include" as RequestCredentials };

export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

export type AuthUser = {
  id: string;
  username: string;
  display_name: string;
};

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch(`${getApiBaseUrl()}/auth/me`, {
    method: "GET",
    ...credentialsInclude,
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`GET /auth/me failed: ${res.status}`);
  }
  return (await res.json()) as AuthUser;
}

export async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch(`${getApiBaseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: username.trim(), password }),
    ...credentialsInclude,
  });
  if (res.ok) return { ok: true };
  let message = "登录失败";
  try {
    const data = (await res.json()) as { detail?: unknown };
    const d = data.detail;
    if (typeof d === "string") message = d;
    else if (d != null) message = JSON.stringify(d);
  } catch {
    message = `登录失败（HTTP ${res.status}）`;
  }
  return { ok: false, message };
}

export async function logout(): Promise<void> {
  await fetch(`${getApiBaseUrl()}/auth/logout`, {
    method: "POST",
    ...credentialsInclude,
  });
}

/** 包装 fetch，默认附带 Cookie（可覆盖 init.credentials） */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: init?.credentials ?? "include",
  });
}
