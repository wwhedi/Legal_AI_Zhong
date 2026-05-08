# new-feature-chat：回答流式展示、自动滚动、ProcessTimeline、QwenKbAnswerCard 审计报告

**范围**：仅阅读代码与运行 `npm run lint` / `npm run build`，未修改业务代码。  
**日期**：2026-05-08  
**相关文件**：

- `Legal_AI/frontend/src/app/new-feature-chat/page.tsx`
- `Legal_AI/frontend/src/components/chat/ProcessTimeline.tsx`
- `Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx`
- `Legal_AI/frontend/src/components/chat/StreamingAnswerDraft.tsx`

---

## 1. 与用户反馈问题的对应关系

| 现象 | 代码层面原因（摘要） |
|------|----------------------|
| 「检索与依据分析」不像默认展开，或不稳定 | 外层折叠默认是展开的；**依据分析正文**在长文本时默认只显示摘要，且流式结束后面板**换实例挂载**，内部 `useState` 重置，易产生「又收起来了」的感受（见 §3）。 |
| 生成过程没有稳定跟到底部 | **没有任何**消息区 `scrollTop` / `scrollIntoView` / `ResizeObserver` 逻辑；容器也**未挂 ref**。 |
| 需要「用户上滑则不强制跟底」 | 当前未实现跟底，因此也**不存在**该尊重逻辑；未来加自动滚动时必须补「粘底」检测。 |
| 正式回答非逐字流式、而是一下子出现卡片 | `QwenKbAnswerCard` 仅在收到 `type === "answer"` 并写入 `messages` 后渲染；流式阶段只用纯文本 `StreamingAnswerDraft`。 |
| 多块大面积色块、不像 ChatGPT | `QwenKbAnswerCard` 结论区强色条 + 行动/风险/步骤三节分别 `emerald/amber/sky` 浅底 + 列表带彩色圆标（见 §4）。 |

---

## 2. `page.tsx` 审计

### 2.1 消息滚动容器与 ref

- **滚动容器**：主聊天区为 `flex-1` + `overflow-y-auto` 的 div（约第 1379 行），**未**使用 `ref`。
- **结论**：没有可供程序化滚动的 DOM 引用。

### 2.2 是否已有自动滚动逻辑

- 全文件检索：`scroll`、`scrollIntoView`、`scrollTop`、消息区 `ref` 均**不存在**。
- `loading`、`streamingEvents`、`streamingAnswerDraft`（由 `streamingEvents` 派生）变化时，**没有**对应的 `useEffect` 触发滚动。

### 2.3 `answer_delta` 的展示方式

- `streamingAnswerDraft`：遍历 `streamingEvents`，对 `type === "answer_delta"` 或 `stage === "answer_delta"` 的事件，拼接 `data.delta`（约第 1026–1035 行）。
- **渲染条件**：`answerGenerationLive` 为真，即存在 `stage === "answer_generation_start"` **且**尚未出现 `type === "answer"`（约第 1037–1042 行）；且整体在 `loading && !streamHasAnswer` 的「底部加载行」内（约第 1444–1463 行）。
- **组件**：使用 `StreamingAnswerDraft`，传入 `text={streamingAnswerDraft}`；在 `pending={!streamingAnswerDraft}` 时显示「等待模型输出……」。
- **含义**：在 `answer_generation_start` 之前，即使已有其它流式事件，也**不会**显示回答草稿区（只有 `ProcessTimeline` 或「正在连接流式服务…」）。

### 2.4 最终 `answerCard` 何时渲染

- 在 `pushEvent` 中，当 `ev.type === "answer"` 且尚未写入过回答时（约第 1128–1168 行）：
  - 从 `ev.data` 读取 `answer`、`model`、`retrieved_count`、`citations`；
  - 调用 `normalizeAnswer(ans)` 与 `normalizeSources(citations)`；
  - 将 `processEvents` 存为快照（**过滤掉** `answer_delta`，保留 `analysis_delta` 等，约第 1136–1142 行）；
  - `setMessages` 追加一条 `role: "assistant"` 且带 `answerCard` 的消息。
- 列表渲染中，若 `assistantWithCard && answerCard`，则依次渲染 `ProcessTimeline`（若有 `processEvents`）和 `QwenKbAnswerCard`（约第 1413–1430 行）。
- `finally` 中会 `setStreamingEvents([])`（约第 1274–1275 行），底部加载行消失，用户只看到已落库的那条助手消息。

### 2.5 「用户手动上滑」识别

- **当前**：无实现。

---

## 3. `ProcessTimeline.tsx` 审计

### 3.1 外层「检索与依据分析」默认 open

- `const [open, setOpen] = useState(true);`（约第 86 行）→ **默认展开**。
- 收起后仅影响外层白卡片内灰色内容区（约第 186–208 行），标题栏始终可见。

### 3.2 「依据分析」是否默认展开

- 依据分析由 `AnalysisBody` 渲染（约第 381–444 行）。
- `const [analysisExpanded, setAnalysisExpanded] = useState(false);`（约第 389 行）→ **内部默认未展开「全文」**。
- 行为：
  - 通过 `analysisSummarySnippet` 将正文截成最多 5 行或约 480 字摘要（约第 364–378 行）；
  - 当 `needsExpand` 或摘要与全文不等时，显示「展开依据分析 / 收起依据分析」切换（约第 416–439 行）。
- **与用户感知的偏差**：外层已是「展开」，但依据分析长文时默认仍是**折叠全文**，容易被说成「依据分析不是默认展开」。

### 3.3 内部滚动

- 时间线展开内容区为普通块级布局 + `p-3`，**未**对整块设置 `max-height` + `overflow-auto`。
- `CitationPopover`（在 `QwenKbAnswerCard` 内）的法规正文使用 `ScrollArea`，与 `ProcessTimeline` 面板无关。
- `TimingDebugDetails` 使用原生 `<details>`，仅调试折叠。

### 3.4 生成中自动展开是否合适

- 结构上适合：默认 `open === true` 时生成过程可见。
- **稳定性问题**：流式进行中 `ProcessTimeline` 挂在页面**底部加载行**；`answer` 到达后同一批事件快照被挂到**新助手消息**里，`ProcessTimeline` **重新挂载**，`analysisExpanded` 回到 `false`。若依据分析较长，用户会看到**从「可能已展开全文」变回「仅摘要 + 展开按钮」**（若用户在流式阶段曾点开过，状态也不会保留到新实例）。这是「展开状态不稳定」的重要来源。

---

## 4. `QwenKbAnswerCard.tsx` 视觉结构

### 4.1 区块结构（自上而下）

- **元信息**：问题 + 模型名，底部分隔线（约第 556–559 行）。
- **结论**：左侧粗色条 + `bg-[var(--app-primary-soft)]/45` + 大标题「结论」+ `Quote` 图标（约第 561–570 行）→ **大面积强调色背景**。
- **你现在最该做**：`bg-emerald-500/[0.04]` + `ActionChecklistBlock`：每行左侧**绿色圆/对勾**（约第 573–590、345–386 行）。
- **风险提示**：`bg-amber-500/[0.04]` + `RiskBulletListBlock`：**琥珀色圆标**（约第 592–595、389–421 行）。
- **可执行操作步骤**（若有）：`bg-sky-500/[0.04]`，表格 / pre / 列表（约第 597–627 行）。
- **引用依据**（若有实质内容）：可折叠按钮，展开后为普通正文（约第 629–647 行），无整节色底。
- **知识库来源**：`KnowledgeSourcesBlock`，默认收起，展开后每条白底卡片（约第 115–194、650–652 行）。

### 4.2 大面积色块归纳

- 结论区：`border-l-4` + **primary soft 背景**。
- 行动 / 风险 / 步骤：三节整段 **tint 背景**（emerald / amber / sky）。
- 列表项：持续的 **彩色圆形序号/标记**（非 ChatGPT 式纯排版）。

### 4.3 citations、引用悬浮、`ActionStepsTable`

- **可保留**：`renderTextWithCitations` + `InlineCitationMark` + `CitationPopover` 与表格渲染链清晰，与「去色块」不冲突。
- **建议方向**（仅设计层面）：保留交互与数据结构，把强调从「色块」改为「标题层级（如 `h3`）+ 顶部分隔线 + 适度 `font-semibold` + 列表/表格」；引用悬浮仍可放在正文中。

---

## 5. `StreamingAnswerDraft.tsx` 审计

### 5.1 是否仍用于 `answer_delta`

- **是**。在 `page.tsx` 的加载行中，当 `answerGenerationLive` 时渲染（见 §2.3）。

### 5.2 与正式回答排版差异

- 单卡片：白底 + 边框 + 「正在生成说明」+ `whitespace-pre-wrap` 的**原始字符串**（约第 11–28 行）。
- **未**调用 `normalizeAnswer`，**未**使用 `renderTextWithCitations`（无 `sources` Map），**未**使用 `QwenKbAnswerCard` 的分节渲染。

### 5.3 能否复用解析逻辑做「流式半成品」

- **可行方向**（实现时不属本次审计范围）：
  - 在流式阶段若已有 `sources`（例如来自检索完成事件中的摘要，与最终 `citations` 结构需对齐），可对**当前累积字符串**调用 `normalizeAnswer`，用与正式卡片相同的信息架构渲染「未完成」状态（占位节、表格未闭合等需容错）。
  - 若流式阶段没有可靠 `sourceById`，仍可先做**无引用高亮**的同一套标题/列表排版，收到 `answer` 后再切换为完整引用。
- **风险**：`normalizeAnswer` 依赖完整或接近完整的章节标题行；半段文本可能导致分节抖动，需要防抖或「仅展示 raw markdown 式流」等策略。

---

## 6. 直接回答用户要求的 7 条结论

1. **当前自动滚动逻辑是否存在**  
   **不存在。** 滚动容器无 ref，也无任何在 `messages` / 流式状态变化时滚到底部的代码。

2. **为什么正式回答会一下子出现**  
   助手带 `answerCard` 的消息仅在 **`type === "answer"`** 时创建；`QwenKbAnswerCard` 只绑定在这条消息上。流式末尾清空 `streamingEvents`，底部 `StreamingAnswerDraft` 被卸掉，视觉上即从「纯文本草稿」切换为「完整卡片」。

3. **`answer_delta` 是否已经包含模型正式回答文本**  
   前端将 `answer_delta` 的 `data.delta` **按序拼接**为一段正文，语义上即**模型回答的增量文本**（与后端约定一致；本次未审计后端是否每条 delta 都是正文片段）。**不包含** citations 元数据；引用需等最终 `answer` 里的 `citations`。

4. **是否可以在生成中用 `answer_delta` 渲染「正式回答样式」**  
   **可以**，前提是：接受分节在增量过程中可能变化、引用在检索完成前可能不完整；并建议与 `normalizeAnswer` / 共享排版组件分层设计，避免完成瞬间布局剧烈跳变（例如固定外层骨架）。

5. **`QwenKbAnswerCard` 改成 ChatGPT 风格的推荐方案**  
   - 去掉结论区整段色条背景，改为 **一级标题 + 正文**。  
   - 行动/风险/步骤：**取消整节 tint**，改用 **`###` 级标题 + 下划线或 `border-b` + 正常列表**；步骤保留 `ActionStepsTable`。  
   - 列表标记改为中性圆点或数字，减少 emerald/amber/sky **语义色铺满**。  
   - `KnowledgeSourcesBlock` 可改为文末「参考文献」式折叠，减少「卡片套卡片」层次。

6. **推荐分几步改最稳**  
   1. **粘底滚动**：容器 ref +「是否在底部附近」判断 + 仅在粘底时 `requestAnimationFrame` 滚到底；用户上滑离开阈值则停止。  
   2. **流式视觉连续**：在粘底稳定后，用 `answer_delta` 驱动与正式卡片**共享排版**的预览（可先无引用、后hydrate）。  
   3. **ProcessTimeline 状态**：避免 remount 丢状态（例如 lifting `analysisExpanded` 到父级 keyed by `messageId`，或流式结束不销毁同一实例）。  
   4. **QwenKbAnswerCard 去色块**：按 §6.5 分节改样式，保留 citations 与表格。  

7. **不要修改代码**  
   本次审计遵守：仅新增本报告，未改业务代码。

---

## 7. 构建与 Lint

在 `Legal_AI/frontend` 执行：

- `npm run lint`：**通过**（eslint 无报错输出）。
- `npm run build`：**成功**（Next.js 16.2.1 webpack，`exit_code: 0`）。

---

## 8. 代码定位摘录（便于跳转）

消息区滚动容器（无 ref）：

```1379:1381:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-pb-4">
            <div className={cn("mx-auto w-full px-5 pb-4 pt-1 md:px-8", chatContentMaxClass)}>
              <div className="space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)]/90 p-5 shadow-[var(--app-shadow-sm)] backdrop-blur-sm">
```

`answer_delta` 聚合与 `answer` 落库：

```1026:1042:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
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

  const answerGenerationLive = useMemo(
    () =>
      streamingEvents.some((e) => e.stage === "answer_generation_start") &&
      !streamingEvents.some((e) => e.type === "answer"),
    [streamingEvents],
  );
```

`ProcessTimeline` 外层与依据分析默认展开状态：

```85:88:Legal_AI/frontend/src/components/chat/ProcessTimeline.tsx
export function ProcessTimeline({ events, className }: ProcessTimelineProps) {
  const [open, setOpen] = useState(true);
```

```388:390:Legal_AI/frontend/src/components/chat/ProcessTimeline.tsx
  const hasStart = events.some((e) => e.stage === "analysis_start");
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
```

`QwenKbAnswerCard` 结论与分节色底：

```561:571:Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx
      <div className="mt-4 border-l-4 border-[var(--app-primary)]/75 bg-[var(--app-primary-soft)]/45 py-4 pl-5 pr-4">
        <div className="mb-3 flex items-center gap-2 text-lg font-bold tracking-tight text-[var(--app-text)]">
          <Quote className="size-4 shrink-0 text-[var(--app-primary)]" strokeWidth={2} aria-hidden />
          结论
        </div>
        <div className="text-base font-normal leading-relaxed text-[var(--app-text)]">
          {conclusionDisplay
            ? renderTextWithCitations(conclusionDisplay, sourceById)
            : "未获取到回答。"}
        </div>
      </div>
```

---

*报告结束。*
