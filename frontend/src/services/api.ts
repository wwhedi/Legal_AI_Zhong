import type {
  KBCreateJobRequest,
  KBCreateJobResponse,
  KBJobListResponse,
  KBJobSnapshotResponse,
  KBStartJobResponse,
  KBStopJobResponse,
  KBValidateReportSummaryResponse,
} from "@/types";

const DEFAULT_BASE_URL = "http://localhost:8000";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL
  );
}

/** Prefer FastAPI `detail` when body is JSON; keep raw body if parse fails. */
function formatHttpApiError(path: string, status: number, statusText: string, bodyText: string): string {
  const raw = bodyText.trim();
  if (!raw) {
    return `API ${status} ${statusText} for ${path}`;
  }
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const d = parsed.detail;
      if (typeof d === "string") {
        return `API ${status} ${statusText} for ${path}: ${d}`;
      }
      if (Array.isArray(d)) {
        const msg = d
          .map((item) => {
            if (item && typeof item === "object" && "msg" in item) {
              return String((item as { msg: unknown }).msg);
            }
            return JSON.stringify(item);
          })
          .join("; ");
        return `API ${status} ${statusText} for ${path}: ${msg}`;
      }
      return `API ${status} ${statusText} for ${path}: ${JSON.stringify(d)}`;
    }
  } catch {
    /* use raw */
  }
  return `API ${status} ${statusText} for ${path}: ${raw}`;
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
    credentials: "include",
    headers,
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(formatHttpApiError(path, resp.status, resp.statusText, text));
  }

  return (await resp.json()) as T;
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

export async function getKBUpdateValidateReportSummary(
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<KBValidateReportSummaryResponse> {
  return request<KBValidateReportSummaryResponse>(
    `/kb-update/jobs/${jobId}/validate-report-summary`,
    {
      method: "GET",
      signal: options?.signal,
    },
  );
}
