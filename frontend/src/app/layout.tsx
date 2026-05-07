import type { Metadata } from "next";
import "./globals.css";
import { QueryProvider } from "@/providers/query-provider";
import { AppSidebar } from "@/components/layout/AppSidebar";

export const metadata: Metadata = {
  title: "Legal AI Frontend",
  description: "Legal AI knowledge base and regulation crawler console",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-screen overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)] dark:bg-background dark:text-foreground">
        <QueryProvider>
          <div className="flex h-full min-h-0">
            <AppSidebar />
            <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
          </div>
        </QueryProvider>
      </body>
    </html>
  );
}
