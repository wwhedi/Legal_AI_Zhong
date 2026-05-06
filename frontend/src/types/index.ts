import type { QwenAnswer } from "@/components/chat/QwenKbAnswerCard";

/** /new-rag/ask-stream NDJSON 过程事件（与后端字段对齐） */
export type RagProcessEventType =
  | "progress"
  | "retrieval"
  | "analysis"
  | "analysis_delta"
  | "answer"
  | "answer_delta"
  | "error"
  | "done";

export type RagProcessEvent = {
  type: RagProcessEventType;
  stage: string;
  title: string;
  message?: string;
  data?: unknown;
  timestamp?: string;
};

export type KBRunMode = "full_run" | "step_run";
export type KBLawType =
  | "xf"
  | "flfg"
  | "xzfg"
  | "jcfg"
  | "sfjs"
  | "dfxfg"
  | "tiaoyue"
  | "shuangbian"
  | "duobian";
export type KBStepId =
  | "env_check"
  | "law_index_update"
  | "treaty_index_update"
  | "treaty_download"
  | "kb_export"
  | "kb_upload"
  | "result_summary";
export type KBJobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
export type KBStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface KBCreateJobRequest {
  law_type: KBLawType;
  storage_root: string;
  run_mode: KBRunMode;
  steps: KBStepId[];
  start_page: number;
  end_page: number;
  treaty_start_page: number;
  download_pdf: boolean;
}

export interface KBCreateJobResponse {
  job_id: string;
  status: KBJobStatus;
}

export interface KBStartJobResponse {
  job_id: string;
  status: KBJobStatus;
}

export interface KBStopJobResponse {
  job_id: string;
  status: KBJobStatus;
}

export interface KBStepProgress {
  step: KBStepId;
  label: string;
  status: KBStepStatus;
  started_at?: string | null;
  finished_at?: string | null;
  duration_seconds?: number | null;
}

export interface KBJobData {
  job_id: string;
  law_type: KBLawType;
  storage_root: string;
  run_mode: KBRunMode;
  steps: KBStepId[];
  start_page: number;
  end_page: number;
  treaty_start_page: number;
  download_pdf: boolean;
  status: KBJobStatus;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration_seconds?: number | null;
  error?: string | null;
  logs: string[];
  step_progress: KBStepProgress[];
}

export interface KBJobSnapshotResponse {
  job: KBJobData;
}

export interface KBJobListResponse {
  total: number;
  items: KBJobData[];
}

/** 新 RAG 知识库引用（与 /new-rag/ask citations 对齐，字段已规范化为展示用） */
export interface QwenKbSource {
  id: number;
  refId: string;
  lawName: string;
  lawType: string;
  effectiveStatus: string;
  publishDate: string;
  effectiveDate: string;
  chapter: string;
  article: string;
  text: string;
  sourceUrl: string | null;
  score?: number;
}

/** 知识库问答页单条消息（与 new-feature-chat 页内 ChatItem 对齐，供会话持久化复用） */
export type ChatItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  processEvents?: RagProcessEvent[];
  answerCard?: {
    answer: QwenAnswer;
    sources: QwenKbSource[];
    question: string;
    modelName: string;
    retrievedCount?: number;
  };
  createdAt?: string;
};

/** 本地会话容器（localStorage v1） */
export type ChatSession = {
  schemaVersion: 1;
  id: string;
  title: string;
  messages: ChatItem[];
  createdAt: string;
  updatedAt: string;
};
