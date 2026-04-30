import type { Metadata } from "next";
import "./globals.css";
import { QueryProvider } from "@/providers/query-provider";
import { AppSidebar } from "@/components/layout/AppSidebar";

export const metadata: Metadata = {
  title: "Legal AI Frontend",
  description: "Legal AI compliance review console",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-screen overflow-hidden bg-slate-50 text-slate-900">
        <QueryProvider>
          <div className="flex h-full min-h-0">
            <AppSidebar />
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
          </div>
        </QueryProvider>
      </body>
    </html>
  );
}
