"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Database, MessageSquarePlus } from "lucide-react";

const NAV_ITEMS = [
  { href: "/chat", label: "法律 AI 助手", icon: Bot },
  { href: "/new-feature-chat", label: "新问答页面", icon: MessageSquarePlus },
  { href: "/kb-update", label: "更新知识库", icon: Database },
] as const;

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-14 shrink-0 flex-col border-r border-slate-800/90 bg-slate-950 text-slate-100">
      <div className="flex h-12 items-center justify-center border-b border-slate-800">
        <div className="text-[10px] font-bold tracking-tight text-blue-300">AI</div>
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
                  ? "bg-blue-600/25 text-blue-100 ring-1 ring-blue-400/50"
                  : "text-slate-400 hover:bg-slate-900 hover:text-white"
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
