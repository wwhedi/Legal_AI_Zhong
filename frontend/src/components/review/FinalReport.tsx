"use client";

import type { Citation, ContractReviewReport, RiskAssessment } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

function asRiskAssessment(
  value: ContractReviewReport["risk_assessment"],
): RiskAssessment | null {
  const v = value as RiskAssessment | undefined;
  if (!v) return null;
  if (!Array.isArray(v.high_risks) || !Array.isArray(v.medium_risks)) return null;
  return v;
}

export function FinalReport({
  report,
  citations = [],
}: {
  report: ContractReviewReport | Record<string, unknown>;
  citations?: Citation[];
}) {
  const r = report as ContractReviewReport;
  const ra = asRiskAssessment(r.risk_assessment);
  const suggestions = [
    ...(ra?.high_risks ?? []),
    ...(ra?.medium_risks ?? []),
    ...(ra?.low_risks ?? []),
  ];

  const exportPdf = () => {
    window.print();
  };

  return (
    <Card className="border-slate-200 bg-white/80 shadow-sm backdrop-blur transition-all">
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>审查报告</CardTitle>
          <Button variant="outline" onClick={exportPdf}>
            导出 PDF
          </Button>
        </div>
        {"final_recommendation" in r && r.final_recommendation ? (
          <div className="text-sm text-muted-foreground">
            结论：{r.final_recommendation}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {ra ? (
          <div className="flex flex-wrap gap-2">
            <Badge>高风险 {ra.high_risks.length}</Badge>
            <Badge variant="secondary">中风险 {ra.medium_risks.length}</Badge>
            {ra.low_risks?.length ? (
              <Badge variant="outline">低风险 {ra.low_risks.length}</Badge>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            风险评估结构化数据缺失或格式不完整（仍可展示原始报告）。
          </div>
        )}

        {"critique_notes" in r && Array.isArray(r.critique_notes) && r.critique_notes.length ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">质量告警（critique）</div>
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {r.critique_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Separator />

        <div className="space-y-2">
          <div className="text-sm font-medium">修订建议清单</div>
          {suggestions.length ? (
            <div className="space-y-2">
              {suggestions.map((s, idx) => (
                <div key={`${s.risk_id ?? "S"}-${idx}`} className="rounded-md border p-3">
                  <div className="text-sm font-medium">
                    {s.risk_id || `S-${idx + 1}`} · {s.title || "风险修订项"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    条款：{s.clause_id || "-"}
                  </div>
                  <div className="mt-1 text-sm">{s.suggestion}</div>
                  <div className="mt-1 text-xs text-muted-foreground">原因：{s.reason}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">暂无结构化修订建议。</div>
          )}
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="text-sm font-medium">法条引用（Citations）</div>
          {citations.length ? (
            <ScrollArea className="h-[220px] rounded-md border p-3">
              <div className="space-y-3">
                {citations.map((c) => (
                  <div key={c.ref_id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{c.ref_id}</Badge>
                      {c.law_name ? <Badge variant="secondary">{c.law_name}</Badge> : null}
                      {c.article ? <Badge variant="outline">第{c.article}条</Badge> : null}
                      {c.status ? (
                        <Badge variant="outline">{String(c.status)}</Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      doc_id: {c.doc_id ?? "-"}{" "}
                      {typeof c.score === "number" ? ` · score=${c.score.toFixed(3)}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="text-sm text-muted-foreground">
              当前审查链路暂未输出结构化 citations（后续可把检索候选/引用校验结果纳入 report）。
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

