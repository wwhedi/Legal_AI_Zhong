# new-rag 多轮上下文功能综合验收报告

**验收日期**：2026-05-08  
**范围**：对照「四步改造」与需求清单，对当前代码实现做静态验收；**未改业务代码**，仅新增本报告。

---

## 执行摘要

| 项 | 结论 |
|----|------|
| **报告路径** | `Legal_AI/docs/new-rag-conversation-context-fix-report.md` |
| **compileall** | **通过** |
| **npm run lint** | **通过** |
| **npm run build** | **通过** |
| **是否可进入正式环境实测** | **可以**。全链路前后端字段与清洗、改写与回答 prompt 已对齐；剩余风险主要为 **模型是否稳定遵循提示词**（非代码缺陷）。 |
| **多轮上下文是否已完成可验收** | **是：实现层面已完成可验收**；正式效果需联调与人工用例回归确认。 |

---

## 一、前端检查

**涉及文件**：`Legal_AI/frontend/src/app/new-feature-chat/page.tsx`、`Legal_AI/frontend/src/types/index.ts`

### 1. 请求体是否包含 `question` 与 `conversation_history`

**符合。** `fetch` 使用 `JSON.stringify({ question, conversation_history })`（约 1182–1186 行）。

### 2. `conversation_history` 构造规则

| 要求 | 结论 |
|------|------|
| 只来自当前 active session | **符合。** 使用组件 state `messages`，在 `send` 时与 `activeSessionIdRef` 一致；切换会话时 `handleSelectSession` 会替换 `messages` 为所选会话。 |
| 最多最近 6 条 | **符合。** `messages.slice(-MAX_HISTORY_MESSAGES)`，`MAX_HISTORY_MESSAGES = 6`。 |
| 不包含当前正在发送的 `question` | **符合。** `conversation_history` 在将本轮用户消息 `setMessages` 追加 **之前** 计算。 |
| user 最多 500 字 | **符合。** `MAX_USER_HISTORY_CHARS = 500`，`trim` 后 `slice`。 |
| assistant 最多 800 字 | **符合。** `MAX_ASSISTANT_HISTORY_CHARS = 800`。 |
| assistant 优先 `answerCard.answer.conclusion`，否则 `content` | **符合。** `buildConversationHistoryForAskStream` 逻辑一致。 |
| 不含 citations / source_url / 法规正文 / processEvents / answer_delta / answerCard.sources | **符合（结构化字段未序列化）。** 仅序列化 `{ role, content }`。说明：若模型在 **结论正文** 中写过 `[1]` 等标记，可能仍出现在 `conclusion` 文本内，这不属于单独传 citations 对象，属可接受的残留文本风险。 |

### 3. 停止生成、新对话、切换会话是否会混入其它会话

**符合设计预期。**

- **新对话 / 切换会话**：`messages` 与 `activeSessionId` 同步更新，`conversation_history` 仅基于当前 `messages`。
- **生成中切换 / 停止**：`currentGenerationIdRef` 与 `pushEvent` 内 `myGenerationId` 校验使 **过期流事件不写回**；`updateChatSession` 始终使用 **`sessionIdAtStart`**（发起请求时的会话），不会在代码路径上把完成结果写入「新选中的会话」。

---

## 二、后端 DTO 与清洗

**涉及文件**：`Legal_AI/new_feature_qwen_kb/router.py`、`Legal_AI/new_feature_qwen_kb/service.py`

### 1. `/new-rag/ask` 与 `/new-rag/ask-stream` 是否支持可选 `conversation_history`

**符合。** `NewRagAskRequest` 含 `conversation_history: Optional[List[ConversationMessage]]`，元素为 `role: Literal["user","assistant"]`、`content: str`；路由传 `req.conversation_history or []` 至 service。

### 2. 旧请求仅 `question` 是否兼容

**符合。** 字段默认 `None`，路由归一为 `[]`；清洗后为空，`conversation_context` 为空串，改写与回答侧走占位或无历史分支。

### 3. 服务端安全限制

**符合（不信任前端）。** `sanitize_conversation_history`：

- 仅保留输入序列 **最后 6 条**；
- `role` 仅 `user` / `assistant`；
- `content` strip，空则丢弃；
- 单条最长 **800** 字符；
- 各条 `content` **长度之和** 超 **3000** 时从 **队首** 删整条直至满足。

### 4. `conversation_context` 格式

**符合。** `build_conversation_context`：首行 `【最近对话上下文】`，随后 `用户：` / `助手：` 交替（按历史顺序）。

### 5. 是否「仅理解事实、不作法律依据」

**代码层面**：`conversation_context` 仅为拼出的文本块，**不进入 citations 构建**；法律依据仍来自本次 `kb.retrieve` 与 `ref_lines` / `kb_context`。  
**行为层面**：依赖 `legal_prompts` 中系统/用户提示约束（见第四节）。

---

## 三、query rewrite 检查

**涉及文件**：`Legal_AI/new_feature_qwen_kb/service.py`、`Legal_AI/config/legal_prompts.py`

### 1. 是否接收 `question` 与 `conversation_context`

**符合。** `_build_query_rewrite_user_prompt` 将模板中 `{conversation_context}`、`{question}` 替换；无历史时使用固定占位句引导 `context_used: false`。

### 2. 追问 / 补充事实是否要求合并检索句

**符合（提示词约束）。** `LEGAL_QUERY_REWRITE_SYSTEM_PROMPT` 与 `LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE` 中列明：我是甲方/员工、怎么办、发函、签合同未盖章等须与历史用户问题合并；并含两条示例。

### 3. 全新问题是否不强行用历史

**符合（提示词）。** 明确「完整独立法律问题且与上文无实质关联」时 `context_used` 为 false，不强行拼接。

### 4. 是否禁止把助手回答当法律依据

**符合（提示词）。** 系统与用户改写提示均写明助手内容非法律依据、不得写入 `possible_law_names` / `possible_articles` 等。

### 5. 输出字段是否包含 / 兼容

**符合。** JSON 模板含 `legal_intent`、`core_keywords`、`retrieval_query`、`search_query`（与 `retrieval_query` 对齐）、`standalone_question`、`context_used`。  
**代码：** `_normalize_rewrite_search_fields`、`_effective_search_query_from_rewrite` 保证检索仍可用 `search_query` 或 `retrieval_query`。

### 6. `query_rewrite_done` 事件 `data` 兼容性

**符合。** `_rewrite_summary_data` 在保留原字段基础上增加 **`retrieval_query`、`standalone_question`、`context_used`**，**保留 `search_query`**（值为实际用于检索的归一化语句）。旧前端可忽略新键。

---

## 四、最终回答检查

**涉及文件**：`Legal_AI/new_feature_qwen_kb/service.py`、`Legal_AI/config/legal_prompts.py`

### 1. 最终回答 user prompt 是否包含五类输入

**符合。** `LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE` 含：`{question}`、`{standalone_question}`、`{conversation_context}`、`{retrieval_query_info}`、`{kb_context}`、`{ref_lines}`。  
**代码：** `_build_rag_answer_user_prompt` 注入；无 standalone / 无上下文时使用固定占位句，避免模板缺字段。

### 2. 规则是否明确

| 要求 | 结论 |
|------|------|
| 上下文仅事实与背景 | **符合。** 用户模板小节标题 + 系统「八、多轮对话与补充事实」第 1 条。 |
| 法律依据仅来自本次检索 | **符合。** 系统「一」「八.2」与用户模板「知识库检索结果」说明。 |
| 不得把助手历史当法律依据 | **符合。** 系统八.1、用户模板「助手」说明。 |
| 不得编造法规名、链接、日期、时限 | **符合。** 系统「一」第 4 条、表格时限规则等（既有 + 多轮补充）。 |
| 上下文不足需说明缺哪些事实 | **符合。** 系统八.5、一节结论中依据不足表述等。 |

### 3. 五段结构是否保留

**符合。** `LEGAL_RAG_ANSWER_SYSTEM_PROMPT`「五」与 `LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE` 第 11 条仍强制 1)–5) 顺序与标题（第 4 节条件输出）。

### 4. citations / 来源展示是否未被破坏

**符合（本功能未改 citations 结构与前端卡片）。** 路由响应与流式 `answer` 事件仍携带 `citations`；检索与 `ref_lines` 构建逻辑未因多轮而改动数据结构。

---

## 五、功能回归（静态结论）

基于代码路径核对（未做浏览器/E2E）：

| # | 项 | 结论 |
|---|----|------|
| 1 | `/new-rag/ask-stream` 仍工作 | **是**（路由与 `ask_events` 未改事件类型，仅 body 增可选字段）。 |
| 2 | `answer_delta` 预览 | **是**（`page.tsx` 仍聚合 `answer_delta`）。 |
| 3 | 最终 `answer` 事件 | **是**。 |
| 4 | `QwenKbAnswerCard` 解析 | **是**（未改卡片与 `normalizeAnswer` 消费逻辑）。 |
| 5 | `[n]` 引用悬浮 | **是**（未改引用渲染组件）。 |
| 6 | 来源默认折叠 | **是**（未改该 UI）。 |
| 7 | `ActionStepsTable` | **是**（未改）。 |
| 8 | 会话保存与恢复 | **是**（未改 localStorage schema）。 |
| 9 | 停止生成 | **是**（仍 abort + generation id）。 |
| 10 | 生成中切换不写错会话 | **是**（见第一节 stale 与 `sessionIdAtStart`）。 |
| 11 | history 不跨会话污染 | **是**（state 与 ref 与当前会话一致）。 |

---

## 六、建议测试用例与预期

以下为 **联调/实测** 用例（与需求一致），预期行为依赖 **模型 + 知识库命中**，代码侧已提供上下文与改写输入。

| 测试 | 第一轮 | 第二轮 | 预期 |
|------|--------|--------|------|
| **1** | 甲公司销售总监未经法务审核，直接与客户乙公司签署合同，合同有效吗？ | 我是甲方 | 结合合同效力/表见代理/职务行为等主题作答，**不应**仅按「我是甲方」单独检索后说无法回答。 |
| **2** | 公司把我从技术岗调到销售岗，我不同意，他能解除我吗？ | 那我该怎么办？ | 在调岗与解除框架下给出维权、证据与步骤建议（有法条处带 `[n]`）。 |
| **3** | 竞业限制协议最多约定几年？ | 如果我是高级研发工程师呢？ | 在竞业限制主题下结合「适用主体/人员范围」等延伸，不脱离上轮主题。 |
| **4** | 劳动仲裁怎么申请？ | 我已经离职三个月了 | 在仲裁流程下讨论时效、材料与时间相关注意点（依检索结果）。 |
| **5** | 租房合同提前退租需要承担什么责任？ | 房东已经扣了押金 | 在退租/违约责任框架下讨论押金抵扣与下一步处理。 |

---

## 七、命令结果

```text
cd Legal_AI
python -m compileall api config services new_feature_qwen_kb
→ 通过（exit code 0）

cd Legal_AI/frontend
npm run lint
→ 通过（exit code 0）

npm run build
→ 通过（exit code 0）
```

---

## 八、残留问题与建议（非阻塞项）

| 位置 | 说明 | 影响 | 是否阻塞正式测试 | 建议 |
|------|------|------|------------------|------|
| 模型输出 | 改写/回答是否 100% 遵守 prompt 无法由静态代码保证 | 体验与命中率 | **否** | 正式环境用第六节用例做抽样；必要时收紧 temperature 或加后处理校验。 |
| 历史 `conclusion` 文本 | 可能含 `[n]` 等标记，非结构化 citations | 极低 | **否** | 若需可在前端发送前 strip `[数字]`（属增强，非本次验收缺项）。 |
| 公开依据分析 | 仍通过 `_prepend_conversation_context` 拼接，模板以「用户问题」为主 | 分析段落对多轮的显式对齐弱于最终回答 | **否** | 若产品上希望分析区也显式展示 `standalone_question`，可作为后续迭代。 |

---

## 九、总评

**多轮上下文是否已完成可验收：是（实现与静态验收通过，建议正式环境按第六节用例做实测闭环）。**
