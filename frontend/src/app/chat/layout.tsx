import { ChatLayoutShell } from "@/components/chat/ChatLayoutShell";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <ChatLayoutShell>{children}</ChatLayoutShell>;
}
