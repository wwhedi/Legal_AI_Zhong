# new-rag 多轮对话上下文审计报告

**审计日期**：2026-05-08  
**范围**：仅阅读代码与配置，未改业务代码。  
**结论摘要**：当前 **new-rag 在协议与实现上均为单轮 RAG**；UI 虽有多条 `messages`，但 **请求体只含本轮 `question`**，因此后续短句（如「我是甲方」）会 **整句作为检索与改写的唯一输入**，导致检索失效。

---

## 1. 前端：`Legal_AI/frontend/src/app/new-feature-chat/page.tsx`

### 1.1 `send(question)` 当前请求体

流式接口：

- URL：`POST ${getApiBaseUrl()}/new-rag/ask-stream`
- Headers：`Content-Type: application/json`，`Accept: application/x-ndjson`
- Body：`JSON.stringify({ question })`，其中 `question` 为 `(overrideQuestion ?? input).trim()`（即 **仅一个字段 `question`**）。

对应代码：

```1147:1152:e:\cousor\Legal_AI\frontend\src\app\new-feature-chat\page.tsx
    try {
      const resp = await fetch(`${getApiBaseUrl()}/new-rag/ask-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ question }),
        signal: ac.signal,
      });
```

### 1.2 是否只发送 `question`

**是。** 未发送 `messages`、会话 id、或任何历史数组。

### 1.3 当前 `messages` 是否包含历史对话

**是（仅前端 / localStorage）。** `messages` 为 `ChatItem[]`，用户消息与助手消息（含 `answerCard`、`processEvents`）会追加并 `updateChatSession` 持久化；但 **`send` 调用 API 时未读取 `messages` 参与 body**。

### 1.4 是否可以构造「最近 6 条」`conversation_history`

**可以（前端能力具备，当前未做）。** 在发起请求前，可对 **当前 `messages`（尚未追加本轮用户消息时，为上一轮为止的历史）** 或 **追加本轮用户消息之后** 取尾部 6 条，映射为 `{ role, content }[]`。

注意：

- 本轮用户输入已在 `question` 中；若 history 含「当前轮 user」，需避免与 `question` 重复或约定「history 不含当前条」。
- 助手侧若用 `content` 全文，体积大且含引用段落；更稳妥是用 `answerCard.answer` 的结构化字段拼 **简短上下文**（例如 `conclusion` + 原 `answerCard.question`），而不是整段法规复述。

### 1.5 assistant 消息是否可提取简短上下文

**可以。** `ChatItem` 定义见 `Legal_AI/frontend/src/types/index.ts`：`answerCard.answer` 为 `QwenAnswer`（含 `conclusion`、`basis` 等），适合作为「上轮结论摘要」；`answerCard.question` 为 **该轮 API 使用的用户原句**（与流式返回里写入的 `question` 一致）。

### 1.6 是否需要避免发送 citations、法规正文、processEvents、answer_delta

**建议避免（若未来传 history）：**

- **citations / 法规正文**：不应原样塞进 history；检索已基于 KB，重复大段正文浪费 token 且易干扰改写。
- **processEvents**：含 `analysis_delta`、`timing` 等，与本轮检索无关，且体积大；前端落库时已对持久化助手消息做了「排除 `answer_delta`」的 `processSnapshot` 过滤，但 **仍不应把 process 详情当对话语义传给模型**，除非单独做调试接口。
- **answer_delta**：流式增量，不应作为历史；最终用 `answer` 事件中的完整 `answer` 或卡片摘要即可。

---

## 2. 后端：`Legal_AI/new_feature_qwen_kb/router.py`

### 2.1 `/new-rag/ask-stream` 与 `/new-rag/ask` 请求模型

两者共用 **`NewRagAskRequest`**：

```50:51:e:\cousor\Legal_AI\new_feature_qwen_kb\router.py
class NewRagAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
```

- **`/ask`**：`svc.ask(req.question)`
- **`/ask-stream`**：`async for event in svc.ask_events(req.question)`

### 2.2 是否支持 `conversation_history` 字段

**不支持。** 请求体无该字段；服务方法也只接收 `question: str`。

---

## 3. 后端：`Legal_AI/new_feature_qwen_kb/service.py`

### 3.1 `QwenKBRagService.ask` / `ask_events`

- 入口均为 **单字符串** `question`（代码中变量 `q`）。
- 流程一致：query 改写 → `kb.retrieve(search_query)` →（流式路径）公开依据分析 → 最终回答。

### 3.2 query rewrite 如何构造

使用 `LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE`，仅 **`{question}` → 当前轮 `q`**：

```372:378:e:\cousor\Legal_AI\new_feature_qwen_kb\service.py
            rewrite_user = LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE.replace("{question}", q)
            rewrite_out = await self.reasoning.generate(
                system_prompt=LEGAL_QUERY_REWRITE_SYSTEM_PROMPT,
                user_prompt=rewrite_user,
                model=self.model_name,
            )
```

`ask_events` 中同样逻辑（约 647–652 行）。

### 3.3 检索 `query` 是否只来自当前 `question`

**是。** `search_query` 来自改写 JSON 的 `search_query` 字段；若为空或解析失败则 **回退为整条当前 `q`**，再 `await self.kb.retrieve(search_query)`。**没有任何历史文本参与**。

### 3.4 最终 answer prompt 是否只包含当前 `question`

**是。** `LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE` 中 `{question}` 替换为当前 `q`；`{retrieval_query_info}` 中的「原始用户问题」也是当前 `q`（`_format_retrieval_query_info(original_question=q, ...)`）。

公开依据分析 `LEGAL_PUBLIC_ANALYSIS_USER_PROMPT_TEMPLATE` 同样只用当前 `q`。

---

## 4. `Legal_AI/config/legal_prompts.py`

### 4.1 query rewrite prompt 是否支持历史上下文

**不支持。** 用户模板仅有「用户问题：」+ `{question}` 占位（约 129–132 行）；系统提示写「只分析用户问题本身」（约 117 行），未定义多轮合并规则。

### 4.2 answer prompt 是否支持「用户补充事实」

**部分、且仅限单轮 `question` 块。** 回答侧系统提示中，表格「时间/时限」等要求「来自知识库依据或**用户问题中已明确的事实**」（`LEGAL_RAG_ANSWER_SYSTEM_PROMPT` 约 55 行），即 **允许把用户陈述当事实约束**，但输入模板只有一段 `{question}`，**没有单独结构化「用户补充事实 vs 检索依据」**；多轮补充若未进入该字符串，模型则看不到。

---

## 5. 直接回答用户列出的问题

### 5.1 当前是否是单轮 RAG？

**是。** 每个 HTTP 请求独立；检索与生成仅依赖 **本轮** `question` 字符串，无服务端会话、无 `conversation_history`。

### 5.2 为什么「我是甲方」会被单独检索？

因为 **该次请求的 `question` 就是「我是甲方」**（或用户输入的整段短句）。改写与检索链路都只读这一字符串；知识库面向法条关键词，**身份补一句不包含法律行为/争议类型时**，改写出的 `search_query` 往往仍偏短或泛化，**KB 命中差**，表现为「检索不到有效回答」。

### 5.3 前端应该传什么字段？

建议（与「默认最近 6 条 ≈ 3 轮」目标一致）：

- 保留 **`question`**：本轮用户自然语言输入（最新一句或合并句，需产品定）。
- 新增 **`conversation_history`**（或同名）：**最多 6 条** 的 `{ "role": "user"|"assistant", "content": string }[]`，`content` 为 **人工可读摘要**（用户原话可截断；助手用结论/短摘要，不要 citations 全文）。
- 可选：**`session_id`** 仅用于服务端日志与限流，不替代 history（若不做服务端存会话，可不传）。

### 5.4 后端请求 DTO 应如何扩展？

- 在 `NewRagAskRequest` 上 **可选** 增加字段，例如：  
  `conversation_history: list[ChatTurn] | None = None`  
  `ChatTurn`：`role: Literal["user","assistant"]`，`content: str`（`Field` 限制单条长度与总条数 ≤ 6，总字符上限防滥用）。
- **默认 `None` 行为与现网一致**（纯单轮），保证向后兼容。
- `QwenKBRagService.ask` / `ask_events` 签名扩展为接收 `question` + `history`（或合并为内部 `RewriteContext`），路由把 `req.conversation_history` 传入。

### 5.5 query rewrite 应如何使用历史上下文？

推荐策略（实现时可二选一或组合）：

1. **在改写 prompt 中显式分块**：「对话历史（摘要）」+「本轮用户输入」，要求模型输出 **可脱离历史独立检索** 的 `search_query`（把角色、程序节点、前序法律问题合并进关键词），并允许 `legal_intent` 覆盖完整意图。
2. **服务端先规则/轻量合并**：将 history 中最近一条「完整法律问题」与本轮短句拼接为 `rewrite_input`（仍建议走模型规范化，避免硬编码拼接过长）。

要点：**检索语句必须融合前序实体与法律关系**，不能只用本轮短句。

### 5.6 最终回答如何区分「用户补充事实」与「法律依据」？

当前模板已要求结论、行动、风险、依据分节，且法律依据只能来自 KB 切片；可在 **用户模板** 中增加固定小节，例如：

- **「用户与案情补充（非法律依据，仅作事实）」**：来自 `conversation_history` + 本轮 `question` 中用户陈述的归纳（可由改写模型或同一轮 answer 模型之前一步生成「事实摘要」，注意 **事实不得当法条引用**）。
- **「知识库检索结果 / 可引用来源」**：保持现状。

系统提示中可加一条：**用户补充事实无法从 KB 验证时，不得将其写成有法条编号支撑的法律结论**；程序/发函等事实可驱动「你现在最该做」但不伪造引用。

### 5.7 推荐最小改动方案

1. **DTO**：`NewRagAskRequest` 增加可选 `conversation_history`（≤6 条，长度限制）。  
2. **service**：  
   - 将 `history` 格式化为可读文本块，接入 **query rewrite** 与 **`retrieval_query_info` 的 `original_question` 展示**（可保留「本轮原话」+「对话摘要」两行，便于日志与 answer 对齐）。  
   - **检索**：仍以模型输出的 `search_query` 为主，但 **改写输入必须含 history**。  
   - **answer / public analysis**：用户模板增加「对话摘要」占位，**`{question}` 仍表示本轮输入**，避免与首轮长问题重复时可由前端只传本轮补充句 + history 承担前文。  
3. **前端**：发送前从 `messages` 取尾部 6 条，助手转短摘要（`answerCard.answer.conclusion` 等），**不传** `processEvents`、`answer_delta`、citations 全文。  
4. **prompt**：`LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE`（及必要时 system）增加 `{conversation}` 占位与多轮规则说明；`LEGAL_RAG_ANSWER_*` / `LEGAL_PUBLIC_ANALYSIS_*` 增加对话块占位。

该方案 **不强制服务端存会话**，依赖前端传 6 条，改动面集中在：router DTO、service 三处 prompt 拼装、前端 `fetch` body。

---

## 6. 验证命令结果（本仓库当前状态）

| 命令 | 目录 | 结果 |
|------|------|------|
| `python -m compileall api config services new_feature_qwen_kb` | `Legal_AI` | **通过**（exit 0） |
| `npm run lint` | `Legal_AI/frontend` | **通过**（exit 0） |
| `npm run build` | `Legal_AI/frontend` | **通过**（exit 0） |

---

## 7. 报告路径与结论一览

| 项 | 内容 |
|----|------|
| **报告路径** | `Legal_AI/docs/new-rag-conversation-context-audit.md` |
| **当前是否支持多轮（RAG 语义）** | **否**；仅前端列表展示多轮，**API 每轮独立、无 history**。 |
| **推荐修改方案** | 见上文 **5.7 最小改动方案**（可选 `conversation_history` + prompt/service 融合检索与回答）。 |

---

## 8. 代码索引（便于跳转）

| 模块 | 说明 |
|------|------|
| `frontend/src/app/new-feature-chat/page.tsx` | `body: JSON.stringify({ question })` |
| `new_feature_qwen_kb/router.py` | `NewRagAskRequest` 仅 `question` |
| `new_feature_qwen_kb/service.py` | `ask` / `ask_events` 仅使用 `q` 驱动改写、检索、回答 |
| `config/legal_prompts.py` | rewrite / answer / analysis 模板仅 `{question}`，无 history 占位 |
