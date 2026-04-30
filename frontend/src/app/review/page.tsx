"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { pollReviewStatus } from "@/services/api";
import type {
  ReviewStatusResponse,
  RiskAssessment,
  SubmitReviewResponse,
} from "@/types";

import { FileUpload } from "@/components/review/FileUpload";
import { ReviewStepper } from "@/components/review/ReviewStepper";
import { HumanReviewGate } from "@/components/review/HumanReviewGate";
import { FinalReport } from "@/components/review/FinalReport";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

function coerceRiskAssessment(
  value: ReviewStatusResponse["risk_assessment"] | undefined,
): RiskAssessment | null {
  const v = value as unknown as RiskAssessment | undefined;
  if (!v) return null;
  if (!Array.isArray(v.high_risks) || !Array.isArray(v.medium_risks)) return null;
  if (typeof v.summary !== "string") return null;
  return v;
}

export default function ReviewPage() {
  const queryClient = useQueryClient();

  const [threadId, setThreadId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("legal_ai_review_thread_id") || "";
  });
  const [, setSubmitResp] = useState<SubmitReviewResponse | null>(null);

  useEffect(() => {
    if (threadId) localStorage.setItem("legal_ai_review_thread_id", threadId);
  }, [threadId]);

  const statusQuery = useQuery({
    queryKey: ["reviewStatus", threadId],
    enabled: Boolean(threadId),
    queryFn: () => pollReviewStatus(threadId),
    refetchInterval: (query) => {
      const status = (query.state.data as ReviewStatusResponse | undefined)?.status;
      if (!status) return 2000;
      if (
        status === "waiting_human_review" ||
        status === "completed" ||
        status === "not_found"
      ) {
        return false;
      }
      return 2000;
    },
  });

  const status = statusQuery.data?.status;
  const riskAssessment = useMemo(
    () => coerceRiskAssessment(statusQuery.data?.risk_assessment),
    [statusQuery.data?.risk_assessment],
  );
  const effectiveStatus = status;
  const effectiveRisk = riskAssessment;
  const effectiveReport = statusQuery.data?.report;

  const resetReview = () => {
    localStorage.removeItem("legal_ai_review_thread_id");
    setThreadId("");
  };

  return (
    <div className="flex flex-1 justify-center bg-slate-50 px-4 py-10 text-slate-900 transition-colors">
      <div className="w-full max-w-4xl space-y-6">
        <div className="rounded-2xl border bg-white/70 p-5 shadow-sm backdrop-blur transition-all">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="text-2xl font-semibold tracking-tight">
                合同合规审查
              </div>
              <div className="text-sm text-slate-600">
                提交合同文本 → 自动审查 → 命中高风险则进入人工复核 → 审批后生成报告
              </div>
            </div>
            <div className="flex items-center gap-2">
              {threadId ? (
                <Badge variant="secondary" className="font-mono">
                  {threadId}
                </Badge>
              ) : (
                <Badge variant="secondary">等待提交</Badge>
              )}
              {statusQuery.isFetching ? (
                <Badge className="bg-blue-600 hover:bg-blue-600">轮询中…</Badge>
              ) : null}
              {effectiveStatus ? (
                <Badge variant="outline">{effectiveStatus}</Badge>
              ) : null}
            </div>
          </div>
        </div>

        <Separator />

        {!threadId ? (
          <div className="transition-all duration-300 ease-out">
            <FileUpload
              onSubmitted={(resp) => {
                setSubmitResp(resp);
                setThreadId(resp.thread_id);
              }}
            />
          </div>
        ) : null}

        {threadId ? (
          <div className="space-y-4 transition-all duration-300 ease-out">
            {statusQuery.isError ? (
              <Alert variant="destructive">
                <AlertTitle>状态查询失败</AlertTitle>
                <AlertDescription>
                  {statusQuery.error instanceof Error
                    ? statusQuery.error.message
                    : "未知错误"}
                </AlertDescription>
              </Alert>
            ) : null}

            {effectiveStatus === "in_progress" ? (
              <div className="transition-all duration-300 ease-out">
                <ReviewStepper status={effectiveStatus} />
              </div>
            ) : null}

            {effectiveStatus === "waiting_human_review" ? (
              <div className="transition-all duration-300 ease-out">
                <HumanReviewGate
                  threadId={threadId}
                  riskAssessment={effectiveRisk ?? null}
                  onApproved={() => {
                    // 审批后继续轮询，直到 completed
                    queryClient.invalidateQueries({
                      queryKey: ["reviewStatus", threadId],
                    });
                  }}
                />
              </div>
            ) : null}

            {effectiveStatus === "completed" && effectiveReport ? (
              <div className="transition-all duration-300 ease-out">
                <FinalReport report={effectiveReport} citations={[]} />
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" onClick={resetReview}>
                    新建审查
                  </Button>
                </div>
              </div>
            ) : null}

            {status === "not_found" ? (
              <Alert variant="destructive">
                <AlertTitle>thread_id 不存在</AlertTitle>
                <AlertDescription>
                  当前 thread 已不存在或后端已清理状态。请返回重新提交合同文本。
                </AlertDescription>
              </Alert>
            ) : null}

            {!effectiveStatus ? (
              <Alert>
                <AlertTitle>处理中</AlertTitle>
                <AlertDescription>
                  正在初始化审查流程并拉取状态，请稍候…
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

