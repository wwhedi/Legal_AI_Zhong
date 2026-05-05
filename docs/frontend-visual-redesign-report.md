# 前端视觉改造验收审计报告

**审计方式**：基于当前仓库源码的静态审查（未改业务代码）；**未做真实浏览器多分辨率实测**，响应式结论依据类名与布局结构推断。  
**审计日期**：2026-05-05  
**构建验证**：在 `Legal_AI_Zhong/frontend` 执行 `npm run lint`、`npm run build`（均成功，见文末）。

---

## 1. 全局视觉

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| 是否已从深色控制台风格转为现代浅色 AI 风格 | **基本达成** | 根布局 `body` 使用 `bg-[var(--app-bg)]`、`text-[var(--app-text)]`（及 `dark:` 回退）；侧栏 `AppSidebar` 为浅底、`--app-border` 分隔、主色选中态。 |
| 是否仍有大量 `#0b1020`、`#0f172a`、`bg-slate-900` 等深色残留 | **未发现** | 在 `frontend/src` 全文检索上述 hex 与 `bg-slate-9`、`bg-slate-8` **无匹配**。聊天与 kb-update 主路径已迁移至浅色 token。 |
| 是否统一使用 app 级变量或一致浅色体系 | **大体统一** | `globals.css` 中 `--app-*` 与组件内 `var(--app-bg)`、`var(--app-border)`、`var(--app-primary)` 等并存；kb-update 通过 `_lib/ui.ts` 集中卡片与按钮样式。**残留**：`kb-update/new/config/page.tsx` 文件尾部 **注释掉的旧代码块** 仍含 `text-slate-900` 等字面类（不参与构建，仅文档/可读性杂质）。 |

**完成度**：全局浅色转型 **约 90–95%**（排除注释块与 Shadcn UI 底层默认 `slate` 用语）。

---

## 2. new-feature-chat

| 区域 | 结论 |
|------|------|
| **页面背景** | `bg-[var(--app-bg)]`，`overflow-x-hidden`、`min-w-0` 控溢出。 |
| **顶部标题** | 标题 `text-[var(--app-text)]`，副标题 `--app-text-muted`；右上角 meta 为浅色 pill（`--app-surface`、`--app-border`、轻阴影）。 |
| **主聊天容器** | `max-w-6xl` 居中；内层卡片 `border-[var(--app-border)]`、`bg-[var(--app-surface)]/90`、圆角与轻阴影；内层滚动 `overflow-y-auto`、`pb-36`/`scroll-pb-32`。 |
| **用户气泡** | 右对齐；`max-w-[70%]`；`rounded-[20px]`；蓝→靛 **`gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)]`**，白字、轻阴影。 |
| **AI 回答区域** | 带 `answerCard` 时外层去厚重深色壳，由 **`QwenKbAnswerCard`** 承担卡片视觉；纯文本错误等仍为浅色圆角白底块。 |
| **输入框** | `fixed` 底栏；`rounded-[20px]`、`bg-white`、浅边框、`focus` 主色环；容器渐变顶栏减轻遮挡感。 |
| **发送按钮** | 主色渐变、`rounded-[20px]`；`loading` 时 **`Loader2` +「发送中」**，`disabled` 降透明度。 |
| **流式回答草稿** | **`StreamingAnswerDraft`**：白底、`--app-border`、轻阴影，文案 `--app-text` / `--app-text-subtle`。 |
| **错误提示** | 仍以助手消息文本展示（如「调用失败：…」），样式为浅色助手气泡（非独立 Alert 组件）。 |

---

## 3. QwenKbAnswerCard

| 检查项 | 结论 |
|--------|------|
| **结论是否突出** | **是**：独立区块、渐变浅蓝底、`text-base` 标题「结论」、正文 `text-[15px] leading-8`。 |
| **依据是否弱化** | **是**：`--app-surface-muted`、边框、`text-[var(--app-text-muted)]`。 |
| **风险点是否清楚且不过度警示** | **是**：`amber-50` 系浅底、`amber-950` 文案色，非大红告警。 |
| **建议是否像行动清单** | **部分达成**：按空行分段 + 左侧竖条分隔；若后端单段长文本，列表感仍弱于多段场景。 |
| **知识库来源默认折叠** | **是**：`useState(false)`，折叠一行展示「知识库来源 · 已引用 X 条…」+ 展开。 |
| **[n] 引用悬浮是否可用** | **代码层面保留**：`InlineCitationMark` + `CitationPopover`，按钮与 hover/open 逻辑仍在。 |
| **CitationPopover 浅色现代卡片** | **是**：白底、`--app-border`、`shadow-[var(--app-shadow-md)]`，链接 `--app-primary`。 |

---

## 4. ProcessTimeline

| 检查项 | 结论 |
|--------|------|
| **是否更像「检索与依据分析」** | **是**：标题 + 副标题「用于说明本次回答依据」；浅色卡片 `rounded-[18px]`。 |
| **是否不再像日志窗口** | **明显改善**：白/浅灰面板，检索意图为小标签式排版；法条列表紧凑一行多字段；不再使用深色 `slate-900` 滚动盒。 |
| **analysis_delta 实时展示** | **保留**：`streamedAnalysis` 仍遍历 `analysis_delta` 事件拼接；`displayText` 优先终稿否则流式。 |
| **是否喧宾夺主** | **可控**：面板 `max-h-72` 滚动；依据分析区 **`max-h-48`** 独立滚动；视觉弱于下方正式 **`QwenKbAnswerCard`**。 |

---

## 5. kb-update 与各页统一性

| 页面 | 与聊天页一致性 |
|------|----------------|
| **首页 `KbUpdateHomeClient`** | **统一**：`kbSection` → `--app-bg`；卡片 `kbCard`；主按钮渐变与聊天主色一致；状态 `--app-success/danger/primary/warning-soft`。 |
| **新建任务 `new/page.tsx`** | **统一**：表单 `kbInput`/`kbCard`，主次按钮用 `_lib/ui`。 |
| **配置 `JobConfigClient`** | **统一**。 |
| **步骤 `StepSelectionClient`** | **统一**。 |
| **运行 `jobs/.../run`** | **统一**；日志区改为浅底轻边框、高度收敛，权重低于步骤卡。 |
| **结果 `jobs/.../result`** | **统一**；指标卡与聊天同为白卡片 + token。 |
| **历史 `history`** | **统一**；链接主色、表格斑马浅纹。 |
| **Suspense fallback（steps/config）** | 已与浅色壳对齐。 |

**说明**：`kb-update/page.tsx` 仍为服务端包装，视觉由 `KbUpdateHomeClient` 承担，无额外冲突。

---

## 6. 功能回归（代码静态核对）

| 项 | 结论 |
|----|------|
| **`/new-rag/ask-stream` 仍调用** | **是**：`page.tsx` 中 `fetch(\`${getApiBaseUrl()}/new-rag/ask-stream\`)`。 |
| **analysis_delta 仍参与展示** | **是**：`ProcessTimeline` 内 `AnalysisBody` 拼接 delta；聊天 loading 区挂载 `ProcessTimeline`。 |
| **answer_delta 仍参与预览** | **是**：`streamingAnswerDraft` 由事件中 `answer_delta` 累积；`StreamingAnswerDraft` 在生成阶段展示。 |
| **最终回答仍含结论/依据/风险/建议** | **是**：仍由 **`normalizeAnswer`** + **`QwenKbAnswerCard`** 渲染（结构未改）。 |
| **[n] 引用仍可悬浮** | **逻辑保留**（见 §3）。 |
| **source_url 仍可打开** | **代码保留**：`KnowledgeSourcesBlock` / `CitationPopover` 内 `href={url}` 的 `a` 标签仍存。 |
| **kb-update API 未改** | **本审计未修改任何文件**；此前改造限定在页面与 `_lib/ui`，**未改** `services/api.ts` 的约定仍成立（验收以仓库现状为准，必要时请再执行 `git diff` 对 API 层确认）。 |

---

## 7. 响应式与布局（静态推断）

| 检查项 | 结论 |
|--------|------|
| **横向溢出** | 聊天根节点 `overflow-x-hidden`、`min-w-0`；气泡 `max-w-[70%]` / `min-w-[max(…)]`；**风险点**：超长英文 URL 等需真机确认 `break-all`。 |
| **输入框遮挡内容** | 通过 **`pb-44`**、滚动区 **`pb-36`**、底栏 **`pt-10`** 渐变缓解；**建议在窄屏真机再验**最后一条消息是否仍偏近底栏。 |
| **长文本换行** | 多处 `break-words`、`whitespace-pre-wrap`（草稿、引用正文等）。 |
| **小屏幕可用性** | `ProcessTimeline` 标题区 `sm:flex-row`；历史表 **五列栅格** 在极窄屏可能出现挤压，**建议**真机横向滚动或改为卡片堆叠（属增强项）。 |

---

## 8. 构建与 Lint

| 命令 | 结果 |
|------|------|
| `npm run lint` | **通过** |
| `npm run build` | **通过** |

---

## 总体完成度与建议优化

### 视觉改造完成度（主观）

| 维度 | 评分（满分 10） | 说明 |
|------|-----------------|------|
| 全局浅色与 token 化 | **9** | 深色 hex / slate-900 主路径已清除；注释与第三方 UI 仍有零星 slate 语义。 |
| 聊天主路径 | **9** | 问答、流式、卡片、输入条一致；错误态仍可加强为专用浅色 Alert。 |
| 辅助面板（Timeline） | **9** | 弱化为辅助信息成功；信息多时仍依赖滚动，属预期。 |
| kb-update | **9** | 与聊天主色、卡片语言统一；历史表格响应式可继续打磨。 |
| **综合** | **约 89–92%** | 达到「可交付验收」水平；剩余主要为真机响应式与文案/错误态 polish。 |

### 仍建议优化的问题（不构成阻断）

1. **删除或精简** `kb-update/new/config/page.tsx` 底部大块注释旧代码，避免与现行浅色规范混淆。  
2. **历史任务页**：窄屏下列五列可读性；可考虑 `overflow-x-auto` 包一层表格或改为卡片列表。  
3. **聊天错误消息**：当前与其它浅色气泡一致；若需更强提示，可增加浅色左侧色条或图标（纯视觉）。  
4. **暗色模式**：`html.dark` 下侧栏等有 shadcn 回退；全站 app token 在 dark 下未逐一配对（若产品不需要 dark 可忽略）。  
5. **验收补充**：建议在 Chrome 移动端模拟器与 375px / 768px / 1280px 各截一屏存档。

---

**报告路径**：`Legal_AI_Zhong/docs/frontend-visual-redesign-report.md`
