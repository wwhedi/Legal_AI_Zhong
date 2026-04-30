import type {
  AskQARequest,
  AskQAResponse,
  KBCreateJobRequest,
  KBCreateJobResponse,
  KBJobListResponse,
  KBJobSnapshotResponse,
  KBStartJobResponse,
  KBStopJobResponse,
  ApproveReviewRequest,
  ApproveReviewResponse,
  ReviewStatusResponse,
  SubmitReviewRequest,
  SubmitReviewResponse,
} from "@/types";

const DEFAULT_BASE_URL = "http://localhost:8000";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL
  );
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const url = `${getBaseUrl()}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = new Headers(init?.headers);

  let body = init?.body;
  if (init && "json" in init) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json ?? null);
  }

  const resp = await fetch(url, {
    ...init,
    headers,
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `API ${resp.status} ${resp.statusText} for ${path}${
        text ? `: ${text}` : ""
      }`,
    );
  }

  // Most endpoints are JSON
  return (await resp.json()) as T;
}

export async function submitReview(
  payload: SubmitReviewRequest,
  options?: { signal?: AbortSignal },
): Promise<SubmitReviewResponse> {
  return request<SubmitReviewResponse>("/review/submit", {
    method: "POST",
    json: payload,
    signal: options?.signal,
  });
}

export async function pollReviewStatus(
  threadId: string,
  options?: { signal?: AbortSignal },
): Promise<ReviewStatusResponse> {
  return request<ReviewStatusResponse>(`/review/status/${threadId}`, {
    method: "GET",
    signal: options?.signal,
  });
}

export async function approveReview(
  threadId: string,
  payload: ApproveReviewRequest,
  options?: { signal?: AbortSignal },
): Promise<ApproveReviewResponse> {
  return request<ApproveReviewResponse>(`/review/approve/${threadId}`, {
    method: "POST",
    json: payload,
    signal: options?.signal,
  });
}

export async function askLegalQuestion(
  payload: AskQARequest,
  options?: { signal?: AbortSignal },
): Promise<AskQAResponse> {
  return request<AskQAResponse>("/qa/ask", {
    method: "POST",
    json: payload,
    signal: options?.signal,
  });
}

export async function createKBUpdateJob(
  payload: KBCreateJobRequest,
  options?: { signal?: AbortSignal },
): Promise<KBCreateJobResponse> {
  return request<KBCreateJobResponse>("/kb-update/jobs", {
    method: "POST",
    json: payload,
    signal: options?.signal,
  });
}

export async function startKBUpdateJob(
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<KBStartJobResponse> {
  return request<KBStartJobResponse>(`/kb-update/jobs/${jobId}/start`, {
    method: "POST",
    signal: options?.signal,
  });
}

export async function stopKBUpdateJob(
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<KBStopJobResponse> {
  return request<KBStopJobResponse>(`/kb-update/jobs/${jobId}/stop`, {
    method: "POST",
    signal: options?.signal,
  });
}

export async function getKBUpdateJob(
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<KBJobSnapshotResponse> {
  return request<KBJobSnapshotResponse>(`/kb-update/jobs/${jobId}`, {
    method: "GET",
    signal: options?.signal,
  });
}

export async function listKBUpdateJobs(
  options?: { signal?: AbortSignal },
): Promise<KBJobListResponse> {
  return request<KBJobListResponse>("/kb-update/jobs", {
    method: "GET",
    signal: options?.signal,
  });
}

