"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, RotateCcw, Send, Trash2, Upload, User, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { askLegalQuestion } from "@/services/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  useChatSessions,
  type CitationDetail,
  type ChatMessage,
} from "@/contexts/chat-sessions-context";
import {
  formatCitationSummaryLine,
  inferLawEffectKind,
  lawEffectTagClasses,
  verificationLabelZh,
  verifySourceLabelZh,
} from "@/lib/citation-styles";
import { sanitizeAssistantAnswerText, sanitizeMarkdownPart } from "@/lib/assistant-text";

function finalizeAssistantContent(raw: string): string {
  return sanitizeAssistantAnswerText(raw);
}

const EMPTY_MESSAGES: ChatMessage[] = [];

export const dynamic = "force-dynamic";

export default function ChatPage() {
  const { activeSession, updateActiveSession } = useChatSessions();

  const messages = activeSession?.messages ?? EMPTY_MESSAGES;
  const citationDetails = activeSession?.citationDetails ?? {};

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [agentAppId, setAgentAppId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("legal_ai_agent_app_id") || "";
  });
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [isCitationPanelOpen, setIsCitationPanelOpen] = useState(false);
  const [lastQuestion, setLastQuestion] = useState("");
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("legal_ai_agent_app_id", agentAppId.trim());
  }, [agentAppId]);

  const openCitationPanel = (ref: string) => {
    setSelectedRef(ref);
    setIsCitationPanelOpen(true);
  };

  const send = async (question?: string) => {
    const q = (question ?? input).trim();
    if (!q || loading || !activeSession) return;
    if (!agentAppId.trim()) {
      const assistantId = `a_${Date.now()}`;
      updateActiveSession({
        messages: [
          ...(activeSession.messages ?? []),
          {
            id: assistantId,
            role: "assistant",
            content: "当前后端已配置为仅允许调用智能体应用：请先填写上方的 APP_ID（智能体应用 ID）。",
            answerNeedsHumanReview: true,
          },
        ],
        updatedAt: Date.now(),
      });
      return;
    }
    const userMsg: ChatMessage = { id: `u_${Date.now()}`, role: "user", content: q };
    const base = [...messages, userMsg];
    const titleFromUser = q.length > 24 ? `${q.slice(0, 24)}…` : q;
    updateActiveSession({
      messages: base,
      title: titleFromUser,
      updatedAt: Date.now(),
    });
    setInput("");
    setLastQuestion(q);
    setLoading(true);
    await new Promise((r) => setTimeout(r, 450));

    const result = await (async () => {
      try {
            const resp = await askLegalQuestion({
          question: q,
              user_context: { agent_app_id: agentAppId.trim() },
        });
        const verificationMap = new Map<string, Record<string, unknown>>();
        (resp.verification_details || []).forEach((item) => {
          const raw = String(item?.raw ?? "");
          if (raw) verificationMap.set(raw, item);
        });
        const details = (resp.citations || []).map((c) => ({
          ref_id: c.ref_id,
          law_name: c.law_name ? `《${c.law_name}》` : "法规依据",
          article: c.article ? `第${c.article}条` : "条款待核验",
          evidence_status_display: c.status_display || undefined,
          status: c.verified === false ? ("Unverified" as const) : ("Verified" as const),
          verify_source: c.verify_source,
          excerpt:
            c.verified === false
              ? "该引用未通过自动校验，请人工复核后再作为依据使用。"
              : "该引用已通过自动校验。",
        }));
        details.forEach((d) => {
          const v = verificationMap.get(d.ref_id);
          if (!v) return;
          const evidence = v.fallback_evidence as Record<string, unknown> | undefined;
          if (evidence?.text && typeof evidence.text === "string") {
            d.excerpt = evidence.text.slice(0, 220);
          }
        });
        return {
          content: finalizeAssistantContent(resp.answer),
          citations: resp.citations || [],
          details,
          answerNeedsHumanReview: resp.answer_needs_human_review,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content:
            "后端调用失败。\n\n" +
            "- 请确认后端已启动（`uvicorn api.main:app --host 127.0.0.1 --port 8000`）\n" +
            "- 请检查后端日志与 `.env` 配置（`DASHSCOPE_API_KEY` / `REASONING_MODEL_NAME` / 智能体 APP_ID）\n\n" +
            `错误信息：${msg}`,
          citations: [],
          details: [],
          answerNeedsHumanReview: true,
        };
      }
    })();
    const assistantId = `a_${Date.now()}`;
    const finalContent = finalizeAssistantContent(result.content);
    const assistantShell: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      citations: result.citations,
      answerNeedsHumanReview: result.answerNeedsHumanReview,
    };

    for (let i = 1; i <= finalContent.length; i += 4) {
      const next = finalContent.slice(0, i);
      updateActiveSession({
        messages: [...base, { ...assistantShell, content: next }],
        updatedAt: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    const mergedDetails: Record<string, CitationDetail> = {
      ...(activeSession.citationDetails ?? {}),
    };
    result.details.forEach((d) => {
      mergedDetails[d.ref_id] = d;
    });
    updateActiveSession({
      messages: [...base, { ...assistantShell, content: finalContent }],
      citationDetails: mergedDetails,
      updatedAt: Date.now(),
    });
    setLoading(false);
  };

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, loading, messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = Math.floor(window.innerHeight * 0.3);
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [input]);

  const headerSubtitle = useMemo(() => "智能问答与法条检索", []);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#F9FAFB] text-slate-900">
      <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-slate-200/80 bg-[#F9FAFB]/90 px-4 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-5 shrink-0 text-blue-600" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">法律 AI 助手</h1>
            <p className="truncate text-xs text-slate-500">{headerSubtitle}</p>
          </div>
        </div>
        <div className="ml-3 flex min-w-0 items-center gap-2">
          <Badge
            variant="secondary"
            className={agentAppId.trim() ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}
          >
            智能体应用
          </Badge>
          <input
            value={agentAppId}
            onChange={(e) => setAgentAppId(e.target.value)}
            placeholder="APP_ID（留空则使用默认模型）"
            className="h-9 w-[min(560px,54vw)] rounded-lg border border-slate-200 bg-white/80 px-3 text-sm text-slate-800 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={chatScrollRef}
          className="h-full overflow-y-auto px-4 pb-40 pt-3"
        >
          <div className="mx-auto max-w-[900px] space-y-4">
            {messages.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                请输入法律问题，例如：自动续约条款是否存在合规风险？
              </p>
            ) : null}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex max-w-[min(92%,900px)] gap-2.5 text-sm ${
                  m.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                }`}
              >
                <div
                  className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
                    m.role === "user"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-slate-200/90 text-slate-600"
                  }`}
                  aria-hidden
                >
                  {m.role === "user" ? <User className="size-4" /> : <Bot className="size-4" />}
                </div>
                <div
                  className={`min-w-0 flex-1 ${
                    m.role === "user"
                      ? "rounded-3xl bg-blue-600 px-4 py-3 text-white shadow-sm"
                      : "rounded-3xl bg-slate-100/70 px-4 py-3 text-slate-800"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({ children }) => <h1 className="mb-3 text-xl font-semibold">{children}</h1>,
                        h2: ({ children }) => <h2 className="mb-3 text-lg font-semibold">{children}</h2>,
                        h3: ({ children }) => <h3 className="mb-2 text-base font-semibold">{children}</h3>,
                        p: ({ children }) => <p className="mb-3 leading-7 last:mb-0">{children}</p>,
                        ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-6">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-6">{children}</ol>,
                        li: ({ children }) => <li className="leading-7">{children}</li>,
                        blockquote: ({ children }) => (
                          <blockquote className="mb-3 border-l-4 border-slate-300 pl-3 text-slate-700">
                            {children}
                          </blockquote>
                        ),
                        code: ({ children }) => (
                          <code className="rounded bg-slate-200/70 px-1 py-0.5 text-[0.9em]">{children}</code>
                        ),
                        table: ({ children }) => (
                          <div className="mb-3 overflow-x-auto">
                            <table className="w-full border-collapse text-sm">{children}</table>
                          </div>
                        ),
                        th: ({ children }) => <th className="border border-slate-300 bg-slate-100 px-2 py-1">{children}</th>,
                        td: ({ children }) => <td className="border border-slate-300 px-2 py-1 align-top">{children}</td>,
                      }}
                    >
                      {sanitizeMarkdownPart(m.content)}
                    </ReactMarkdown>
                  ) : (
                    <div className="leading-[1.7] text-pretty [word-break:keep-all]">{m.content}</div>
                  )}
                  {m.citations?.length ? (
                    <div className="mt-4 flex flex-col gap-2 border-t border-slate-200/80 pt-3">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                        引用汇总
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {m.citations.map((c) => {
                          const kind = inferLawEffectKind(c);
                          const tag = lawEffectTagClasses(kind);
                          return (
                            <button
                              type="button"
                              key={`${m.id}-${c.ref_id}`}
                              onClick={() => openCitationPanel(c.ref_id)}
                              className={`rounded-md px-2.5 py-1.5 text-left text-xs font-medium shadow-sm ring-1 transition hover:scale-[1.02] hover:shadow-md ${tag.bg} ${tag.text} ${tag.ring}`}
                            >
                              {formatCitationSummaryLine(c)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {m.role === "assistant" && m.answerNeedsHumanReview ? (
                    <Alert className="mt-3 border-amber-300 bg-amber-50">
                      <AlertTitle>需要人工复核</AlertTitle>
                      <AlertDescription>
                        引用中存在未通过校验项，请法务复核后再作为最终结论使用。
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              </div>
            ))}
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                助手正在检索法规并生成回答
                <span className="inline-flex gap-1">
                  <span className="size-1.5 animate-pulse rounded-full bg-slate-400" />
                  <span className="size-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:120ms]" />
                  <span className="size-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:240ms]" />
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="pointer-events-none fixed bottom-0 left-14 right-0 z-30 flex justify-center px-4 pb-4 pt-10">
          <div className="pointer-events-auto w-full max-w-[900px] rounded-2xl border border-slate-200/80 bg-white/85 p-3 shadow-[0_8px_30px_rgb(0,0,0,0.08)] backdrop-blur-xl">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入你的法律问题..."
              className="max-h-[30vh] min-h-[52px] resize-none border-none bg-transparent p-1 leading-7 shadow-none focus-visible:ring-0"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <p className="mt-1.5 px-1 text-center text-[11px] text-slate-400">
              Enter 发送 · Shift+Enter 换行
            </p>
            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    updateActiveSession({
                      messages: [],
                      citationDetails: {},
                      title: "新对话",
                      updatedAt: Date.now(),
                    });
                    setSelectedRef(null);
                    setIsCitationPanelOpen(false);
                  }}
                  title="清除对话"
                >
                  <Trash2 className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => {}} title="上传文档">
                  <Upload className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void send(lastQuestion)}
                  disabled={!lastQuestion || loading}
                  title="重新生成"
                >
                  <RotateCcw className="size-4" />
                </Button>
              </div>
              <Button
                className="rounded-xl bg-blue-600 hover:bg-blue-700"
                onClick={() => void send()}
                disabled={loading || input.trim().length === 0 || agentAppId.trim().length === 0}
              >
                <Send className="mr-1 size-4" />
                {loading ? "发送中..." : "发送"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <aside
        className={`will-change-transform fixed inset-y-0 right-0 z-40 flex w-[min(380px,92vw)] flex-col border-l border-slate-200/80 bg-white/95 shadow-[-8px_0_30px_rgba(0,0,0,0.06)] backdrop-blur-xl transition-transform duration-300 ease-out motion-reduce:transition-none ${
          isCitationPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isCitationPanelOpen}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="text-sm font-semibold text-slate-800">引用详情</div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setIsCitationPanelOpen(false)}
            aria-label="关闭"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!selectedRef ? (
            <Alert>
              <AlertTitle>未选中引用</AlertTitle>
              <AlertDescription>
                点击回答中的 [1]/[2] 或引用标签，从右侧查看法条详情与校验状态。
              </AlertDescription>
            </Alert>
          ) : null}

          {selectedRef && citationDetails[selectedRef] ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                  {selectedRef}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    citationDetails[selectedRef].status === "Verified"
                      ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80"
                      : "bg-amber-50 text-amber-800 ring-1 ring-amber-200/80"
                  }`}
                >
                  {verificationLabelZh(citationDetails[selectedRef].status === "Verified")}
                </span>
              </div>
              <Separator />
              <div className="space-y-3">
                <h2 className="text-lg font-bold leading-snug text-slate-900">
                  {citationDetails[selectedRef].law_name} {citationDetails[selectedRef].article}
                </h2>
                {citationDetails[selectedRef].evidence_status_display ? (
                  <div className="text-sm text-slate-600">
                    法律状态：{citationDetails[selectedRef].evidence_status_display}
                  </div>
                ) : null}
                {citationDetails[selectedRef].verify_source ? (
                  <div className="text-xs text-slate-500">
                    校验来源：{verifySourceLabelZh(citationDetails[selectedRef].verify_source)}
                  </div>
                ) : null}
                <div className="rounded-xl bg-slate-50/90 p-4 text-[15px] leading-[1.65] text-slate-800">
                  {citationDetails[selectedRef].excerpt}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
