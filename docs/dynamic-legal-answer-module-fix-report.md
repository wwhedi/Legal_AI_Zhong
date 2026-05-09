# 动态法律回答模块 — 综合验收报告

**性质**：基于当前仓库代码与自动化检查的**静态验收**（未改代码）。  
**日期**：以仓库验证执行日为准。

---

## 自动化验证结果

| 命令 | 目录 | 结果 |
|------|------|------|
| `python -m compileall api config services new_feature_qwen_kb` | `Legal_AI` | **通过**（exit 0） |
| `npm run lint` | `Legal_AI/frontend` | **通过** |
| `npm run build` | `Legal_AI/frontend` | **通过**（Next.js 16.2.1） |

**报告路径**：`e:\cousor\docs\dynamic-legal-answer-module-fix-report.md`

---

## 1. Prompt（`Legal_AI/config/legal_prompts.py`）

| 验收项 | 结论 | 依据摘要 |
|--------|------|----------|
| 是否已改为动态模块体系 | **是** | 「五、回答结构」写明按触发条件从模块池**动态选择**，禁止对未选用模块写占位（约 L37–L38）。 |
| 是否不再强制所有模块都出现 | **是**（中间四节可选） | 必选仅 **「1) 结论」与「6) 法律依据」**；2–5 节均为条件输出（约 L38、L40–L46）。 |
| 结论是否必选 | **是** | 「1) 结论（必选）」（约 L48–L49）。 |
| 「影响结果的关键事实」是否仅在判断类出现 | **是（规范层面）** | 明确「仅判断类、要件类」触发，纯概念/纯程序不硬凑（约 L51–L52）。 |
| 「可执行操作步骤」是否仅在流程/维权/索赔/申请等出现 | **是（规范层面）** | 触发条件含流程、维权、索赔、申请、**起诉、仲裁**等；并列举不输出情形（约 L59–L60）。 |
| 是否禁止编造案例编号、判决号、期限、赔偿标准 | **是** | 系统提示 L12–L14、用户模板 L128–L129 等。 |
| 「当前知识库未提供……」是否要求放在「需要注意」最后 | **是** | 一般注意点在前；依据不足须**单独最后一条**且**整句以「当前知识库未提供」开头**（约 L67–L69；用户模板第 10 条约 L132）。 |

**说明**：合规性依赖**模型实际遵从**；本项仅验证 prompt 文本是否覆盖要求。

---

## 2. `normalizeAnswer`（`Legal_AI/frontend/src/app/new-feature-chat/page.tsx`）

| 验收项 | 结论 | 依据摘要 |
|--------|------|----------|
| 是否支持新标题 | **是** | `SectionKind` 含 `keyFacts`；含「你现在可以这样处理」「影响结果的关键事实」「5)/6) 法律依据」等规则（与 `SEC_P6` 等配合）。 |
| 是否兼容旧标题 | **是** | 仍保留「一句话结论」「你现在最该做」「3) 需要注意」「5) 法律依据」及多种风险/建议别名。 |
| 是否避免标题残留 | **部分保证** | `stripSectionHeaderLine`、`peelFollowingSection` / `applyPeelChain` 处理同行标题；**未注册的新标题**仍可能落入当前桶。 |
| 是否不破坏 Markdown 表格 | **是（行级）** | `isCitationListLine` 避免把 `- [1]` 当标题；表格行依赖分段逻辑，与既有设计一致。 |

**备注**：解析层仍会对空 `basis`/`risks`/`actionAdvice` 填入占位字符串；**展示层**已按需隐藏，但**落库 JSON** 中可能仍含占位（见「仍建议优化」）。

---

## 3. `QwenKbAnswerCard`（`Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx`）

| 验收项 | 结论 | 依据摘要 |
|--------|------|----------|
| 是否去掉明显边框与卡片感 | **是（回答卡片根节点）** | 根节点为 `bg-transparent`、无大圆角卡片框线；操作区仅极淡分隔（约 L904–L905）。 |
| 是否仍保持主阅读宽度 | **是** | 卡片为 `w-full max-w-none`，宽度仍由外层 `page.tsx` 的 `assistantColMaxClass` / `chatContentMaxClass` 约束。 |
| 是否按动态模块顺序展示 | **是** | 顺序：**结论 → 关键事实（有则）→ 你现在可以这样处理（非占位则）→ 可执行操作步骤 → 需要注意 → 引用依据 → 知识库来源（有来源则）**（约 L913–L1000+）。 |
| 标题与正文是否有层级 | **是** | 模块标题 `text-lg font-semibold`；正文 `text-base leading-relaxed`；元信息 `text-xs`（约 L902、L916、L906）。 |
| 「需要注意」是否可读 | **是** | `RiskBulletListBlock`：普通项 `•`，边界类 `⚠` + 加粗/高亮逻辑保留。 |
| 「你现在可以这样处理」是否为编号列表 | **是** | `ActionChecklistBlock` + `useModelNumbers`，左侧编号列表。 |

---

## 4. `ActionStepsTable`（`Legal_AI/frontend/src/components/chat/ActionStepsTable.tsx`）

| 验收项 | 结论 | 依据摘要 |
|--------|------|----------|
| 是否支持「阶段 / 应对措施 / 法律要点」 | **是** | `headerMatchesLegalPoints` + `legal_points` 解析路径；第三列原文保留（含「知识库未提供明确时限」类表述）。 |
| 是否兼容旧格式 | **是** | `headerMatchesLegacySteps` + `legacy` 路径。 |
| 是否保留 emoji 与 `[n]` 引用 | **是** | 单元格均经 `renderCell`（父组件传入 `renderTextWithCitations`）；新格式第三列不做时限占位替换，利于保留 emoji。 |

---

## 5. `ProcessTimeline`（`ProcessTimeline.tsx` + `page.tsx`）

| 验收项 | 结论 | 依据摘要 |
|--------|------|----------|
| 生成中是否展开 | **是** | 流式阶段：`ProcessTimeline` … `defaultOpen={true}`（`page.tsx`）。 |
| 完成后是否默认收起 | **是** | 已落库消息：`defaultOpen={false}`。 |
| 是否不抢占正式回答视觉焦点 | **基本满足** | 完成后默认收起；生成中仍占用纵向空间，且时间线组件**自身**仍为圆角边框卡片样式（与回答区「文章流」视觉不完全一致）。 |

---

## 6. 功能回归（代码路径与本次未测项）

以下项**未做真实环境联调**，仅根据代码路径与构建通过做**静态推断**：

| 项 | 静态结论 |
|----|----------|
| `/new-rag/ask-stream` | `page.tsx` 仍 `fetch` 该路径、NDJSON 消费逻辑保留。 |
| `answer_delta` | `pushEvent` / `streamingAnswerDraft` 仍聚合 `answer_delta`。 |
| 多轮上下文 | `conversation_history` 构建与请求体字段仍在。 |
| 停止生成 | `stopGeneration`、`AbortController` 逻辑仍在。 |
| `[n]` 引用悬浮 | `renderTextWithCitations`、`CitationPopover` 未移除。 |
| 引用依据折叠 | `basisOpen` + 展开/收起仍在。 |
| 知识库来源折叠 | `KnowledgeSourcesBlock` + `compactHeader`；无来源时不渲染。 |
| 会话历史 | `ChatSessionSidebar`、`updateChatSession` 等仍在。 |

**正式环境**需人工走查：流式完整性、 citations 与正文编号一致、停写后草稿落库、移动端布局等。

---

## 综合结论

- **报告路径**：`e:\cousor\docs\dynamic-legal-answer-module-fix-report.md`  
- **compileall / lint / build**：**均通过**  
- **是否可进入正式环境人工验收**：**可以**。建议在预发/灰度完成一轮**法律场景抽测**（动态模块是否漏出/多出、表格式、违禁编造、多轮追问）后再全量。

---

## 仍建议优化的问题

1. **占位符与落库**：`normalizeAnswer` 仍可能写入 `PLACEHOLDER_BASIS` / `PLACEHOLDER_RISK` / `PLACEHOLDER_SUGGESTION`；UI 已隐藏空模块，但**持久化消息体**可能偏大或含「暂无」类字符串，若需可后续在 normalize 或序列化层精简。  
2. **时间线视觉统一**：`ProcessTimeline` 仍为独立白底卡片；若追求整页统一「无框文章流」，可再弱化其边框/背景（与第 3 步回答区对齐）。  
3. **标题残留长尾**：模型若发明未在 `SECTION_HEADER_RULES` 注册的小节标题，仍可能进错桶；可随线上日志补规则。  
4. **展示与 prompt 编号**：Prompt 为「1) 结论 … 6) 法律依据」，解析已兼容 `6)` 与 `5)` 等；若模型混用旧标题，依赖现有兼容规则，仍建议线上 spot-check。  
5. **端到端与合规**：编造禁止、模块触发、引用充分性需**人工+抽检**验证，自动化构建无法覆盖。

---

*报告结束。*
