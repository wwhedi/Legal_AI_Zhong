"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, MessageSquarePlus } from "lucide-react";

const NAV_ITEMS = [
  { href: "/new-feature-chat", label: "知识库问答", icon: MessageSquarePlus },
  { href: "/kb-update", label: "更新知识库", icon: Database },
] as const;

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-[var(--app-sidebar-width)] shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-surface)]/95 text-[var(--app-text)] backdrop-blur-sm dark:border-sidebar-border dark:bg-sidebar dark:text-sidebar-foreground">
      <div className="flex h-12 items-center justify-center border-b border-[var(--app-border)] dark:border-sidebar-border">
        <div className="rounded-md bg-[var(--app-primary-soft)] px-2 py-0.5 text-[10px] font-bold tracking-tight text-[var(--app-primary)] dark:bg-sidebar-accent dark:text-sidebar-primary">
          AI
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`flex items-center justify-center rounded-lg p-2.5 transition-colors ${
                active
                  ? "bg-[var(--app-primary-soft)] text-[var(--app-primary)] ring-1 ring-[var(--app-primary)]/20 dark:bg-sidebar-accent dark:text-sidebar-primary-foreground dark:ring-sidebar-ring"
                  : "text-[var(--app-text-muted)] hover:bg-[var(--app-surface-soft)] hover:text-[var(--app-text)] dark:text-muted-foreground dark:hover:bg-sidebar-accent dark:hover:text-sidebar-accent-foreground"
              }`}
            >
              <Icon className="size-5" />
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
