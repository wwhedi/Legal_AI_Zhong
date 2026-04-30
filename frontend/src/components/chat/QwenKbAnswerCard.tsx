"use client";

export type QwenAnswerDetail = {
  title: string;
  content: string;
};

export type QwenAnswer = {
  conclusion: string;
  details: QwenAnswerDetail[];
};

export type QwenKbSource = {
  id: number;
  text: string;
  score?: number;
};

type QwenKbAnswerCardProps = {
  answer: QwenAnswer;
  sources: QwenKbSource[];
  question: string;
  modelName: string;
  onRegenerate?: () => void;
  onCopy?: () => void;
  onFeedback?: () => void;
};

export function QwenKbAnswerCard({
  answer,
  sources,
  question,
  modelName,
  onRegenerate,
  onCopy,
  onFeedback,
}: QwenKbAnswerCardProps) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
        <div className="mb-2 text-xs text-slate-400">
          问题：{question}
          <span className="ml-2 text-slate-500">模型：{modelName}</span>
        </div>
        <div className="text-sm leading-7 text-slate-100">{answer.conclusion || "未获取到回答。"}</div>
      </div>

      {answer.details.length > 0 ? (
        <div className="space-y-2">
          {answer.details.map((detail, idx) => (
            <div key={`${detail.title}_${idx}`} className="rounded-xl border border-slate-700/70 bg-slate-900/50 p-3">
              <div className="mb-1 text-xs font-medium text-indigo-300">{detail.title}</div>
              <div className="text-sm leading-7 text-slate-200">{detail.content}</div>
            </div>
          ))}
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
          <div className="mb-2 text-xs font-medium text-slate-300">知识库来源</div>
          <div className="space-y-2">
            {sources.map((source) => (
              <div key={source.id} className="rounded-lg border border-slate-700/70 bg-slate-950/40 p-2 text-xs text-slate-300">
                <div className="mb-1 text-slate-400">
                  [{source.id}]
                  {typeof source.score === "number" ? ` · 相关度 ${source.score.toFixed(3)}` : ""}
                </div>
                <div className="line-clamp-4 whitespace-pre-wrap break-words">{source.text}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={onRegenerate}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          重新生成
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          复制
        </button>
        <button
          type="button"
          onClick={onFeedback}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          反馈
        </button>
      </div>
    </div>
  );
}

