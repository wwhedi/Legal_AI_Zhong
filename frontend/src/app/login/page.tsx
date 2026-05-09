"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchMe, getSafeInternalPath, login as loginRequest } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (me) {
          const nextRaw =
            typeof window !== "undefined"
              ? new URLSearchParams(window.location.search).get("next")
              : null;
          const next = getSafeInternalPath(nextRaw);
          router.replace(next ?? "/new-feature-chat");
          return;
        }
      } catch {
        /* 网络异常时仍展示登录表单 */
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const u = username.trim();
    if (!u || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setSubmitting(true);
    try {
      const r = await loginRequest(u, password);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const nextRaw =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null;
      const next = getSafeInternalPath(nextRaw);
      router.replace(next ?? "/new-feature-chat");
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] text-[var(--app-text-muted)]">
        <p className="text-sm">加载中…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--app-bg)] px-4 text-[var(--app-text)]">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)] p-8 shadow-[var(--app-shadow-sm)]">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold">登录</h1>
          <p className="text-xs text-[var(--app-text-muted)]">使用分配的账号访问法律咨询对话</p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <label htmlFor="login-username" className="text-xs font-medium text-[var(--app-text-muted)]">
              用户名
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-xl border border-[var(--app-border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--app-primary)] dark:bg-[var(--app-surface-muted)]"
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="login-password" className="text-xs font-medium text-[var(--app-text-muted)]">
              密码
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-[var(--app-border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--app-primary)] dark:bg-[var(--app-surface-muted)]"
              disabled={submitting}
            />
          </div>
          {error ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] py-2.5 text-sm font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
