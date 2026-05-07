# Answer Card：解析与展示可行动性审计（new-feature-chat / QwenKbAnswerCard）

**范围**：仅审计，不包含代码变更。  
**前端路径**：仓库内实际前端为 `Legal_AI/frontend`（不存在 `Legal_AI_Zhong/frontend`）。  
**构建**：在 `Legal_AI/frontend` 执行 `npm run lint` 与 `npm run build`，均成功完成（exit code 0）。

---

## 1. 当前 `QwenAnswer` 数据结构

定义位置：`frontend/src/components/chat/QwenKbAnswerCard.tsx`。

```ts
export type QwenAnswerDetail = {
  title: string;
  content: string;
};

/** conclusion 为「结论」正文；details 顺序为 依据、风险点、建议（由 normalizeAnswer 保证） */
export type QwenAnswer = {
  conclusion: string;
  details: QwenAnswerDetail[]; // 约定长度 3：[依据, 风险点, 建议]
};
```

会话落库类型 `frontend/src/types/index.ts` 中 `ChatItem.answerCard` 引用同一 `QwenAnswer`，并附带 `sources`、`question`、`modelName`、`retrievedCount`。

---

## 2. `normalizeAnswer` 支持的「标题」与分段语义

实现位置：`frontend/src/app/new-feature-chat/page.tsx`。

内部枚举：`SectionKind = "conclusion" | "basis" | "risk" | "suggestion"`。  
按行扫描：若该行匹配 `detectSectionHeaderLine`，则切换当前桶并可选剥离标题后的首行正文；否则并入当前桶。

### 2.1 明确识别的标题形式（摘要）

| 逻辑小节 | 识别要点（含编号形式） |
|---------|------------------------|
| **结论** | `1）结论` / `一、结论` / `1.结论`；行首 `结论` + 冒号/空格/行尾；排除以「结论性…」误触发的情形（负向前瞻） |
| **依据** | `2）依据` / `二、依据` / `2.依据`；行首 `依据` + 冒号/空格 |
| **风险点 / 风险** | `3）风险点` / `三、风险点` / `3.风险点`；单独 `风险点`；`3）风险` / `风险` + 冒号/空格（`风险` 后不能紧跟 `点`，避免与「风险点」重复匹配） |
| **建议** | `4）建议` / `四、建议` / `4.建议`；**另支持** `3）建议` / `三、建议`（与「三、风险」编号冲突，以先匹配行为准） |

**不视为标题**：形如 `- [1] …` 的引用列表行（避免把 `[n]` 当成章节号）。

### 2.2 附加纠错与兜底

- **`peelFollowingSection`**：若「依据 / 风险点|风险 / 建议」标题挤在同一段落内，会从上一段末尾拆出后续小节正文。
- **空「建议」时的启发式**：从「依据」行中按 `ACTION_LINE_RE`（如「建议」「应当」「需要」「请…」等开头）切开，把后半挪到「建议」。
- **`fallbackFourPart`**：当全文看起来「无结构化标题」且 basis/risk/suggestion 都为空时，按空行分段：≥4 段 → 依次对应结论/依据/风险/建议；3 段 → 结论/依据/建议；2 段 → 结论/依据；否则按行状态机（列表引用、`风险点：`、`ACTION_LINE_RE`）猜阶段。

### 2.3 固定输出形态

无论解析路径如何，最终 **永远** 返回：

- `conclusion`：字符串  
- `details`：**恰好三项**，且 **`normalizeAnswer` 将 `title` 写死为** `"依据"`、`"风险点"`、`"建议"`（内容可为占位文案）。

---

## 3. 与目标结构的兼容性（一句话结论 / 你现在最该做 / 风险提示 / 法律依据 / 可执行操作步骤）

目标：

1. 一句话结论  
2. 你现在最该做  
3. 风险提示  
4. 法律依据  
5. 可执行操作步骤（仅部分题型）

### 3.1 当前是否原生支持

| 目标块 | 是否原生支持 | 说明 |
|--------|--------------|------|
| 一句话结论 | **部分** | 若模型仍用「结论」或小标题编号，会进入 `conclusion`。若模型写「一句话结论：」**单独成行**，**不会**被 `detectSectionHeaderLine` 识别，该行会留在默认桶「结论」中，UI 仍显示固定标题「结论」，且标题字样会混在正文中。 |
| 你现在最该做 | **否** | 无对应 `SectionKind`，也不会触发分段；内容多半留在 `conclusion` 或与启发式/兜底混在一起。 |
| 风险提示 | **部分** | 「风险点」「风险：」类可进 `risk`。**「风险提示：」不符合现有 `风险` 正则**（`风险` 后必须直接接冒号/空白等，不能插入「提示」二字），通常**不会**单独成段。 |
| 法律依据 | **部分** | 「依据：」可进 `basis`。**「法律依据：」不匹配**（要求行首直接为「依据」），通常归入结论或未分段正文。 |
| 可执行操作步骤 | **否** | 无独立段落类型；若写法像「建议」或启发式动作句，可能落入 `suggestion`，但与「你现在最该做」无法区分，也无「按需展示」开关。 |

### 3.2 卡片展示层（`QwenKbAnswerCard`）

- 顶部渐变区 **硬编码** 小标题 **「结论」**，正文为 `answer.conclusion`。  
- 下列三块：**第一块**用 `details[0].title`（实为「依据」），**风险**区硬编码 **「风险点」**（忽略 `details[1].title`），**建议**区硬编码 **「建议」**。  
- **没有**第五块（操作步骤），也没有「你现在最该做」独立样式。

**结论**：目标 5 段式信息架构 **无法** 在无改动前提下稳定表达；旧四段（结论/依据/风险点/建议）与当前解析、展示 **一致且可用**。

### 3.3 兼容旧结构的推荐思路（概念层）

1. **解析层**：在 `detectSectionHeaderLine` / `stripSectionHeaderLine` 增加 **别名映射** 到现有四个桶或新增桶（例如「法律依据」→ `basis`，「风险提示」→ `risk`，「一句话结论」→ `conclusion`，「你现在最该做」→ 新字段或映射到 `suggestion` 前一格）。  
2. **数据层**：`QwenAnswer` 可演进为「有序章节列表」或「固定键 + 可选 `steps`」，并对历史消息做 **缺省回填**（旧三条 `details` 不变）。  
3. **展示层**：按章节 `type`/`role` 渲染标题与是否展示「操作步骤」；旧数据无 `steps` 则不渲染该卡片区域。  
4. **提示词**：在后端模板中统一小节标题（若仓库后续加入 `config/legal_prompts.py`，需与前端别名表一致）。

---

## 4. Markdown 表格能否正确展示

- `QwenKbAnswerCard` 通过 `renderTextWithCitations` 将文本按 `(\[\d+\])` 切分，非引用片段包在带 `whitespace-pre-wrap` 的 `<span>` 中。  
- 工程 **未** 依赖 `react-markdown` / `remark` 等（`package.json` 无相关依赖）。  
- **GitHub 风格表格**（`|`、`---`）会以 **纯文本** 显示；等宽与换行可能近似对齐，但 **不是** HTML `<table>`，无列对齐语义与无障碍表格结构。  
- 流式预览 `StreamingAnswerDraft` 同样是 **纯文本** `whitespace-pre-wrap`。

---

## 5. 流式与最终答案路径（`answer_delta` / `answer`）

- **`answer_delta`**：`streamingEvents` 中 `type === "answer_delta"` 或 `stage === "answer_delta"` 时，拼接 `data.delta` → `streamingAnswerDraft`。展示组件明确说明 **不做四段解析、不展示 citations**。  
- **最终 `answer` 事件**：从 `data.answer`、`citations` 等组装 `ChatItem`；`normalizeAnswer(ans)` 得到卡片数据；`content` 保留 **原始** `ans` 字符串。  
- 持久化：`processSnapshot` **过滤掉** `answer_delta`，减小体积。

---

## 6. `QwenKbAnswerCard` 其他行为（引用与来源）

- **[n] 悬浮/点击**：`renderTextWithCitations` + `InlineCitationMark`；`sourceById` 来自 `sources` 的 `id`。无匹配 id 时退化为普通文本。  
- **知识库来源**：`KnowledgeSourcesBlock` 默认折叠，展开后列表展示 `[id]`、法规名、章节条文、状态、链接及摘要；与正文 `[n]` 分离。

---

## 7. `config/legal_prompts.py`（`LEGAL_RAG_ANSWER_*`）

在当前仓库 `e:\cousor` 下 **未找到** `legal_prompts.py`，也未检索到 `LEGAL_RAG_ANSWER_SYSTEM_PROMPT` / `LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE` 字符串。审计无法覆盖该文件内容；若提示词仅存在于其他仓库或部署环境，需在对应仓库与前端 `normalizeAnswer` **对齐小节标题**。

---

## 8. 推荐分几步改最稳（仅实施顺序建议）

1. **契约先行**：定稿对外小节标题（含别名表），并决定是否引入 JSON 结构化输出 vs 纯 Markdown 标题；避免「三、」同时表示风险与建议的歧义。  
2. **解析扩展**：在 `normalizeAnswer` 增加别名与可选第 5 段（操作步骤），输出结构 **向后兼容**（旧三路 `details` 仍可填满）。  
3. **类型与持久化**：扩展 `QwenAnswer`（或 `answerCard` schemaVersion），加载旧会话时缺省字段用占位或隐藏区块。  
4. **UI**：`QwenKbAnswerCard` 按新顺序与条件渲染「操作步骤」；标签与硬编码「结论/风险点/建议」对齐新产品文案。  
5. **表格（若需要）**：引入受限 Markdown 子集或专用表格组件，并确保与 `[n]` 切分逻辑组合无 XSS（若走 HTML 渲染需消毒）。  
6. **联调**：流式阶段是否提前分段预览（可选，复杂度高）；后端 prompt 与前端解析一同发布。

---

## 9. 文件索引

| 路径 | 角色 |
|------|------|
| `frontend/src/app/new-feature-chat/page.tsx` | `normalizeAnswer`、`answer_delta` 聚合、`answer` 落库、`ChatItem` / `answerCard` |
| `frontend/src/components/chat/QwenKbAnswerCard.tsx` | `QwenAnswer`、四段 UI、引用与来源折叠 |
| `frontend/src/types/index.ts` | `ChatItem`、`QwenKbSource`、RAG 事件类型 |
| `frontend/src/components/chat/StreamingAnswerDraft.tsx` | 流式原始文本预览 |
