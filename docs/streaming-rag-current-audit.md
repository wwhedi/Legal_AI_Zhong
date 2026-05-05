# Streaming RAG 当前代码审计报告

**审计日期**：以仓库当前代码为准（审计执行时）  
**审计范围**：Legal_AI_Zhong 下第 1～7 步相关实现；**仅阅读与命令验证**，未改动业务代码、prompt、样式与配置。

---

## 1. 当前功能目标

当前系统希望实现的能力（与代码意图对齐）：

| 能力 | 实现位置（概要） |
|------|------------------|
| 用户输入问题 | `frontend/src/app/new-feature-chat/page.tsx` → `POST /new-rag/ask-stream` |
| query rewrite | `new_feature_qwen_kb/service.py` → `QwenKBRagService.ask_events` / `ask`，`ReasoningService.generate` + `LEGAL_QUERY_REWRITE_*` |
| 知识库检索 | `QwenKBRagService` → `AliyunKBService`（bailian）或 `LocalKBService`（local） |
| 有效法条筛选 | `_filter_effective_citations`、`_renumber_citations`；流式中 `retrieval` / `effective_filter_done` |
| 公开依据分析流式输出 | `ask_events`：`analysis_start` → `generate_stream` → `analysis_delta` → `analysis`（`analysis_done`） |
| 最终回答流式输出 | `ask_events`：`answer_generation_start` → `generate_stream` → `answer_delta` → `answer` |
| 最终规范回答卡片 | 收到 `type: "answer"` 后 `normalizeAnswer` + `QwenKbAnswerCard` |
| `[n]` 引用悬浮卡片 | `QwenKbAnswerCard.tsx`：`renderTextWithCitations`、`InlineCitationMark`；依据分析区 `ProcessTimeline.tsx` 复用 |
| 知识库来源折叠 | `QwenKbAnswerCard.tsx`：`KnowledgeSourcesBlock`，默认 `expanded=false` |
| 本地 local/ollama 测试模式 | `RAG_BACKEND=local` + `MODEL_BACKEND=ollama`，见 `new_feature_qwen_kb/service.py`、`.env.example`、`README.md` |
| 正式 bailian/dashscope 模式 | `RAG_BACKEND=bailian` + `MODEL_BACKEND=dashscope`（默认） |

---

## 2. 当前接口清单

### FastAPI 挂载（`api/main.py`）

- `app.include_router(kb_update_router)` → 前缀 **`/kb-update`**（定义于 `api/kb_update_api.py` 的 `APIRouter(prefix="/kb-update")`）。
- `app.include_router(new_rag_router)` → 前缀 **`/new-rag`**（定义于 `new_feature_qwen_kb/router.py`）。

### 与 RAG 问答直接相关的路由（`new_feature_qwen_kb/router.py`）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/new-rag/ask` | 非流式：一次返回 `NewRagAskResponse`（question、answer、model、retrieved_count、citations）。 |
| POST | `/new-rag/ask-stream` | 流式 NDJSON：`StreamingResponse`，`media_type=application/x-ndjson; charset=utf-8`，每行一个 JSON 事件。 |

### KB 更新相关（示例，非穷举）

- `/kb-update/jobs`（创建任务）、`/kb-update/jobs/{id}/start`、`/kb-update/jobs/{id}/stop`、任务查询与步骤页等（见 `api/kb_update_api.py` 与前端 `/kb-update/*`）。

### 已确认**不存在**于 `api/` 挂载范围内的路由（代码检索）

在 `Legal_AI_Zhong/api` 下对路径字符串检索：**未发现** 挂载 **`/qa`**、**`/review`**、**`/new-rag/local-prompt`**。

---

## 3. `/new-rag/ask` 当前状态

**文件**：`new_feature_qwen_kb/router.py`、`new_feature_qwen_kb/service.py` 中 `QwenKBRagService.ask`。

1. **请求体**：`NewRagAskRequest`，字段 **`question: str`**（`min_length=1`, `max_length=4000`）。仍为 **`{ "question": string }`** 语义。

2. **响应体**（`NewRagAskResponse`）：**question**（来自请求）、**answer**、**model**、**retrieved_count**、**citations**（与 `ask()` 返回字典对齐后填充）。

3. **四段回答 prompt**：`ask` 使用 **`LEGAL_RAG_ANSWER_SYSTEM_PROMPT`** 与 **`LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE`**（`config/legal_prompts.py`），明确要求 **1) 结论 / 2) 依据 / 3) 风险点 / 建议：**（第四部分以「建议：」行首等形式）。**流式与非流式共用同一套回答 prompt**（`ask` 仍调用 `ReasoningService.generate`，未改为流式）。

4. **`[n]` 引用**：系统与用户 prompt 中强制编号、句末引用等规则；`ask` 路径上由模型遵从，前端 `normalizeAnswer` + `QwenKbAnswerCard` 解析展示。

5. **仅基于知识库**：`LEGAL_RAG_ANSWER_*` 与检索链路约束「只能使用检索结果与可引用来源清单」；**模型若违约属产品风险**，代码层无法完全禁止。

---

## 4. `/new-rag/ask-stream` 当前状态

**文件**：`new_feature_qwen_kb/router.py`（`ask_new_rag_stream` → `async for event in svc.ask_events` 逐行 `json.dumps` + `"\n"`）、`new_feature_qwen_kb/service.py`（`ask_events`）。

**是否为真流式**：在 `async for delta in self.reasoning.generate_stream(...)` 循环内 **每收到一段 `delta` 即 `yield` 事件**，故 **analysis_delta / answer_delta 在服务端为增量产出**；传输层为 **chunked 流**（取决于 ASGI/uvicorn 与客户端缓冲）。**query rewrite 与 KB retrieve 仍为整段 await 完成后才发事件**。

### 当前可能输出的事件 `type` / `stage`（以 `service.py` 为准）

| type | stage | 何时输出 | data 字段（主要） | 用户可见分析/回答正文 | 敏感信息风险 | 实时性 |
|------|--------|----------|-------------------|------------------------|--------------|--------|
| error | error | 问题为空；依据分析失败；正式回答生成失败；外层异常 | 多为 `{}`；输入错误时 `message` 为截断的 `str(exc)` | 仅 `message` 文案 | `message` 可能含异常摘要（**非**完整栈）；不含密钥 | 即时 |
| progress | query_rewrite_done | 改写完成（或失败回退后仍发摘要） | `legal_intent`, `core_keywords`, `search_query`, `query_variants`, `required_filters` 等 | 检索意图类元数据 | 不含 prompt/密钥 | 改写整段完成后 |
| retrieval | kb_retrieve_done | `kb.retrieve` 返回后 | `retrieved_count`, `citations_summary` | 法条摘要列表 | 法条摘要来自 KB | 检索完成后 |
| retrieval | effective_filter_done | 筛选后 | `effective_count`, `removed_count` | 统计信息 | 低 | 即时 |
| progress | analysis_start | 进入公开依据分析前 | `{}` | 无正文 | 低 | 即时 |
| analysis_delta | analysis_delta | `generate_stream` 每次非空 delta | `delta` | **增量依据分析** | 为模型输出；**非** prompt/密钥 | **逐 token/块** |
| analysis | analysis_done | 依据分析流结束 | `analysis`（完整文本） | **完整依据分析** | 同上 | 全文拼接后 |
| progress | answer_generation_start | 开始生成正式回答（含两条早退路径：无 kb 或无有效法条） | `{}` | 无 | 低 | 即时 |
| answer_delta | answer_delta | 正式回答 `generate_stream` 每次非空 delta（**仅**有效法条分支） | `delta` | **增量回答草稿** | 同上 | **逐块** |
| answer | answer_generation_done | 正式回答拼接完成或早退固定文案 | `question`, `answer`, `model`, `retrieved_count`, `citations` | 完整回答 + citations | citations 可含 `source_url`、法条字段；**不含** AK/SK | 整段 answer 就绪后 |
| done | done | 正常结束 | `{}` | 无 | 低 | 即时 |

**说明**：

- **早退路径**（`not kb_context` / `not effective_only`）：仅有 **`answer_generation_start` → `answer` → `done`**，**无** `analysis_*`、**无** `answer_delta`（固定文案，不调模型流式）。
- **`ask-stream` 的 `ndjson_body` 仅 `except ValueError`**：`ask_events` 内其他未捕获异常可能导致连接异常而**无**规范 `error` 事件；属健壮性风险（见第 16 节）。

---

## 5. 公开依据分析实现情况

1. **存在性**：`config/legal_prompts.py` 中定义 **`LEGAL_PUBLIC_ANALYSIS_SYSTEM_PROMPT`**、**`LEGAL_PUBLIC_ANALYSIS_USER_PROMPT_TEMPLATE`**，并已列入 `__all__`。

2. **Prompt 是否明确「非最终回答 / 非思维链 / 仅有效法条 / 结构」**：系统 prompt 写明 **不是最终回答**、**不得展示模型内部隐藏思维链**、**只能使用有效法条清单与检索结果**；输出结构含 **问题焦点、主要依据、辅助依据、依据充分性、回答边界**（条目式）。

3. **后端是否调用**：`new_feature_qwen_kb/service.py` 的 `ask_events` 在有效法条分支中 `LEGAL_PUBLIC_ANALYSIS_USER_PROMPT_TEMPLATE.format(...)` + `ReasoningService.generate_stream(..., LEGAL_PUBLIC_ANALYSIS_SYSTEM_PROMPT, ...)`。

4. **`analysis_delta`**：同一函数内在 `async for delta` 中 **`yield` `etype=analysis_delta`**。

5. **`analysis_done` 完整文本**：随后 **`yield` `type=analysis`, `stage=analysis_done`, `data.analysis`**。

6. **`[n]` 保留**：prompt 要求关键判断带 `[n]`；`ref_lines` 与 `_renumber_citations` 提供编号一致性基础。

---

## 6. 最终回答流式输出实现情况

1. **后端 `answer_delta`**：`ask_events` 主路径在 **`LEGAL_RAG_ANSWER_*`** 上调用 **`generate_stream`**，循环内 **`yield` `answer_delta`**（`data.delta`）。

2. **是否逐步输出**：是，与 **`create_chat_completion_stream`** 的异步迭代一致。

3. **最终 `answer` 事件**：仍 **`type=answer`, `stage=answer_generation_done`**，`data` 含 **`question`, `answer`, `model`, `retrieved_count`, `citations`**，与 `/new-rag/ask` 语义对齐。

4. **前端草稿**：`page.tsx` 对 `streamingEvents` 累积 **`answer_delta`**，在 **`StreamingAnswerDraft`** 中展示（见第 9 节与**当前构建状态**）。

5. **`QwenKbAnswerCard`**：仅在收到最终 **`answer`** 后 **`normalizeAnswer`** 再渲染；**增量阶段不解析四段结构**（符合需求）。

6. **citations**：仍只来自最终 **`answer`** 事件的 `data.citations`（早退路径亦如此）。

---

## 7. ReasoningService 流式能力检查

**文件**：`services/reasoning_service.py`、`config/dashscope_config.py`。

| 检查项 | 结论 |
|--------|------|
| `generate_stream` | **已存在**：委托 **`create_chat_completion_stream`**。 |
| `dashscope_config` 流式 | **`create_chat_completion_stream`**：`AsyncOpenAI` + **`chat.completions.create(..., stream=True)`**。 |
| `MODEL_BACKEND=ollama` | **支持** `stream=True`（Ollama 兼容 chat）。 |
| `MODEL_BACKEND=dashscope` | **实现为** 同一 **`chat.completions` 流式**；与 **`create_chat_completion` 非流式路径使用的 `responses.create`** **不同 API**（文件内注释已说明）。 |
| 不支持 stream 时 | **无静默降级**；抛错由 `ask_events` 捕获后 **`error` 事件**（依据分析 / 正式回答段分别 try/except）。 |
| 自动 fallback | **`normalize_model_backend`** 仅允许 `dashscope` / `ollama`；**无** DashScope 失败后自动切 Ollama。 |

### 对正式 DashScope 模式的影响（重点）

- **非流式** `/new-rag/ask` 与 query rewrite：**仍走 `responses.create`**（与历史 README 描述一致）。
- **流式**（依据分析 + 正式回答）：**走 `chat.completions` 流式**。若百炼/DashScope 侧对某 **`model`** 或账号 **不支持该兼容流式接口**，则 **`ask-stream` 在对应阶段会失败**并返回 **`error`** 事件；**不会自动回退到非流式**。
- **是否需要显式非流式兜底配置**：当前代码**无**「仅流式失败则改非流式」的显式开关；若正式环境验收失败，需产品/运维决策（**本审计不新增 fallback**）。

---

## 8. 前端流式解析实现情况

**文件**：`frontend/src/app/new-feature-chat/page.tsx`。

| 检查项 | 结论 |
|--------|------|
| 调用 `/new-rag/ask-stream` | **是**，`fetch(..., Accept: application/x-ndjson)`。 |
| ReadableStream | **是**，`resp.body.getReader()`。 |
| NDJSON 行解析 | **`buffer += decode`**，`split("\n")`，末段留在 **`buffer`** 直至下一 chunk 或结束再 `consumeNdjsonLine`** → **可处理跨 chunk 半行**。 |
| `analysis_delta` / `analysis`（done） | **ProcessTimeline** 内累积与覆盖逻辑（见 `ProcessTimeline.tsx`）。 |
| `answer_delta` / `answer` | **`streamingAnswerDraft` useMemo** + **`answerGenerationLive`**；**`answer` 触发 `pushEvent` 挂载卡片**。 |
| `error` / `done` | **`error`**：`pushEvent` 追加错误 assistant 消息并中断；**`done`**：无单独分支，依赖流结束与 **`answer`** 检测。 |
| delta 时立即刷新 | **`setStreamingEvents([...streamed])`** 每次事件触发。 |
| loading | **`loading` state**；结束后 **`setStreamingEvents([])`**。 |
| 请求失败 | **`resp.ok` 否**：`throw`，catch 中 **`调用失败：${msg}`**（截断）；**不展示完整栈**。 |

**说明**：`JSON.parse` 失败行被 **静默忽略**（catch 空），极端损坏流可能导致无反馈。

---

## 9. ProcessTimeline /「检索与依据分析」UI

**文件**：`frontend/src/components/chat/ProcessTimeline.tsx`。

| 检查项 | 结论 |
|--------|------|
| 标题 | **「检索与依据分析」**（非「处理过程」）。 |
| 低价值状态 | **`LOW_VALUE_STAGES`** 过滤 `start`、`query_rewrite_start`、`kb_retrieve_start`、`answer_generation_done`；**`analysis_start` / `analysis_done` 不出现在主列表**；**`analysis_delta` / `answer_delta` 不出现在主列表**。 |
| 检索意图 / 关键词 / 检索语句 | **`query_rewrite_done`** 的 `EventDetail` 展示 `legal_intent`、`core_keywords`、`search_query`。 |
| 检索法条摘要 | **`kb_retrieve_done`**：`retrieved_count` + `citations_summary` 行。 |
| 有效法条数量 | **`effective_filter_done`**：`effective_count`、`removed_count`（注意 stage 名为 **`effective_filter_done`**，与部分文档中的 `effective_law_filter_done` 命名可能不一致）。 |
| 公开依据分析 | **`AnalysisBody`**：`analysis_start` 加载文案；**`analysis_delta` 实时拼接**；**`analysis_done` 的 `data.analysis` 覆盖校准**；**`renderTextWithCitations`**。 |
| `[n]` 在 analysis 区悬浮 | **复用** `QwenKbAnswerCard` 导出的 **`renderTextWithCitations`** + `kb_retrieve_done` 构建的 **`sourceById`**。 |
| 过长撑页 | 主面板 **`max-h-64 overflow-y-auto`**；近底部自动滚动逻辑在 **`useLayoutEffect`**。 |
| 展开/收起 | **顶部按钮**控制 **`open`**。 |

---

## 10. QwenKbAnswerCard 当前状态

**文件**：`frontend/src/components/chat/QwenKbAnswerCard.tsx`；四段解析在 **`page.tsx` 的 `normalizeAnswer`**（与卡片同页使用）。

| 检查项 | 结论 |
|--------|------|
| 四段结构 | **结论** + details **依据 / 风险点 / 建议**（`normalizeAnswer` + 占位符兜底）。 |
| `[1]` 误识别为结构编号 | **`isCitationListLine`**、**`detectSectionHeaderLine`** 等规避列表行 **`-[n]`**；仍可能存在**边界口吻**导致误分段（启发式固有风险）。 |
| 风险点 / 建议独立 | **风险点**为 `details[1]`，**建议**为 `details[2]`；另有 **`peelFollowingSection`** 等从结论/依据中剥离尾随小节。 |
| 知识库来源默认折叠 | **`KnowledgeSourcesBlock`** 初始 **`expanded=false`**。 |
| 展开后字段 | **`[id]`、lawName、章节/条文、时效性、链接（或「未提供」）、正文摘要 line-clamp** 等。 |
| `[n]` 交互 | **`InlineCitationMark`**：hover/click 弹出 **`CitationPopover`**。 |
| `source_url` | **`href={url}`** `target="_blank"`；无 URL 则文案「链接：未提供」。 |
| 缺失字段 | **`pickStr` / 卡片多处** 默认 **「未提供」** 或占位文案。 |

---

## 11. 本地测试模式兼容性

| 检查项 | 结论 |
|--------|------|
| `RAG_BACKEND=local` | **`new_feature_qwen_kb/service.py`** 中 **`_kb_service_from_env`** → **`LocalKBService`**。 |
| `MODEL_BACKEND=ollama` | **`create_chat_completion` / `create_chat_completion_stream`** 的 ollama 分支。 |
| `LOCAL_KB_PATH` | **`LocalKBService`**：`os.getenv("LOCAL_KB_PATH")`，默认相对 **`data/dev_law_chunks.json`**（`_resolve_kb_path`）。 |
| `data/dev_law_chunks.json` | **存在**；含 **`effective_status":"有效"`** 等示例切片，可用于命中与引用。 |
| 本地是否可不配阿里云 AK/SK | **local + ollama** 时 **不调用** `AliyunKBService`、不调用 DashScope **非流式**路径；**流式仍调 Ollama**，无需阿里云。 |
| local / ollama 自动 fallback | **`_kb_service_from_env`** 与 **`normalize_model_backend`**：**无效值抛 `RuntimeError`**；**无**检索失败后自动 bailian、**无** DashScope 失败后自动 Ollama。 |

---

## 12. 正式阿里云模式兼容性

| 检查项 | 结论 |
|--------|------|
| `RAG_BACKEND=bailian` | **`AliyunKBService`**；需 **`AliyunKBService._validate`** 所列环境变量。 |
| `MODEL_BACKEND=dashscope` | **`create_chat_completion`**：`responses.create`；**流式**：**`chat.completions` 流式**（见第 7 节）。 |
| 常见环境变量 | **DashScope**：`DASHSCOPE_API_KEY`（必填）、`DASHSCOPE_BASE_URL`（可选）、`REASONING_MODEL_NAME` / `NEW_QWEN_MODEL_NAME`、`REASONING_TEMPERATURE`。 **百炼**：`ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`BAILIAN_WORKSPACE_ID`、`BAILIAN_INDEX_ID`、`BAILIAN_ENDPOINT`（代码读 **`BAILIAN_ENDPOINT`**，`.env.example` 已注释说明）。 |
| `ask-stream` 兼容正式模式 | **同一套** `ask_events`；仅后端 env 切换；**流式阶段依赖 DashScope 兼容 chat 流式是否对该 model 可用**。 |
| DashScope 流式不可用时的表现 | **`generate_stream` 抛错** → **`error` 事件**（依据或回答阶段）；**整条 ask-stream 失败**。 |
| 显式非流式兜底配置 | **当前无**；需工程上另加开关才算「显式配置」（本审计不实现）。 |
| citations 与正式切片 | **`normalizeSources`** 依赖 `ref_id`、`law_name` 等字段；百炼返回结构需与 **`parse_law_chunk_text` / `AliyunKBService` 映射** 一致，否则前端展示为「未提供」或编号异常；**属集成契约风险**。 |

---

## 13. 安全与合规检查

| 检查项 | 结论 |
|--------|------|
| 模型隐藏思维链 | **流式仅取 `delta.content`**（`_delta_public_text_only`）；**不读取** reasoning 字段。仍依赖模型不在 `content` 中混入链式自述。 |
| 完整 prompt | **事件不包含** system/user prompt 全文。 |
| API Key / AK/SK | **事件不包含**；**切勿**把 `.env` 或错误响应中的密钥贴到前端。 |
| 环境变量 | **未在 NDJSON 中输出**。 |
| 完整 traceback 给前端 | **`router.ask` 500** 的 `detail` 含 **`{exc}`**（非 ask-stream）；**`ask-stream`** 中 **`error` message** 为固定或截断短文案；**`ask_events` 异常** 的通用 **`message`** 为固定句。 |
| 外部法律信息 | **Prompt 禁止**；**无法从代码层证伪**模型是否遵守。 |
| 仅「有效」法条 | **代码层**：`_filter_effective_citations` + **`_renumber_citations`** 仅对有效条目编号进回答 prompt；**若 KB 返回错误标注**仍有风险。 |
| 自动 fallback 导致来源不清 | **无**跨后端静默切换（见第 11 节）。 |

**额外文档风险**：**`.env.example` 中含形似真实密钥的占位串**，若被误当作真密钥复制或提交到版本库，属**运维/合规风险**（非运行时逻辑）；**本报告不打印其值**。

---

## 14. 建议运行的测试命令（Windows PowerShell）

### A. 本地模式

**建议环境变量**（会话级）：

```powershell
$env:RAG_BACKEND = "local"
$env:MODEL_BACKEND = "ollama"
$env:LOCAL_MODEL_NAME = "qwen2.5:7b"   # 或 qwen2.5:1.5b，视本机为准
$env:LOCAL_KB_PATH = "data/dev_law_chunks.json"
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
```

**命令**：

```powershell
# 1) Ollama 是否运行（若未装 ollama 则跳过）
curl.exe -s http://127.0.0.1:11434/api/tags

# 2) 模型是否存在（看返回 JSON 是否包含 local 模型名）
curl.exe -s http://127.0.0.1:11434/api/tags

# 3) 启动后端（在 Legal_AI_Zhong 目录，已激活 venv 时）
cd D:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong
uvicorn api.main:app --host 127.0.0.1 --port 8000

# 4) 非流式
curl.exe -s -X POST "http://127.0.0.1:8000/new-rag/ask" `
  -H "Content-Type: application/json" `
  -d "{\"question\":\"竞业限制协议最多约定几年？\"}"

# 5) 流式（-N 禁用缓冲，便于观察逐行）
'{"question":"竞业限制协议最多约定几年？"}' | Set-Content -Encoding utf8 body.json
curl.exe -N -X POST "http://127.0.0.1:8000/new-rag/ask-stream" `
  -H "Content-Type: application/json" `
  --data-binary "@body.json"

# 6) 前端
cd D:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\frontend
npm run dev
# 浏览器打开 http://localhost:3000/new-feature-chat（或项目根路径重定向）
```

### B. 正式模式

```powershell
$env:RAG_BACKEND = "bailian"
$env:MODEL_BACKEND = "dashscope"
# 在会话中设置密钥变量，但不要 echo 打印值
# $env:DASHSCOPE_API_KEY = "..."
# $env:ALIBABA_CLOUD_ACCESS_KEY_ID = "..."
# $env:ALIBABA_CLOUD_ACCESS_KEY_SECRET = "..."
# $env:BAILIAN_WORKSPACE_ID = "..."
# $env:BAILIAN_INDEX_ID = "..."
# $env:BAILIAN_ENDPOINT = "bailian.cn-beijing.aliyuncs.com"

cd D:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong
uvicorn api.main:app --host 127.0.0.1 --port 8000

curl.exe -s -X POST "http://127.0.0.1:8000/new-rag/ask" -H "Content-Type: application/json" -d "{\"question\":\"……\"}"
curl.exe -N -X POST "http://127.0.0.1:8000/new-rag/ask-stream" -H "Content-Type: application/json" --data-binary "@body.json"
```

### OpenAPI 拉取（可选）

```powershell
curl.exe -s "http://127.0.0.1:8000/openapi.json" -o openapi_check.json
```

**说明**：审计执行时 **未稳定完成** 对 `127.0.0.1:8000` 的 curl 探测（环境与 PowerShell 重定向差异）；**是否逐行输出**需在**本机后端已启动**时用 **`curl.exe -N`** 目视或抓包确认。

---

## 15. 预期测试结果（概要）

### 本地模式

- **`/ask`**：返回 JSON，含 **answer / model / retrieved_count / citations**；answer 为模型依 prompt 生成的四段结构文本（具体措辞随模型变）。
- **`/ask-stream`**：多行 NDJSON；在有效法条路径下应出现 **`analysis_start` → 多行 `analysis_delta` → `analysis`（analysis_done）→ `answer_generation_start` → 多行 `answer_delta` → `answer` → `done`**。
- **`analysis_delta`**：行陆续到达，**`data.delta` 为短字符串片段**。
- **`answer_delta`**：同上。
- **前端**：过程区实时依据分析；**回答预览区**累加 delta；**最终 `answer` 到达后** 仅 **`QwenKbAnswerCard`** 规范化展示（**当前若前端构建失败则无法验收 UI**，见第 16 节）。

### 正式模式

- 内容来自 **百炼 Retrieve**；模型来自 **DashScope**。
- **展示结构**与本地一致（同一前端）。
- **citations** 字段依赖百炼返回与 **`AliyunKBService` 解析映射**；与 `dev_law_chunks.json` 的字段集合可能略有差异，前端以 **`normalizeSources`** 尽力兼容。

---

## 16. 当前发现的问题与风险

| 问题 | 严重程度 | 位置 | 影响 | 建议 |
|------|----------|------|------|------|
| **`StreamingAnswerDraft.tsx` 类型别名语法错误**（`type StreamingAnswerDraftProps {` 缺少 **`=`**）导致 **ESLint / `next build` 失败** | **高** | `frontend/src/components/chat/StreamingAnswerDraft.tsx` | **前端无法生产构建**；`answer_delta` UI 无法交付 | 修正为 `type StreamingAnswerDraftProps = { ... }`（属代码修复，待你授权后执行） |
| **DashScope 流式与非流式 API 不一致**（`responses.create` vs `chat.completions` stream） | **中高** | `config/dashscope_config.py` | 正式环境某模型/账号若**不支持**兼容流式 chat，**`ask-stream` 依据/回答阶段失败** | 正式账号用 **`curl.exe -N`** 验证；必要时增加**显式**配置切非流式 ask-stream（非静默 fallback） |
| **`ask-stream` 路由 `ndjson_body` 仅捕获 `ValueError`** | **中** | `new_feature_qwen_kb/router.py` | 未预期异常可能导致**连接中断且无 NDJSON error** | 扩展 `except` 或保证 `ask_events` 内部吞掉并 yield error |
| **静默忽略 JSON 解析失败行** | **低** | `new-feature-chat/page.tsx` | 损坏/混入非 JSON 时用户无感知 | 计数失败行或 toast |
| **`.env.example` 含密钥形态示例** | **中（合规）** | `.env.example` | 易误用/误提交真实密钥 | 改为明显占位符（如 `your-key-here`） |
| **README 对 DashScope 描述侧重 `responses.create`**，未强调 **ask-stream 流式走 chat** | **低** | `README.md` | 运维理解偏差 | 补充 ask-stream 与 `create_chat_completion_stream` 说明 |
| **四段解析启发式**边界误分 | **低** | `page.tsx` `normalizeAnswer` | 个别回答排版进错栏 | 继续收真实样本调规则 |
| **`/new-rag/ask` 500 `detail` 含 `exc` 字符串** | **低** | `router.py` | 可能泄露内部异常类型信息 | 生产环境收敛 detail |

**关于「delta 是否真流式」**：代码路径上 **服务端在每次模型 delta 时 yield**；若反向代理/客户端缓冲导致「看起来一次性」，属**部署/客户端**问题，需抓包区分。

---

## 17. 总结结论

1. **是否可进入本地验收**：**后端 `compileall` 可通过**；**前端当前无法通过 `npm run lint` / `npm run build`**（见 **`StreamingAnswerDraft.tsx` 语法错误**）。修复该文件后，建议再跑一轮全链路本地验收。

2. **是否可进入正式环境验收**：**逻辑上可测**，但需 **重点验收 DashScope `chat.completions` 流式** 与所选 **`model`**、地域 endpoint 的兼容性；**无**自动兜底。

3. **阻塞项**：**前端生产构建失败**；**正式环境 DashScope 流式兼容性未在本文档中通过线上 curl 实证**（需你方在有密钥环境执行）。

4. **下一步建议优先级**：① **修复 `StreamingAnswerDraft.tsx` 类型语法** 并重新 `npm run lint && npm run build`；② **正式账号验证 `ask-stream` 全事件**；③ 视结果决定是否增加 **显式** 非流式 ask-stream 开关。

5. **是否把报告发给 ChatGPT 进一步分析**：**可以**；本报告已尽量结构化，适合作为外部模型分析的输入（**脱敏后再发送**：勿附带真实 `.env` 与 openapi 中的密钥）。

---

## 附录：必须运行的检查命令结果（审计执行记录）

| 命令 | 结果 |
|------|------|
| `cd Legal_AI_Zhong` → `python -m compileall api config services new_feature_qwen_kb law_spider` | **通过**（exit code 0） |
| `cd Legal_AI_Zhong/frontend` → `npm run lint` → `npm run build` | **失败**：`StreamingAnswerDraft.tsx` 第 7 行 **Parsing error / Unexpected token `{`** |
| `curl.exe http://127.0.0.1:8000/openapi.json` | **未可靠完成**（环境与 shell 差异）；**无法确认**本机当时是否有后端监听 |

---

**报告路径**：`Legal_AI_Zhong/docs/streaming-rag-current-audit.md`
