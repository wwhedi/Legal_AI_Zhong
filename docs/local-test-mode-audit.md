# 本地测试模式代码确认文档

> 扫描日期：2026-05-04  
> 范围：`Legal_AI_Zhong` 当前代码与配置说明；**未修改**任何代码、**.env** 或 prompt。  
> 安全说明：下文**不**包含任何真实 API Key / AK / SK；仅列变量名与行为。

---

## 1. 当前测试模式目标

本地测试模式用于在**暂不接入正式阿里云百炼 Retrieve 与 DashScope** 时，仍验证端到端能力：

| 环节 | 说明 |
|------|------|
| 前端输入 | 用户在 **`/new-feature-chat`** 输入问题并发送 |
| **`POST /new-rag/ask`** | 浏览器直连后端，请求体 **`{ "question": string }`** |
| Query rewrite | **`QwenKBRagService.ask`** 先调用 **`ReasoningService.generate`**，使用 **`LEGAL_QUERY_REWRITE_*`** 提示词，期望模型输出 JSON（含 **`search_query`** 等）；解析失败时**回退用原始问题**作为检索语句（见 **`new_feature_qwen_kb/service.py`**，此为**改写失败回退**，不是 RAG 后端切换） |
| 知识库检索 | 由 **`RAG_BACKEND`** 选择 **`LocalKBService.retrieve`**（local）或 **`AliyunKBService.retrieve`**（bailian） |
| 回答生成 | 再次 **`ReasoningService.generate`**，使用 **`LEGAL_RAG_ANSWER_*`**；模型路由由 **`MODEL_BACKEND`** 选择 **Ollama** 或 **DashScope** |
| **`[n]` 引用编号** | Prompt 要求正文使用 **`[1]`、`[2]`** 等；**`service.py`** 对 citations 做 **`_filter_effective_citations`**（仅 **`effective_status == "有效"`**）后 **`_renumber_citations`** 统一为 **`[1]`…** |
| 前端悬浮引用卡片 | **`QwenKbAnswerCard`** 用正则 **`(\[\d+\])`** 拆分正文，将 **`[n]`** 渲染为可 hover/click 的按钮并弹出 **`CitationPopover`** |

---

## 2. 环境变量开关确认

以下依据 **`new_feature_qwen_kb/service.py`**、**`services/local_kb_service.py`**、**`services/aliyun_kb_service.py`**、**`config/dashscope_config.py`**、**`.env.example`**、**`README.md`** 扫描汇总。

| 变量 | 作用 | 默认值（代码内） | 当前代码是否读取 | 备注 |
|------|------|------------------|------------------|------|
| **`RAG_BACKEND`** | 选择知识库实现：`bailian` / `local` | 未设置或空时按 **`bailian`** | **是**（**`_kb_service_from_env`**） | 非法值抛 **`RuntimeError`**；**无**百炼失败后自动切 local |
| **`LOCAL_KB_PATH`** | 本地 JSON 路径（相对项目根或绝对路径） | **`data/dev_law_chunks.json`** | **是**（**`LocalKBService`** 内 **`_resolve_kb_path`**） | 文件不存在则 **`RuntimeError`** |
| **`MODEL_BACKEND`** | 选择推理后端：`dashscope` / `ollama` | 未设置或空时按 **`dashscope`** | **是**（**`normalize_model_backend`**、**`create_chat_completion`**） | 非法值抛 **`RuntimeError`**；**无** DashScope 失败后自动切 Ollama |
| **`OLLAMA_BASE_URL`** | Ollama OpenAI 兼容 Base | **`http://127.0.0.1:11434/v1`** | **是**（**`MODEL_BACKEND=ollama`** 时） | 需指向带 **`/v1`** 的兼容前缀（与 **`OpenAI` SDK** 拼接） |
| **`OLLAMA_API_KEY`** | Ollama 侧 API Key 占位 | **`ollama`** | **是** | 多数本地 Ollama 不校验，代码允许默认字符串 |
| **`LOCAL_MODEL_NAME`** | Ollama 实际请求的模型名 | **`qwen2.5:7b`** | **是** | **`create_chat_completion` 在 ollama 分支内固定使用该名**（**忽略**调用方传入的 **`model`** 参数） |
| **`DASHSCOPE_API_KEY`** | DashScope 鉴权 | 无（空则报错） | **是**（**`MODEL_BACKEND=dashscope`** 时必填） | 缺失时 **`RuntimeError`** |
| **`DASHSCOPE_BASE_URL`** | DashScope 兼容模式 Base | **`https://dashscope.aliyuncs.com/compatible-mode/v1`** | **是** | 可覆盖 |
| **`REASONING_MODEL_NAME`** | DashScope 下默认推理模型名候选 | **`ModelRegistry`** 默认 **`qwen-max`**；**`get_configured_chat_model`** 链式中作为候选 | **是** | 与 **`NEW_QWEN_MODEL_NAME`** 组合决定 DashScope 实际模型 |
| **`NEW_QWEN_MODEL_NAME`** | RAG 优先模型名（DashScope） | 空则回退 **`REASONING_MODEL_NAME`** 再回退 **`qwen-plus`** | **是**（**`get_configured_chat_model`**） | |
| **`ALIBABA_CLOUD_ACCESS_KEY_ID`** | 百炼 AK | 无 | **是**（仅 **`AliyunKBService`** / **`RAG_BACKEND=bailian`**） | **`RAG_BACKEND=local`** 时不走百炼客户端 |
| **`ALIBABA_CLOUD_ACCESS_KEY_SECRET`** | 百炼 SK | 无 | **是**（同上） | 同上 |
| **`BAILIAN_WORKSPACE_ID`** | 百炼工作空间 | 无 | **是**（同上） | 同上 |
| **`BAILIAN_INDEX_ID`** | 知识库索引 ID | 无 | **是**（同上） | 同上 |
| **`BAILIAN_ENDPOINT`** | OpenAPI Endpoint | **`bailian.cn-beijing.aliyuncs.com`** | **是** | **`.env.example` 注明代码读 `BAILIAN_ENDPOINT` 而非 `BAILIAN_BASE_URL`** |
| **`BAILIAN_TIMEOUT_SECONDS`** | 检索超时（秒） | **25** | **是**（**`AliyunKBService`**） | |
| **`BAILIAN_RERANK_TOP_N`** | 百炼侧召回 Top N 配置名被本地复用 | **6** | **是**（**`LocalKBService`** 中 **`_TOP_MATCHED`**） | 本地命中时最多取 **`max(1, _TOP_MATCHED)`** 条 |

---

## 3. `RAG_BACKEND` 逻辑确认

实现位置：**`new_feature_qwen_kb/service.py`** 中 **`_kb_service_from_env()`**。

1. **`RAG_BACKEND=local`**（大小写不敏感，经 **`strip().lower()`**）：返回 **`LocalKBService()`**。
2. **`RAG_BACKEND=bailian`** 或未设置/空字符串：返回 **`AliyunKBService()`**（代码注释写明默认 **`bailian`**）。
3. **为空**：等价 **`bailian`**。
4. **非法值**：抛出 **`RuntimeError`**，文案含 **`Invalid RAG_BACKEND`**。
5. **百炼失败后自动 fallback 到 local**：**不存在**。**`LocalKBService`** 类文档写明「不做百炼失败后的自动回退」。
6. **与 `AliyunKBService.retrieve` 对齐**：**`LocalKBService.retrieve`** 异步返回 **`dict`**，键包含 **`context`**、**`citations`**、**`ref_lines`**、**`nodes`**，与 **`service.py`** 中 **`kb_payload.get("context")` / `get("citations")`** 用法一致（**`AliyunKBService.retrieve`** 同样返回这四项）。

---

## 4. `LocalKBService` 实现确认

实现文件：**`services/local_kb_service.py`**；数据文件：**`data/dev_law_chunks.json`**。

1. **`data/dev_law_chunks.json`**：**存在**（仓库内路径 **`Legal_AI_Zhong/data/dev_law_chunks.json`**）。
2. **条数**：根为 **JSON 数组**，当前 **4** 条对象；其中 **3** 条 **`effective_status` 为 `"有效"`**，**1** 条为 **`"已废止"`**（用于验证过滤）。
3. **字段（有效样本）**：三条「有效」记录均包含 **`ref_id`、`law_name`、`law_type`、`effective_status`、`publish_date`、`effective_date`、`chapter`、`article`、`text`、`source_url`、`score`**。
4. **`retrieve(query)` 返回**：**`context`**、**`citations`**、**`ref_lines`**、**`nodes`**（与百炼路径一致）；**`query` 为空**时返回四键均为空（或空列表）。
5. **是否只返回 `effective_status == "有效"`**：**`_effective_chunks`** 在 **`_select_records`** 中**仅保留**有效记录；已废止条目**不会进入**排序与召回。
6. **query 未命中时的测试逻辑**：若分词后**无任何关键词命中**，**`_select_records`** 走 **`_FALLBACK_COUNT`（默认 3）**，按 **`score`** 等排序取前 **3** 条**有效**记录，保证仍有片段可测引用与上下文（见代码注释与 **`dev-civil-003`** 示例说明）。

---

## 5. `MODEL_BACKEND` 逻辑确认

实现位置：**`config/dashscope_config.py`**（**`normalize_model_backend`**、**`get_configured_chat_model`**、**`create_chat_completion`**）。

1. **`MODEL_BACKEND=ollama`**：**`base_url`** = **`OLLAMA_BASE_URL`**（默认 **`http://127.0.0.1:11434/v1`**，去尾 `/`）；**`api_key`** = **`OLLAMA_API_KEY`**（默认 **`ollama`**）；**`model`** = **`LOCAL_MODEL_NAME`**（默认 **`qwen2.5:7b`**）。HTTP 路径为 **`OpenAI` SDK 的 `chat.completions.create`**（**`_call_openai_chat_completion`**）。
2. **`MODEL_BACKEND=dashscope`**：**`base_url`** = **`DASHSCOPE_BASE_URL`** 或默认 DashScope 兼容地址；**`api_key`** = **`DASHSCOPE_API_KEY`**（必填）；**`model`** = 调用方传入的 **`model`**（须非空），通常来自 **`get_configured_chat_model()`** 链。使用 **`responses.create`**（**`_call_openai_compatible_completion`**）。
3. **为空**：按 **`dashscope`**。
4. **非法值**：**`RuntimeError`**，**`Invalid MODEL_BACKEND`**。
5. **DashScope 失败后自动 fallback Ollama**：**不存在**；文档字符串写明「无 DashScope 失败后的自动 fallback」。
6. **Ollama 兼容性**：**`ollama`** 分支使用 **`/v1` + `chat.completions`**，与常见 **Ollama OpenAI-compatible** 用法一致；**与 DashScope 的 `responses.create` 路径分离**。

---

## 6. Prompt 链路确认

文件：**`config/legal_prompts.py`**。

| 项 | 结论 |
|----|------|
| Query rewrite 提示词 | **有**：**`LEGAL_QUERY_REWRITE_SYSTEM_PROMPT`**、**`LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE`** |
| RAG 回答提示词 | **有**：**`LEGAL_RAG_ANSWER_SYSTEM_PROMPT`**、**`LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE`** |
| Query rewrite 是否先调模型 | **是**：**`QwenKBRagService.ask`** 中先 **`reasoning.generate`** 再 **`parse_query_rewrite_result`** |
| 回答侧约束（摘录） | 系统提示要求：**仅基于知识库**、**不得使用外部法律信息**、**只引用时效性有效**、**正文必须使用 `[n]`**、**保持 `1) 结论` `2) 依据` `3) 建议`**；用户模板再次强调 **`[1]`、`[2]`** 与清单一致 |

说明：**`LEGAL_QUERY_REWRITE_SYSTEM_PROMPT`** 文案仍写「检索阿里云百炼法律知识库」；在 **`RAG_BACKEND=local`** 时实际检索为本地 JSON，语义上仍为「检索前改写」，不影响代码分支，仅文档语气与真实后端可能不完全一致。

---

## 7. `/new-rag/ask` 接口确认

文件：**`new_feature_qwen_kb/router.py`**。

1. **请求体**：**`NewRagAskRequest`**，字段 **`question: str`**（**`min_length=1`**）。
2. **响应体**：**`NewRagAskResponse`** — **`question`、`answer`、`model`、`retrieved_count`、`citations`**。
3. **citations 与前端悬浮**：列表元素为 **`dict`**，经前端 **`normalizeSources`** 映射为 **`QwenKbSource`**（**`lawName`、`lawType`、`effectiveStatus`** 等）；与 **`QwenKbAnswerCard`** 所需字段一致。
4. **本地模式是否需阿里云 AK/SK**：**检索链路不需要**（**`LocalKBService`** 只读 JSON）。**仍需**可用的 **`MODEL_BACKEND`**（例如 **Ollama** 或仍配好的 **DashScope**）以完成 **query rewrite** 与 **回答生成**。

---

## 8. 前端引用展示确认

| 项 | 结论 |
|----|------|
| **`new-feature-chat` 是否仍调 `/new-rag/ask`** | **是**：**`POST`** `` `${getApiBaseUrl()}/new-rag/ask` ``，body **`{ question }`** |
| **`QwenKbAnswerCard` 是否识别 `[1]`、`[2]`** | **是**：**`CITATION_SPLIT_RE = /(\[\d+\])/g`**，**`renderTextWithCitations`** 拆分 |
| **hover / click** | **是**：**`InlineCitationMark`** 使用 **`onMouseEnter`/`Leave`** 与 **button `onClick`** 切换 **`CitationPopover`** |
| **卡片字段** | **Popover** 展示：法规名称、类型、时效性、公布日期、生效日期、章节/条文、正文滚动区、来源链接 |
| **`source_url` 存在** | **`<a target="_blank" rel="noreferrer">查看原文`** |
| **`source_url` 缺失** | 文案 **「链接：未提供」**（Popover）；列表区链接为 **「未提供」** |

类型：**`frontend/src/types/index.ts`** 中 **`QwenKbSource`** 注释写明与 **`/new-rag/ask` citations** 对齐。

---

## 9. 建议测试命令（Windows PowerShell）

以下假设：**`Legal_AI_Zhong`** 为当前目录，已 **`pip install -r requirements.txt`**，**Ollama** 已安装；**不在此粘贴任何密钥**。

```powershell
# 1) 检查 Ollama 是否监听（默认 11434）
curl.exe -s -o NUL -w "HTTP:%{http_code}" http://127.0.0.1:11434/api/tags

# 2) 列出本地模型（需 Ollama 已启动）
ollama list

# 3) 启动后端前：在 Legal_AI_Zhong 配置环境（用户自行设置，勿提交密钥）
#    RAG_BACKEND=local
#    MODEL_BACKEND=ollama
#    LOCAL_KB_PATH=data/dev_law_chunks.json
#    OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
#    LOCAL_MODEL_NAME=<与 ollama list 中一致的模型名>
Set-Location "D:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong"
.\.venv\Scripts\Activate.ps1   # 若使用 venv
uvicorn api.main:app --host 127.0.0.1 --port 8000

# 4) 另开终端：检查 openapi
curl.exe -s http://127.0.0.1:8000/openapi.json -o $env:TEMP\openapi.json
python -c "import json; d=json.load(open(r'%TEMP%\openapi.json',encoding='utf-8')); print([p for p in d.get('paths',{}) if 'new-rag' in p])"

# 5) curl 测试 /new-rag/ask（将 JSON 写入临时文件避免转义问题）
$tmp = Join-Path $env:TEMP "ask.json"
[System.IO.File]::WriteAllText($tmp, '{"question":"劳动合同订立有什么要求？"}')
curl.exe -s -i -X POST "http://127.0.0.1:8000/new-rag/ask" -H "Content-Type: application/json" --data-binary "@$tmp"

# 6) 启动前端
Set-Location "D:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\frontend"
npm run dev

# 7) 浏览器（与 CORS 白名单一致）
#    http://localhost:3000/new-feature-chat
#    或 http://127.0.0.1:3000/new-feature-chat
```

---

## 10. 预期结果

1. **`curl` 成功（HTTP 200）**：JSON 含 **`question`、`answer`、`model`、`retrieved_count`、`citations`**。
2. **`answer`**：宜出现 **带 `[1]`、`[2]`** 的段落，且结构接近 **`1) 结论` `2) 依据` `3) 建议`**（具体措辞依赖 Ollama 遵从度）。
3. **`citations`**：多条 **`dict`**，含 **`ref_id`（如 `[1]`）**、**`law_name`、`text`** 等；均为**有效**法条经 **`_renumber_citations`** 后的编号。
4. **前端页面**：助手气泡内 **`QwenKbAnswerCard`**；结论区可见可点击的 **`[n]`**。
5. **悬浮或点击 `[1]`**：弹出卡片，展示法规名称、类型、时效性、日期、章节/条文、正文摘要、链接或「未提供」。

---

## 11. 当前是否可以进入验收测试

### 与用户目标的逐项对照

| # | 目标 | 结论 |
|---|------|------|
| 1 | **`RAG_BACKEND=local`** 使用本地 JSON | **已支持** |
| 2 | **`RAG_BACKEND=bailian`** 使用百炼 | **已支持** |
| 3 | **`MODEL_BACKEND=ollama`** 使用本地 Ollama 兼容 API | **已支持** |
| 4 | **`MODEL_BACKEND=dashscope`** 使用 DashScope | **已支持** |
| 5 | 本地模式为**显式配置**，非自动降级 | **已满足**（**`RAG_BACKEND`/`MODEL_BACKEND`** 显式选择；**无**失败自动切换） |
| 6 | **`/new-rag/ask`** 请求/响应结构不变 | **已满足**（路由与 Pydantic 模型未因 local/ollama 分支改变） |
| 7 | 前端 **`[1]`** 悬浮卡片仍可用 | **已满足**（**`QwenKbAnswerCard`** + **`QwenKbSource`**） |

### 总结论

- **可以**在配置 **`RAG_BACKEND=local`** + **`MODEL_BACKEND=ollama`**（并保证 **`ollama serve`**、**`LOCAL_MODEL_NAME`** 与 **`data/dev_law_chunks.json`**）的前提下进入**本地验收测试**。
- **若不能**：常见缺口为 — **Ollama 未启动或模型未拉取**、**`LOCAL_KB_PATH` 指向文件不存在**、**前端 CORS/端口不在白名单**、**未重启 uvicorn 使环境变量生效**。
- **推荐试问题**：含关键词 **「劳动合同」**（命中 dev 样例）、或泛问以触发 **无命中时的 score 回退**；观察 **`retrieved_count`** 与 **`citations`** 是否与 **`[n]`** 一致。
- **重点观察**：Ollama 对 **JSON query rewrite** 的稳定性；回答是否含 **`[1]`** 且与 **citations 条数**一致；**已废止**样例是否**永不**进入 citations。

---

## 12. 简短结论（对话汇总）

- **代码已支持** 用户列出的 **1–7** 项本地/正式显式双后端与 **`/new-rag/ask`** + 前端引用卡片链路。  
- **注意**：**`LEGAL_QUERY_REWRITE_*`** 文案仍写「百炼」；**`RAG_BACKEND=local`** 时行为正确但提示语文档未区分。  
- **`.env.example` / `README.md`** 已包含 **`RAG_BACKEND` / `MODEL_BACKEND`** 说明；请勿在版本库中存放真实密钥（若已误提交应轮换密钥，本审计未改文件）。
