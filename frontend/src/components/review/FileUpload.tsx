"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { submitReview } from "@/services/api";
import type { SubmitReviewResponse } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function FileUpload({
  defaultText = "",
  userGoal = "审查合同风险并给出修订建议",
  onSubmitted,
}: {
  defaultText?: string;
  userGoal?: string;
  onSubmitted?: (resp: SubmitReviewResponse) => void;
}) {
  const [text, setText] = useState(defaultText);

  const mutation = useMutation({
    mutationFn: () =>
      submitReview({
        contract_text: text,
        user_goal: userGoal,
      }),
    onSuccess: (resp) => onSubmitted?.(resp),
  });

  return (
    <Card className="border-slate-200 bg-white/80 shadow-sm backdrop-blur transition-all">
      <CardHeader>
        <CardTitle>合同文本输入</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">
            请直接粘贴合同文本（暂不做 PDF 解析）。
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="在此粘贴合同全文..."
            className="min-h-[220px] resize-y"
          />
        </div>

        {mutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>提交失败</AlertTitle>
            <AlertDescription>
              {mutation.error instanceof Error
                ? mutation.error.message
                : "未知错误"}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            将返回 thread_id，用于轮询状态与人工审批。
          </div>
          <Button
            onClick={() => {
              mutation.mutate();
            }}
            disabled={mutation.isPending || text.trim().length === 0}
          >
            {mutation.isPending ? "提交中…" : "开始审查"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

