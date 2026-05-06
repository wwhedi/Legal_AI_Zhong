# 聊天会话状态审计报告

**审计范围**：`frontend/src/app/new-feature-chat/page.tsx` 及其关联展示组件（未修改任何代码）。  
**审计日期**：2026-05-06  

---

## 1. 当前聊天页状态

`NewFeatureChatPage`（`page.tsx`）中的 React 状态与派生数据如下。

| 名称 | 类型 / 性质 | 作用 |
|------|----------------|------|
| `messages` | `useState<ChatItem[]>([])` | 聊天记录列表；用户气泡与助手气泡（含卡片或纯文本错误）均在此。 |
| `input` | `useState<string>("")` | 底部输入框受控内容。 |
| `loading` | `useState<boolean>(false)` | 是否处于一次流式请求进行中；为 true 时在列表底部渲染「进行中」区域。 |
| `streamingEvents` | `useState<RagProcessEvent[]>([])` | 当前这次请求累积的 NDJSON 事件数组；驱动进行中区域的 `ProcessTimeline` 与依据分析流。 |
| `streamingAnswerDraft` | **`useMemo` 派生**（非独立 state） | 从 `streamingEvents` 中拼接所有 `type === "answer_delta"` 或 `stage === "answer_delta"` 的 `data.delta`，作为流式回答预览文本。 |
| **错误** | **无独立 `error` state** | 网络/HTTP/解析失败、`error` 事件、或未收到 `answer` 时，通过 **`setMessages` 追加一条 `role: "assistant"` 且仅含 `content: "调用失败：…"` 的消息** 表达错误。 |
| `lastMeta` | `useState<{ model; retrievedCount } \| null>(null)` | 最近一次**成功**收到 `answer` 事件后更新，用于页头展示「模型 · 检索片段」。 |
| `lastQuestion` | `useState<string>("")` | 每次发送时写入当前问题文本；`QwenKbAnswerCard` 的「重新生成」在 `answerCard.question` 为空时回退到此值。 |

其他派生布尔：

- `answerGenerationLive`：`useMemo`，表示已出现 `answer_generation_start` 且尚未出现 `type === "answer"`，用于决定是否显示 `StreamingAnswerDraft`。

---

## 2. 当前 Message 数据结构

页面内联类型 `ChatItem`（非 `types/index.ts` 导出）：

```ts
type ChatItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  processEvents?: RagProcessEvent[];
  answerCard?: {
    answer: QwenAnswer;           // 四段结构（结论 / 依据 / 风险 / 建议）
    sources: QwenKbSource[];      // 由 citations 规范化而来
    question: string;
    modelName: string;
  };
};
```

### 用户消息

- **必有**：`id`、`role: "user"`、`content`（问题全文）。
- **无**：`processEvents`、`answerCard`。

### 助手消息（成功，带卡片）

- **`content`**：接口 `answer` 事件中的**原始** `answer` 字符串（未结构化的全文）。
- **`answerCard.question`**：对应本轮用户问题（与 `content` 并行保存）。
- **`answerCard.answer`**：`normalizeAnswer(ans)` 后的 `QwenAnswer`（结论 + details）。
- **`answerCard.modelName`**：来自 `answer` 事件的 `model`。
- **`answerCard.sources`**：`normalizeSources(citations)`，即引用列表的展示形态（`QwenKbSource[]`）。
- **`processEvents`**：在收到 `answer` 时从**截至目前**的 `streamed` 数组做的快照，并**过滤掉** `done`、`error`、`answer`、`answer_delta`（注释写明有意排除 `answer_delta` 以减小体积）。**保留** `analysis_delta` 等增量事件在快照中（若后端将其作为独立事件出现在流里）。

### 助手消息（错误 / 未完成）

- 仅 **`content`** 为错误文案（如 `调用失败：…`、`未收到完整回答`），**无** `answerCard`、`processEvents`。

### 字段对照（尤其 AI 消息是否保存）

| 字段 | 是否保存在消息中 | 说明 |
|------|------------------|------|
| question | **是**（在 `answerCard.question`） | 用户消息本身用 `content` 承载问题。 |
| answer | **是** | 原始字符串在 `content`；结构化在 `answerCard.answer`。 |
| model | **是**（`answerCard.modelName`） | 不在 `ChatItem` 顶层。 |
| retrieved_count | **否**（按条消息） | 仅更新页面级 `lastMeta.retrievedCount`，历史消息不自带检索条数。 |
| citations | **否（原始数组）** | 已转为 `answerCard.sources`；持久化时等价于保存规范化引用。 |
| processEvents | **是（可选）** | 成功卡片消息可能带过滤后的时间线快照。 |
| createdAt | **否** | 消息与时间线均无显式时间戳字段；`id` 使用 `` `u_${Date.now()}` / `a_${Date.now()}` `` 含生成时刻但非正式 schema。 |

---

## 3. 当前发送流程

用户点击发送或 Enter（非 Shift+Enter）触发 `send(overrideQuestion?)`：

1. **校验**：`question` 非空且 `!loading`。
2. **追加用户消息**：`setMessages(prev => [...prev, { id: u_${Date.now()}, role: "user", content: question }])`。
3. **输入框**：若未使用 `overrideQuestion`，`setInput("")`。
4. **会话级临时状态**：`setLastQuestion(question)`、`setLoading(true)`、`setStreamingEvents([])`。
5. **请求**：`POST ${getApiBaseUrl()}/new-rag/ask-stream`，`Accept: application/x-ndjson`，body `{ question }`。
6. **读流**：`ReadableStream` + 按 `\n` 切行，`JSON.parse` 为 `RagProcessEvent`，交给 `pushEvent`。
7. **`pushEvent` 行为**：
   - 将事件推入局部数组 `streamed`，并 `setStreamingEvents([...streamed])`，驱动进行中 UI。
   - **`answer_delta`**：仅存在于 `streamingEvents` 中；`streamingAnswerDraft` 通过 `useMemo` 累加 `data.delta`，供 `StreamingAnswerDraft` 显示（**不写 `messages`**）。
   - **`error` 类型**：追加一条助手错误消息，`return`，随后消费循环会 `setLoading(false)` 并清空 `streamingEvents`。
   - **`answer` 类型**（且 `data` 为对象，且尚未 `answerAttached`）：解析 `answer`、`model`、`retrieved_count`、`citations`，计算 `processSnapshot`（排除 `answer_delta` 等），`setMessages` 追加带 `answerCard` 与 `processEvents` 的助手消息；`setLastMeta`。
8. **流结束**：若从未附着 `answer`，再追加一条「未收到完整回答」类错误消息。
9. **`catch`**：追加助手错误消息（HTTP/网络等）。
10. **`finally`**：`setLoading(false)`、`setStreamingEvents([])` — **进行中区域的 timeline 与 answer 草稿被清空**，最终可见历史仅在 `messages` 中。

组件分工简述：

- **`ProcessTimeline`**：接收 `RagProcessEvent[]`；内部过滤掉 `done`、`error`、`answer`、`analysis`、`analysis_delta`、`answer_delta` 及部分低价值 `stage`；单独渲染「依据分析」区块（`analysis_delta` 拼接或最终 `analysis`）。
- **`StreamingAnswerDraft`**：仅展示流式原始文本预览，**不做** `normalizeAnswer`、**不展示** citations。
- **`QwenKbAnswerCard`**：展示 `question`、`modelName`、结构化 `answer`、`sources`；回调 `onRegenerate` 绑定到 `send(answerCard.question \|\| lastQuestion)`。

---

## 4. 会话历史接入点建议

- **`activeSessionId` 创建时机**  
  - 用户进入问答页且本地尚无「当前会话」时生成 UUID（或雪花 ID）；或用户点击「新对话」时生成新 ID 并设为 active。  
  - 可与 URL 查询参数同步（如 `?session=`）便于刷新恢复，属产品选型。

- **`messages` 写入 localStorage 的时机**  
  - 在 **`messages` 变化且 `!loading`** 时防抖持久化（避免流式过程中高频写入）；或在每条 `answer` / 错误消息追加后写入。  
  - 存储维度建议：`sessions[sessionsIndex]` + `activeSessionId` 两个 key，或单一 JSON blob。

- **「新建对话」应清空的状态**  
  - `messages`、`input`（可选保留草稿）、`streamingEvents`（通常已为 false）、`loading`（应 false）、`lastMeta` / `lastQuestion`（若希望新会话页头干净则清空；若希望保留「上次模型信息」可仅清 messages）。  
  - 生成新的 `activeSessionId`。

- **切换历史对话应恢复的状态**  
  - 从存储读取该会话的 `messages` 列表（以及可选 `updatedAt`、标题）。  
  - **必须**将 `loading` 置为 false、`streamingEvents` 置空（防止切换后仍显示上一场流的 UI）。  
  - `lastMeta` / `lastQuestion`：可按最后一条助手 `answerCard` 与用户消息推导，或一并存入会话元数据以避免 UI 不一致。

- **删除对话时的 `activeSessionId`**  
  - 若删除的是当前会话：切换到列表中另一条会话并恢复其 `messages`，或若无剩余则新建空会话并更新 `activeSessionId`。  
  - 同步更新 localStorage 中的会话列表与索引。

- **`AppSidebar.tsx`**  
  - 当前仅为静态导航链接，无会话列表。**适合**在此或新建专用「会话列表」组件中增加「新对话 / 历史」入口（与路由或全局 layout 组合），数据层仍建议由 `page.tsx` 或提取出的 `useChatSessions` hook 管理。

---

## 5. 风险点

| 风险 | 评估 |
|------|------|
| **loading 中的 `streamingEvents` 写入历史** | **当前不会**：`messages` 仅在 `answer` / `error` / 收尾错误 / `catch` 时追加；`finally` 清空 `streamingEvents`。持久化时若仅在 `!loading` 时保存，更不会混入进行中流水。 |
| **`answer_delta` 重复保存** | **设计上已规避**：落库的 `processEvents` 显式排除 `answer_delta`；最终全文在 `content` / `answerCard`；不会在快照与正文之间重复保存同一段流式草稿。 |
| **citations / sources 体积** | **可能偏大**：每条 `QwenKbSource` 含 `text`（条文摘要等），多条引用 × 多轮对话会放大 JSON。可考虑截断正文、仅存 ref + lawName + url，或分层存储（索引 + 懒加载）。 |
| **localStorage 配额** | 浏览器通常约 **5MB**；大量法条全文与多会话易触发 `QuotaExceededError`。需要压缩、会话数量上限、按会话 LRU 淘汰或迁到 IndexedDB。 |
| **法律场景与隐私** | 用户问题与回答可能涉敏感案情。**建议**：显著位置的「清空本地记录」、可选「禁用本地历史」、首次提示数据仅存本机；正式环境若合规要求更高，应服务端会话 + 鉴权而非仅 localStorage。 |

---

## 6. 建议分步实现方案（不改代码，仅路线）

1. **冻结消息契约**：将 `ChatItem` 提升为共享类型（或与后端对齐的 DTO），并约定持久化版本号（如 `schemaVersion: 1`），便于以后迁移。  
2. **会话容器建模**：引入 `ChatSession { id, title, createdAt, updatedAt, messages }`；`title` 可由首条用户消息截断生成。  
3. **存储层**：实现 `loadSessions` / `saveSession` / `deleteSession`（先 localStorage + 防抖；预留 IndexedDB）。  
4. **UI**：侧栏或抽屉展示历史列表 +「新对话」；切换会话时恢复 `messages` 并复位流式相关状态。  
5. **元数据补全**：在助手消息或会话 snapshot 中持久化 `retrieved_count`（若需在历史中展示检索条数，避免依赖易失的 `lastMeta`）。  
6. **隐私与容量**：上线清空按钮、会话数/总大小上限、错误处理（配额满时降级为仅内存会话）。

---

## 附录：构建与报告路径

- **报告路径**：`Legal_AI_Zhong/docs/chat-session-current-audit.md`
- **Lint / Build**：在仓库实际前端目录 `Legal_AI_Zhong/frontend` 执行（用户指令中的 `Legal_AI/frontend` 与本仓库布局不一致，故使用该路径）。

### 命令结果

- `npm run lint`：**通过**（eslint 无报错退出）。
- `npm run build`：**通过**（Next.js 16.2.1，exit code 0）。

---

## 最建议的会话数据结构（持久化友好）

在现有 `ChatItem` 基础上增加会话包裹与可选元数据，示例：

```ts
type ChatSessionV1 = {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;   // ISO8601
  updatedAt: string;
  messages: ChatItem[];  // 与线上一致；可考虑给每条消息加 optional createdAt
};

type ChatSessionIndexV1 = {
  schemaVersion: 1;
  activeSessionId: string | null;
  sessions: Array<{ id: string; title: string; updatedAt: string }>; // 列表可轻量
};
```

**助手消息增强（推荐后续迭代）**：在 `answerCard` 或顶层增加 `retrievedCount?: number`，与 `lastMeta` 解耦，保证切换会话后页头/卡片仍能显示当日检索规模而不丢失。
