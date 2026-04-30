export type ReviewStatus =
  | "not_found"
  | "waiting_human_review"
  | "in_progress"
  | "completed";

export type CitationType = "bracket_ref" | "law_article";

export interface Citation {
  /** Example: "[1]" */
  ref_id: string;
  doc_id?: string | null;
  law_name?: string | null;
  /** article number extracted from metadata */
  article?: string | null;
  status?: string | null;
  status_display?: string | null;
  score?: number | null;
  verified?: boolean;
  verify_source?: "retrieved_context" | "kb_fallback" | "unverified" | string;
}

export interface RegulationCandidateDoc {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  source: string;
  score?: number;
  rrf_score?: number;
  raw_score?: number;
  final_score?: number;
  recall_sources?: string[];
}

export interface ClauseItem {
  clause_id: string;
  text: string;
  type?: string;
}

export interface CrossClauseDependency {
  from_clause_id: string;
  to_clause_id: string;
  relation: string;
  evidence?: string;
}

export interface RiskItem {
  clause_id?: string | null;
  reason: string;
  suggestion: string;
  title?: string;
  risk_id?: string;
  evidence?: {
    citations?: string[];
    matched_regulations?: Array<{
      law_name?: string;
      article_number?: string;
      status?: string;
    }>;
  };
}

export interface RiskAssessment {
  summary: string;
  high_risks: RiskItem[];
  medium_risks: RiskItem[];
  /** Optional for mock / future extension */
  low_risks?: RiskItem[];
  regulation_match_count?: number;
  cross_dependency_count?: number;
}

export interface HumanReviewInterruptPayload {
  type: "human_review_required";
  reason: string;
  risk_assessment?: RiskAssessment | Record<string, unknown>;
  critique_notes?: string[];
}

export interface ContractReviewReport {
  summary: string;
  risk_assessment: RiskAssessment | Record<string, unknown>;
  critique_notes?: string[];
  human_decision?: Record<string, unknown>;
  final_recommendation?: string;
}

/**
 * LangGraph contract review state snapshot (as JSON).
 * Note: backend may return partial subsets of this state via APIs.
 */
export interface ContractReviewState {
  contract_id?: string;
  contract_text?: string;
  user_goal?: string;
  plan?: string;
  extracted_clauses?: ClauseItem[];
  cross_clause_dependencies?: CrossClauseDependency[];
  regulation_candidates?: RegulationCandidateDoc[];
  risk_assessment?: RiskAssessment | Record<string, unknown>;
  critique_passed?: boolean;
  critique_notes?: string[];
  retry_count?: number;
  critique_route?: "search" | "assess" | "done";
  has_high_risk?: boolean;
  human_decision?: HumanReviewInterruptPayload | Record<string, unknown> | null;
  report?: ContractReviewReport | null;
}

export type LegalIntent =
  | "PRECISE_LOOKUP"
  | "CONCEPT_EXPLAIN"
  | "COMPLIANCE_CHECK"
  | "PROCEDURE_GUIDE"
  | "UNKNOWN";

export interface LegalQAState {
  question?: string;
  user_context?: Record<string, unknown>;
  intent?: LegalIntent;
  intent_reason?: string;
  retrieved_docs?: RegulationCandidateDoc[];
  answer?: string;
  citations?: Citation[];
  answer_needs_human_review?: boolean;
}

export interface AskQARequest {
  question: string;
  user_context?: Record<string, unknown>;
}

export interface AskQAResponse {
  question: string;
  intent?: LegalIntent;
  intent_reason?: string;
  answer: string;
  citations: Citation[];
  verification_details: Array<Record<string, unknown>>;
  agent_debug?: Record<string, unknown> | null;
  answer_needs_human_review: boolean;
}

export interface ApproveRegulationResponse {
  id: string;
  regulation_id: string;
  status: string;
  indexed_chunk_count: number;
}

// --- API DTOs ---

export interface SubmitReviewRequest {
  contract_id?: string | null;
  contract_text: string;
  user_goal?: string;
}

export interface SubmitReviewResponse {
  thread_id: string;
  status: "waiting_human_review" | "completed";
  event_count: number;
  risk_assessment: Record<string, unknown>;
  interrupt_payload: Record<string, unknown> | null;
}

export interface ReviewStatusResponse {
  thread_id: string;
  status: ReviewStatus;
  waiting_human_review?: boolean;
  interrupt_payload?: HumanReviewInterruptPayload | Record<string, unknown> | null;
  risk_assessment?: Record<string, unknown>;
  report?: ContractReviewReport | Record<string, unknown> | null;
  critique_notes?: string[];
}

export interface ApproveReviewRequest {
  approved: boolean;
  comment?: string | null;
  action?: "approve" | "revise" | null;
}

export interface ApproveReviewResponse {
  thread_id: string;
  status: "completed" | "in_progress";
  event_count: number;
  report?: ContractReviewReport | Record<string, unknown> | null;
  risk_assessment?: Record<string, unknown>;
}

export interface PendingRegulationItem {
  id: string;
  regulation_id: string;
  regulation_title?: string | null;
  summary?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PendingRegulationResponse {
  total: number;
  items: PendingRegulationItem[];
}

export type RegulationReviewStatus = "pending_review" | "success";

export interface RegulationDiffData {
  oldText: string;
  newText: string;
  aiSummary: string;
}

export interface PendingRegulationViewItem extends PendingRegulationItem {
  uiStatus: RegulationReviewStatus;
  diff: RegulationDiffData;
}

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

