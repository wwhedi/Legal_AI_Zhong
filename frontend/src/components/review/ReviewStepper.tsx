"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { ReviewStatus } from "@/types";

const STEPS = [
  "计划抽取",
  "法规检索",
  "深度推理",
  "人工复核",
  "生成报告",
] as const;

function computeProgress(status: ReviewStatus | undefined) {
  if (status === "completed") return { percent: 100, stepIndex: 4 };
  if (status === "waiting_human_review") return { percent: 75, stepIndex: 3 };
  if (status === "in_progress") return { percent: 50, stepIndex: 2 };
  return { percent: 0, stepIndex: 0 };
}

export function ReviewStepper({
  status,
}: {
  status?: ReviewStatus;
}) {
  const { percent, stepIndex } = computeProgress(status);
  const label =
    status === "completed"
      ? "已完成"
      : status === "waiting_human_review"
        ? "待人工复核"
        : status === "in_progress"
          ? "处理中"
          : status === "not_found"
            ? "未找到"
            : "未开始";

  return (
    <Card className="border-slate-200 bg-white/80 shadow-sm backdrop-blur transition-all">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>审查进度</CardTitle>
        <Badge variant={status === "waiting_human_review" ? "destructive" : "default"}>
          {label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={percent} className="transition-all" />
        <div className="flex flex-wrap gap-2">
          {STEPS.map((s, idx) => {
            const active = idx <= stepIndex;
            return (
              <Badge
                key={s}
                variant={active ? "default" : "secondary"}
                className={`transition-all ${active ? "" : "opacity-70"}`}
              >
                {s}
              </Badge>
            );
          })}
        </div>
        <div className="text-xs text-muted-foreground">
          说明：当前为简化进度映射（后续可由后端返回更细粒度节点状态）。
        </div>
      </CardContent>
    </Card>
  );
}

