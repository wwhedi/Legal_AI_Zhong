# 流式回答与过程面板审计报告

**范围**：`new-feature-chat` 页的流式预览、`StreamingAnswerDraft`、`ProcessTimeline`、耗时类事件、依据分析展示与滚动行为。  
**说明**：本文档为只读审计，不包含代码修改。  
**关联后端**：`Legal_AI/new_feature_qwen_kb/service.py` 中 `ask-stream` NDJSON 事件（含 `type: "timing"`）。

---

## 构建与静态检查

在 `Legal_AI/frontend` 执行：

- `npm run lint`：**通过**（eslint 无报错退出）。
- `npm run build`：**通过**（Next.js 16.2.1 生产构建成功）。

---

## 1. 流式预览与正式回答的渲染路径

### 1.1 `streamingAnswerDraft` 如何生成

在 `page.tsx` 中由 `useMemo` 对 `streamingEvents` 做一次归约：遍历事件，若 `e.type === "answer_delta"` 或 `e.stage === "answer_delta"`，则从 `e.data.delta` 拼接字符串。

```1026:1035:e:\cousor\Legal_AI\frontend\src\app\new-feature-chat\page.tsx
  const streamingAnswerDraft = useMemo(() => {
    let acc = "";
    for (const e of streamingEvents) {
      if (e.type === "answer_delta" || e.stage === "answer_delta") {
        const d = e.data as Record<string, unknown> | undefined;
        if (d && d.delta != null) acc += String(d.delta);
      }
    }
    return acc;
  }, [streamingEvents]);
```

同一套 delta 在 `pushEvent` 里也会累加到 `streamingDraftAccumulatorRef`（用于停止生成时落库草稿），与 UI 草稿同源。

### 1.2 在何处渲染 `StreamingAnswerDraft` 与 `ProcessTimeline`

- **进行中（`loading === true`）**：在消息列表**下方**单独一块「加载区」容器中渲染：
  - 始终（在有条目后）渲染 `<ProcessTimeline events={streamingEvents} />`；
  - 当 `answerGenerationLive` 为真时，再渲染 `<StreamingAnswerDraft text={streamingAnswerDraft} pending={!streamingAnswerDraft} />`。

```1438:1450:e:\cousor\Legal_AI\frontend\src\app\new-feature-chat\page.tsx
                {loading ? (
                  <div className="space-y-2 rounded-[20px] border border-[var(--app-border)] bg-white/85 p-3 shadow-[var(--app-shadow-sm)] backdrop-blur-sm">
                    {streamingEvents.length === 0 ? (
                      <p className="text-xs text-[var(--app-text-subtle)]">正在连接流式服务…</p>
                    ) : null}
                    <ProcessTimeline events={streamingEvents} />
                    {answerGenerationLive ? (
                      <StreamingAnswerDraft
                        text={streamingAnswerDraft}
                        pending={!streamingAnswerDraft}
                      />
                    ) : null}
                  </div>
                ) : null}
```

- **完成后**：每条带 `answerCard` 的助手消息内，先 `ProcessTimeline`（若持久化了 `processEvents`），再 `QwenKbAnswerCard`。

```1407:1425:e:\cousor\Legal_AI\frontend\src\app\new-feature-chat\page.tsx
                        {assistantWithCard && answerCard ? (
                          <div className="space-y-3">
                            {m.processEvents && m.processEvents.length > 0 ? (
                              <ProcessTimeline events={m.processEvents} />
                            ) : null}
                            <QwenKbAnswerCard
                              answer={answerCard.answer}
                              sources={answerCard.sources}
                              question={answerCard.question}
                              modelName={answerCard.modelName}
                              onRegenerate={() => void send(answerCard.question || lastQuestion)}
```

### 1.3 `answerGenerationLive` 含义

```1037:1041:e:\cousor\Legal_AI\frontend\src\app\new-feature-chat\page.tsx
  const answerGenerationLive = useMemo(
    () =>
      streamingEvents.some((e) => e.stage === "answer_generation_start") &&
      !streamingEvents.some((e) => e.type === "answer"),
    [streamingEvents],
  );
```

即：流里已出现 **`answer_generation_start` 阶段**（后端先 `timing` 再 `progress`，二者 stage 名相同），且**尚未收到 `type === "answer"`** 时，认为「正式回答流式生成中」，显示 `StreamingAnswerDraft`。

### 1.4 正式 `answerCard` 出现后流式预览是否消失

- 当 NDJSON 中出现 `type: "answer"` 时，`pushEvent` 会追加助手消息并写入 `answerCard`；此时 `streamingEvents` 中含 `answer`，`answerGenerationLive` 变为 **false**，**`StreamingAnswerDraft` 不再渲染**。
- 流式原始文本与正式卡片内容：**前者为模型输出原文拼接**；**后者经 `normalizeAnswer` 拆成结论 / 依据 / 风险 / 建议等** 并由 `QwenKbAnswerCard` 展示，版式不同，用户容易感到「先有一段预览、再出现正式回答」的**内容重复感**（即便二者在 `answer` 到达后不会同时显示草稿）。

### 1.5 重复展示（含时间线）

1. **预览 vs 正式回答**：设计上在 `answer` 事件前展示原始流式文本，`answer` 后展示结构化卡片——语义可能重叠，属产品层面的「两段式」体验。
2. **时间线可能双份**：`loading` 仅在 `finally` 里结束；在已处理 `answer` 事件之后、流末尾 `done` 之前，`loading` 仍为 `true`。此间**同一会话**既在 `messages` 里渲染了带 `ProcessTimeline(processEvents)` + `QwenKbAnswerCard` 的助手气泡，又在底部加载区渲染 **`ProcessTimeline(streamingEvents)`**，出现**两套过程面板**的窗口期（通常较短，取决于 `done` 与网络延迟）。

持久化快照与实时流的差异：`processEvents` 在落库时过滤掉了 `answer_delta` / `answer` / `done` / `error`（见 `pushEvent` 内 `processSnapshot`），而加载区内 `streamingEvents` 为完整流；二者在 `answer` 之后仍可能并存直至 `loading` 结束。

---

## 2. `StreamingAnswerDraft.tsx` 行为摘要

| 项 | 现状 |
|----|------|
| **标题文案** | `回答生成中（预览）` |
| **是否独立卡片** | 是：外层 `rounded-[20px] border ... bg-white ... shadow`，与过程面板、正式卡片视觉同级 |
| **内部滚动** | 内容区 `max-h-72 overflow-y-auto`，与页面主滚动区形成**嵌套滚动** |
| **是否可改为正式回答占位** | 产品可行：例如在同一卡片骨架内显示加载态 / 渐进填充结构化区块，避免「预览卡片 + 正式卡片」两段结论 |

```27:41:e:\cousor\Legal_AI\frontend\src\components\chat\StreamingAnswerDraft.tsx
  return (
    <div
      className={cn(
        "rounded-[20px] border border-[var(--app-border)] bg-white p-3 text-sm text-[var(--app-text)] shadow-[var(--app-shadow-sm)]",
        className,
      )}
    >
      <div className="mb-2 text-xs font-medium text-[var(--app-text-muted)]">回答生成中（预览）</div>
      <div
        ref={scrollerRef}
        className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-[var(--app-text)]"
      >
        {text ? text : pending ? <span className="text-[var(--app-text-subtle)]">正在生成回答……</span> : null}
      </div>
    </div>
  );
```

---

## 3. `ProcessTimeline.tsx` 行为摘要

### 3.1 外层结构

- **单一外层卡片**：标题为 **「检索与依据分析」**，副标题「用于说明本次回答依据」，带**收起 / 展开**（默认 `open === true`）。
- **「依据分析」**：并非第二个顶层卡片；而是在**同一卡片**内、时间线列表下方的 `AnalysisBody`，用 `border-t` 与上方列表分隔。用户仍可能感觉「像另一块」是因为**独立小标题 + 内嵌白底边框块**，与左侧时间线视觉层级不同。

### 3.2 事件如何进入列表 `rows`

过滤逻辑（保留在 `rows` 中的才会变成 `<li>`）：

- **排除**：`done` / `error` / `answer` / `analysis`；`analysis_delta`；`answer_delta`；`LOW_VALUE_STAGES`（`start`, `query_rewrite_start`, `kb_retrieve_start`, `answer_generation_done`）；以及 **`stage` 为 `analysis_start` 或 `analysis_done` 的任意事件**。

注意：后端发出的 **`type: "progress", stage: "analysis_start"`**（「依据分析生成中」）会因 **stage 名**被整段过滤，**不会出现在时间线列表里**；但 `analysisRelevant` 仍可能为 true，从而渲染 **`AnalysisBody`**。这会造成「列表里没有明确的分析开始行，但下面已有依据分析块」的跳跃感。

**未在类型层声明但运行时存在的事件**：后端大量使用 `etype="timing"` 与 `etype="retrieval"`，而 `RagProcessEventType`（`types/index.ts`）未列出 `timing` / `retrieval`——不影响 `JSON.parse`，但类型与真实流不一致。

### 3.3 「耗时统计」重复的来源

后端 `_timing_stream_payload` 为**每一条**计时点生成事件，且 **`title` 固定为「耗时统计」**，`message` 为英文短句（如 `request received`、`query rewrite completed`、`knowledge base retrieve completed` 等）。

```353:375:e:\cousor\Legal_AI\new_feature_qwen_kb\service.py
def _timing_stream_payload(
    *,
    request_id: str,
    stage: str,
    message: str,
    duration_ms: int,
    elapsed_ms: int,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "request_id": request_id,
        "elapsed_ms": elapsed_ms,
        "duration_ms": duration_ms,
    }
    if status:
        data["status"] = status
    return _stream_event(
        etype="timing",
        stage=stage,
        title="耗时统计",
        message=message,
        data=data,
    )
```

前端 `ProcessTimeline` **没有**按 `type === "timing"` 合并或隐藏，每条都会在 `TimelineRow` 里渲染 **`ev.title`（即多次「耗时统计」）** + 在多数 stage 下渲染 **`ev.message`**（`query_rewrite_done` / `kb_retrieve_done` 两行例外地隐藏 message，但 **timing 行不适用该例外**）。

非 compact 行样式为：**每条左侧竖线 + 加粗标题**——多条「耗时统计」在视觉上像**重复章节标题**。

`compact` 仅当 `ev.stage === "answer_generation_start"` 时启用（小号 `· 标题`）。**多数 timing 行的 stage 为 `request_start`、`query_rewrite_end`、`kb_retrieve_end` 等**，走**完整大行**样式。

### 3.4 与「检索过程」并存的其他行

在 `timing` 之外，仍保留例如：

- `type: "progress"`, `stage: "query_rewrite_done"` → 标题「检索问题识别」+ `EventDetail`（意图、关键词、检索语句）；
- `type: "retrieval"`, `stage: "kb_retrieve_done"` → 「知识库检索结果」+ 命中列表；
- `type: "retrieval"`, `stage: "effective_filter_done"` → 「有效法条筛选」+ 统计句；
- `type: "progress"`, `stage: "answer_generation_start"` → compact 行（与 timing 同 stage 时也会 compact）。

因此用户既看到**业务进度标题**，又看到**多条同名「耗时统计」**，信息密度高、重复感强。

### 3.5 `max-height` / `overflow-y-auto` 与嵌套滚动

| 位置 | 类名 / 行为 |
|------|-------------|
| 页面主内容 | `new-feature-chat/page.tsx` 主列 `min-h-0 flex-1 overflow-y-auto`（主滚动区） |
| `ProcessTimeline` 展开内容 | `max-h-72 overflow-y-auto`（**第一层内嵌滚动**） |
| `AnalysisBody` 正文 | `max-h-48 overflow-y-auto`（**第二层内嵌滚动**，套在上面的 `max-h-72` 容器内） |
| `StreamingAnswerDraft` | `max-h-72 overflow-y-auto`（与主滚动嵌套） |

结论：存在**明确的嵌套滚动**（主滚动 + 过程面板 + 依据分析正文），与「希望过程面板内部不要再有很多小滚动区域」的诉求不一致。

---

## 4. 问题与根因对照（用户列出的 1–5 点）

| 现象 | 根因摘要 |
|------|----------|
| 结论预览后又出现正式回答 | `answer_generation_start` 之后展示 `StreamingAnswerDraft`（原文）；`answer` 之后改 `QwenKbAnswerCard`（结构化），体验上两段结论。 |
| 「耗时统计」出现太多次 | 后端每个计时点一条 `timing` 事件且共用 `title: "耗时统计"`；前端逐条渲染为大标题行。 |
| 「依据分析」割裂、内嵌滚动 | 同卡片内分区 + `AnalysisBody` 使用 `max-h-48 overflow-y-auto`；与外层 `max-h-72` 叠加。 |
| 过程面板多小滚动区 | 见 3.5；另加载区内 `StreamingAnswerDraft` 自带 `max-h-72`。 |
| 检索过程需保留但更简洁 | 当前 **timing 与 progress/retrieval 并列全量展示**，未做聚合；`analysis_start` 进度行又被过滤，信息结构不直观。 |

---

## 5. 改进方向建议（设计级，不含实现）

### 5.1 简洁进度

- **时间线只保留用户可理解的阶段节点**（例如：识别检索意图 → 检索命中 → 有效条筛选 → 依据分析 → 生成回答），**隐藏或合并** `type: "timing"` 的逐条列表。
- 或将 timing **折叠为一条「性能」子行**（仅开发者模式展开）。

### 5.2 只保留一次耗时摘要

- **前端**：对 `timing` 事件聚合成**单行/单块**（如「总耗时 xx ms · 检索 yy ms · 回答 zz ms」），或只展示**最后一条 `request_done`** 的累计信息。
- **后端**（若可改）：改为**单条** `timing_summary` 或减少 emit 频率，避免 N 条同标题事件。

### 5.3 依据分析默认折叠或内联

- 默认 **收起**整个「检索与依据分析」或仅收起「依据分析」子块；正式回答生成中可只显示一行状态。
- **内联**：将依据分析并入 `QwenKbAnswerCard` 的某一折叠章节，与结论同一视觉体系，减少「过程区 vs 回答区」割裂。

### 5.4 去掉内部滚动条

- 去掉 `ProcessTimeline` 内容区与 `AnalysisBody` 的 `max-h-* overflow-y-auto`，**高度随内容增长**，交给页面主滚动。
- `StreamingAnswerDraft` 若保留，同样去掉固定 `max-h-72`，或改为不单独占卡、直接作为正式卡片的流式填充区。

### 5.5 减轻重复时间线与双面板

- 在**已追加带 `answerCard` 的助手消息**后，**不再在底部 `loading` 区渲染** `ProcessTimeline`（或整个加载区仅保留极简「收尾中…」），直到 `loading` 结束。
- 或 **`loading` 在收到 `answer` 后即置 false**（若业务允许在 `done` 前结束占位），缩短双面板窗口期。

---

## 6. 推荐修改范围（文件 / 模块）

| 优先级 | 文件 / 模块 | 说明 |
|--------|-------------|------|
| 高 | `Legal_AI/frontend/src/app/new-feature-chat/page.tsx` | 加载区与 `messages` 的渲染条件；`answerGenerationLive` / `streamingAnswerDraft` 策略；是否在与正式卡片并存时隐藏过程面板。 |
| 高 | `Legal_AI/frontend/src/components/chat/ProcessTimeline.tsx` | `rows` 过滤与 `timing` 聚合；`AnalysisBody` 布局与滚动；可选默认 `open`；`analysis_start` 进度行是否应显示。 |
| 中 | `Legal_AI/frontend/src/components/chat/StreamingAnswerDraft.tsx` | 标题/卡片形态；是否改为 `QwenKbAnswerCard` 的 skeleton 或内联流式区。 |
| 中 | `Legal_AI/frontend/src/types/index.ts` | 补充 `RagProcessEventType` 中的 `timing`、`retrieval` 等，与后端对齐。 |
| 可选 | `Legal_AI/new_feature_qwen_kb/service.py` | 减少 `timing` 事件条数或增加汇总事件，从源头降低重复。 |
| 可选 | `Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx` | 若将依据分析并入正式卡片，需协调结构与引用渲染。 |

---

## 7. 报告路径

- **本报告文件**：`Legal_AI/docs/streaming-and-process-panel-audit.md`

---

## 8. 附录：后端典型 `timing` `message` 片段（便于对照 UI）

来自 `service.py` 流式路径的 `_emit_timing_event` 调用示例（非穷尽）：

- `request_start` → `request received`
- `query_rewrite_end` → `query rewrite completed`
- `kb_retrieve_end` → `knowledge base retrieve completed`
- `filter_end` → `effective citation filter completed`
- `analysis_first_delta` / `analysis_done`（timing）→ 对应英文 message（列表中 `analysis_start`/`analysis_done` stage 被前端过滤，但 timing 的 `analysis_first_delta` 等仍可能出现）
- `answer_generation_start`（timing）→ `final answer generation started`
- `answer_first_delta` → `first answer token`
- `answer_done` → `final answer stream completed`
- `request_done` → `request completed` 等

凡此种种，在前端当前实现下只要未被 `rows` 过滤，都会以 **`title: 耗时统计`** 的形式占据一行或多行。
