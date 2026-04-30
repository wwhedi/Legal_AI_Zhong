"use client";

import { useMemo, useState } from "react";
import { Bot, Send, User } from "lucide-react";
import {
  QwenKbAnswerCard,
  type QwenAnswer,
  type QwenKbSource,
} from "@/components/chat/QwenKbAnswerCard";

type Role = "user" | "assistant";

type ChatItem = {
  id: string;
  role: Role;
  content: string;
  answerCard?: {
    answer: QwenAnswer;
    sources: QwenKbSource[];
    question: string;
    modelName: string;
  };
};

type NewRagResponse = {
  question: string;
  answer: string;
  model: string;
  retrieved_count: number;
  citations: Array<{
    ref_id?: string;
    law_name?: string;
    article?: string;
    score?: number;
    text?: string;
  }>;
};

const DEFAULT_BASE_URL = "http://localhost:8000";

function getApiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

function parseRefIdToNumber(refId?: string): number | null {
  const raw = String(refId ?? "").trim();
  const m = /^\[(\d+)\]$/.exec(raw) || /^(\d+)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function normalizeAnswer(answer: string): QwenAnswer {
  const text = (answer || "").trim();
  if (!text) {
    return {
      conclusion: "未获取到回答。",
      details: [],
    };
  }

  // 尝试按常见编号段落拆分：1)结论 ... 2)依据 ... 3)建议 ...
  const chunks = text
    .split(/(?=\b\d+\s*[).、：])/)
    .map((v) => v.trim())
    .filter(Boolean);

  if (chunks.length < 2) {
    return {
      conclusion: text,
      details: [],
    };
  }

  const stripLead = (s: string) => s.replace(/^\d+\s*[).、：]\s*/, "").trim();
  const conclusion = stripLead(chunks[0]);
  const details = chunks.slice(1).map((chunk, idx) => {
    const body = stripLead(chunk);
    const titleMatch = /^([^：:]{2,18})[：:]\s*(.+)$/s.exec(body);
    if (titleMatch) {
      return {
        title: titleMatch[1].trim(),
        content: titleMatch[2].trim(),
      };
    }
    return {
      title: `依据 ${idx + 1}`,
      content: body,
    };
  });
  return { conclusion, details };
}

function normalizeSources(citations: NewRagResponse["citations"]): QwenKbSource[] {
  const seen = new Set<number>();
  const result: QwenKbSource[] = [];
  for (const item of citations || []) {
    const id = parseRefIdToNumber(item.ref_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = (item.text || "").trim() || [item.law_name, item.article].filter(Boolean).join(" · ") || "暂无片段文本";
    result.push({
      id,
      text,
      score: typeof item.score === "number" ? item.score : undefined,
    });
  }
  return result.sort((a, b) => a.id - b.id).slice(0, 5);
}

export default function NewFeatureChatPage() {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastMeta, setLastMeta] = useState<{ model: string; retrievedCount: number } | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");

  const emptyHint = useMemo(() => "示例：竞业限制协议最多约定几年？", []);

  const send = async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading) return;

    const userMsg: ChatItem = { id: `u_${Date.now()}`, role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);
    if (!overrideQuestion) {
      setInput("");
    }
    setLastQuestion(question);
    setLoading(true);

    try {
      const resp = await fetch(`${getApiBaseUrl()}/new-rag/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as NewRagResponse;
      const normalizedAnswer = normalizeAnswer(data.answer || "");
      const normalizedSources = normalizeSources(data.citations || []);
      setMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: "assistant",
          content: data.answer || "未获取到回答",
          answerCard: {
            answer: normalizedAnswer,
            sources: normalizedSources,
            question,
            modelName: data.model || "qwen-plus",
          },
        },
      ]);
      setLastMeta({
        model: data.model || "qwen-plus",
        retrievedCount: Number(data.retrieved_count || 0),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setMessages((prev) => [
        ...prev,
        {
          id: `a_err_${Date.now()}`,
          role: "assistant",
          content: `调用失败：${msg}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-[#0b1020] text-slate-100">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4">
        <div>
          <h1 className="text-lg font-semibold">Qwen + 阿里云知识库</h1>
          <p className="text-xs text-slate-400">每次提问先检索知识库，再由 Qwen 生成答案</p>
        </div>
        {lastMeta ? (
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-300">
            模型：{lastMeta.model} · 检索片段：{lastMeta.retrievedCount}
          </div>
        ) : null}
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 pb-28">
        <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-800 bg-[#0f172a] p-4">
          {messages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-400">
              {emptyHint}
            </div>
          ) : null}
          {messages.map((m) => (
            <div key={m.id} className={`flex items-start gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
              {m.role === "assistant" ? (
                <div className="flex size-8 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-200">
                  <Bot className="size-4" />
                </div>
              ) : null}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-7 ${
                  m.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-100"
                }`}
              >
                {m.role === "assistant" && m.answerCard ? (
                  <QwenKbAnswerCard
                    answer={m.answerCard.answer}
                    sources={m.answerCard.sources}
                    question={m.answerCard.question}
                    modelName={m.answerCard.modelName}
                    onRegenerate={() => void send(m.answerCard?.question || lastQuestion)}
                    onCopy={() => {
                      // reserved for analytics hook
                    }}
                    onFeedback={() => {
                      // reserved for feedback API hook
                    }}
                  />
                ) : (
                  m.content
                )}
              </div>
              {m.role === "user" ? (
                <div className="flex size-8 items-center justify-center rounded-full bg-indigo-300/20 text-indigo-100">
                  <User className="size-4" />
                </div>
              ) : null}
            </div>
          ))}
          {loading ? <div className="text-sm text-slate-400">知识库检索与回答生成中...</div> : null}
        </div>
      </div>

      <div className="fixed bottom-0 left-14 right-0 border-t border-slate-800 bg-[#0b1020]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-end gap-2 px-4 py-3">
          <textarea
            className="min-h-12 max-h-48 flex-1 resize-y rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm outline-none focus:border-indigo-500"
            placeholder="输入问题，回车发送（Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            disabled={loading || !input.trim()}
            onClick={() => void send()}
            className="inline-flex h-12 items-center gap-1 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="size-4" />
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
