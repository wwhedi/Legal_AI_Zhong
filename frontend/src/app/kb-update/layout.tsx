"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/auth-client";

type GateState = "loading" | "ok" | "forbidden" | "unauthenticated" | "error";

export default function KbUpdateLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [gate, setGate] = useState<GateState>("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (!me) {
          const dest = pathname || "/kb-update";
          router.replace(`/login?next=${encodeURIComponent(dest)}`);
          setGate("unauthenticated");
          return;
        }
        if (me.role !== "admin") {
          setGate("forbidden");
          return;
        }
        setGate("ok");
      } catch {
        if (!cancelled) setGate("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  if (gate === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center p-8 text-sm text-[var(--app-text-muted)]">
        验证权限中…
      </div>
    );
  }

  if (gate === "error") {
    return (
      <section className="mx-auto max-w-lg space-y-4 p-8">
        <h1 className="text-xl font-semibold text-[var(--app-text)]">无法验证登录状态</h1>
        <p className="text-sm text-[var(--app-text-muted)]">请检查网络后刷新页面，或返回对话首页。</p>
        <Link href="/new-feature-chat" className="text-sm text-[var(--app-primary)] underline">
          返回对话
        </Link>
      </section>
    );
  }

  if (gate === "forbidden") {
    return (
      <section className="mx-auto max-w-lg space-y-4 p-8">
        <h1 className="text-xl font-semibold text-[var(--app-text)]">无权限</h1>
        <p className="text-sm text-[var(--app-text-muted)]">仅管理员可访问知识库更新。</p>
        <Link href="/new-feature-chat" className="text-sm text-[var(--app-primary)] underline">
          返回对话
        </Link>
      </section>
    );
  }

  if (gate === "unauthenticated") {
    return (
      <div className="flex min-h-full items-center justify-center p-8 text-sm text-[var(--app-text-muted)]">
        正在跳转到登录页…
      </div>
    );
  }

  return <>{children}</>;
}
