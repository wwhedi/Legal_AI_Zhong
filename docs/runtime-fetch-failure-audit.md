# Failed to fetch 运行时排查报告

> 排查时间：2026-05-04  
> 排查环境：Windows PowerShell；在 **`Legal_AI_Zhong`** 目录执行命令；**未修改**任何业务代码、前端、后端与 prompt。  
> 说明：本机用于执行审计的 `python` 若未安装完整 `requirements.txt`，则 **`from api.main import app`** 可能失败；**与当前已运行在 `127.0.0.1:8000` 的后端进程**（其依赖与 `.env` 已独立配置）不是同一环境。

---

## 1. 问题现象

| 项 | 说明 |
|----|------|
| 用户操作 | 在 **`/new-feature-chat`** 输入「你好」并发送 |
| 前端展示 | **`调用失败：Failed to fetch`** |
| 含义 | `fetch()` 在浏览器侧 **抛错**（`TypeError: Failed to fetch` 等），被 `catch` 后取 `error.message` 展示为上述文案 |
| 当前前端地址 | 审计环境 **无法从浏览器读取**；常见为 **`http://localhost:3000`** 或 **`http://127.0.0.1:3000`**（见第 4 节 CORS 白名单） |
| 当前后端地址 | 静态代码默认 **`http://localhost:8000`**；`NEXT_PUBLIC_API_BASE_URL` 可覆盖（见第 3 节） |
| 当前启动命令 | 以 **README.md** 为准：后端 `uvicorn api.main:app --host 127.0.0.1 --port 8000`；前端 `npm run dev`（默认端口 **3000**） |

---

## 2. 静态链路确认

### 2.1 前端 `getApiBaseUrl()` 与完整请求 URL

- **`DEFAULT_BASE_URL`**：`http://localhost:8000`（末尾无斜杠）。
- **`getApiBaseUrl()`**：读取 **`process.env.NEXT_PUBLIC_API_BASE_URL`**，去掉末尾 `/`；若未设置则用默认值。
- **注意**：仅去掉**尾部**斜杠，**未**对整串做 `trim()`；若环境变量含首尾空格，可能拼出非法 URL，导致 `fetch` 失败。

```50:54:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\frontend\src\app\new-feature-chat\page.tsx
const DEFAULT_BASE_URL = "http://localhost:8000";

function getApiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}
```

### 2.2 `fetch` 路径、方法与请求体

- **方法**：`POST`
- **URL**：`` `${getApiBaseUrl()}/new-rag/ask` ``
- **请求体**：`JSON.stringify({ question })`，字段名为 **`question`**（与后端 Pydantic 模型一致）。

```183:188:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\frontend\src\app\new-feature-chat\page.tsx
    try {
      const resp = await fetch(`${getApiBaseUrl()}/new-rag/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
```

### 2.3 `Failed to fetch` 的 catch 与展示

- **`fetch` 或 `resp.json()`** 抛出的异常进入 **`catch`**，取 **`error.message`**，拼成 **`调用失败：${msg}`**。
- **`HTTP 4xx/5xx`** 时：先 **`await fetch(...)`** 得到 `resp`，若 **`!resp.ok`** 会 **`throw new Error(text || ...)`**，此时消息多为响应体或 `HTTP xxx`，**一般不是**字面量 **`Failed to fetch`**（除非响应体恰好为该字符串）。

```214:223:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\frontend\src\app\new-feature-chat\page.tsx
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setMessages((prev) => [
        ...prev,
        {
          id: `a_err_${Date.now()}`,
          role: "assistant",
          content: `调用失败：${msg}`,
        },
      ]);
```

**结论（静态）**：

- 若用户看到的是 **`调用失败：Failed to fetch`**，在实现上更偏向：**`fetch` 在收到合法 HTTP 响应之前失败**（网络不可达、连接被拒绝、CORS 拦截、混合内容、浏览器/扩展拦截、DNS 等），而不是后端返回 500 后走 `!resp.ok` 分支（后者通常会显示 **`Internal Server Error`** 或 FastAPI 的 **`detail`** JSON 文本摘要）。

### 2.4 `frontend/next.config.ts`

- **无** `rewrites` / `proxy`；浏览器 **直连** `getApiBaseUrl()` 指向的后端。

### 2.5 后端挂载与 `/new-rag/ask` 路径

- **`api/main.py`**：`include_router(new_rag_router)`。
- **`new_feature_qwen_kb/router.py`**：`APIRouter(prefix="/new-rag")` + `@router.post("/ask")` → 完整路径 **`POST /new-rag/ask`**。

```42:58:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\api\main.py
app = FastAPI(title="Legal AI API", version="0.1.0")

# Frontend calls this API directly from the browser (Next.js on :3000),
# so CORS must be enabled for local dev and configurable deployments.
allowed_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(kb_update_router)
app.include_router(new_rag_router)
```

```42:65:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\new_feature_qwen_kb\router.py
router = APIRouter(prefix="/new-rag", tags=["new-rag"])


class NewRagAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
// ...
@router.post("/ask", response_model=NewRagAskResponse)
async def ask_new_rag(req: NewRagAskRequest) -> NewRagAskResponse:
    svc = QwenKBRagService()
    try:
        result = await svc.ask(req.question)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"new-rag call failed: {exc}") from exc
```

**重要**：**`QwenKBRagService()` 在 `try` 之外**。若在构造 **`AliyunKBService`** 等时抛错（例如环境变量为 `None` 时 **`.strip()`**），可能变成 **ASGI 层未捕获的 500**，响应体常为纯文本 **`Internal Server Error`**（见第 5 节实测），**仍不应**在浏览器里表现为 **`Failed to fetch`**（除非请求未到达服务器或 CORS 先失败）。

---

## 3. 前端 API Base URL 检查

| 检查项 | 结论 |
|--------|------|
| `getApiBaseUrl()` 逻辑 | 见 §2.1；未设置 env 时为 **`http://localhost:8000`** |
| **`NEXT_PUBLIC_API_BASE_URL`** | 在 **裸 `node -e`**（不经 Next 注入）下为 **`undefined`**；Next `dev`/`build` 会从 **`frontend/.env*`** 注入，需以 **实际 dev 进程** 为准 |
| **仓库内 `frontend/.env*`** | 本次在仓库中 **未发现** 已提交的 **`frontend/.env` / `.env.local` / `.env.development`**（可能未创建、或已被 **`.gitignore`** 忽略）；**无法**从 Git 树内读取用户本机密钥文件 |
| **最终请求 URL（默认）** | **`http://localhost:8000/new-rag/ask`** |
| **错误端口/路径风险** | 若设置了错误的 **`NEXT_PUBLIC_API_BASE_URL`**（如 `http://127.0.0.1:9000` 而后端在 **8000**），易出现 **`net::ERR_CONNECTION_REFUSED`** → 常表现为 **`Failed to fetch`** |

---

## 4. 后端启动与路由检查

### 4.1 `python -c "from api.main import app"`

| 环境 | 结果 |
|------|------|
| 审计用默认 `python`（未完整安装依赖） | 先缺 **`dotenv`**，安装后缺 **`alibabacloud_bailian20231229`** → **`ModuleNotFoundError`**，**无法**在本审计 shell 内完成导入 |
| **用户正确做法** | 在 **`Legal_AI_Zhong`** 下使用 **`requirements.txt` 安装的虚拟环境** 再执行该命令 |

### 4.2 运行时证据：本机 `127.0.0.1:8000` 已监听

- **`curl.exe http://127.0.0.1:8000/openapi.json`**：返回 **HTTP 200**（说明当时 **存在** 可响应的 uvicorn/FastAPI 进程）。

### 4.3 OpenAPI 中是否包含 `/new-rag/ask`

- 已拉取 **`openapi.json`** 并解析 **`paths`**，包含：**`['/new-rag/ask']`**。

### 4.4 路由列表（`app.routes`）

- 因 §4.1 导入失败，**未**在本机打印完整 `app.routes`。  
- 与 OpenAPI 结论一致：**`/new-rag/ask`** 已注册。

---

## 5. 直接 `curl` / `POST /new-rag/ask` 结果

### 5.1 命令（PowerShell 下避免 JSON 转义问题）

使用 **临时文件** 写入 ASCII 体 **`{"question":"hello"}`**，再：

```text
curl.exe -s -i -X POST "http://127.0.0.1:8000/new-rag/ask" -H "Content-Type: application/json" --data-binary "@%TEMP%\new_rag_ask_body.json"
```

### 5.2 实测结果（针对当时监听在 8000 的进程）

| 项 | 值 |
|----|-----|
| HTTP 状态码 | **500** |
| `Content-Type` | **`text/plain; charset=utf-8`** |
| 响应体 | **`Internal Server Error`**（**非** FastAPI 默认 JSON `{"detail":...}`） |
| 是否进入路由逻辑 | **高度可能已进入**，但在 **`QwenKBRagService()` 构造** 或 **`try` 外** 的其它路径发生 **未转换为 `HTTPException` 的异常**（与 **`router.py`** 中 **`svc = QwenKBRagService()` 位于 `try` 之外** 一致） |

### 5.3 与 `services/aliyun_kb_service.py` 的对应关系（代码层）

`AliyunKBService.__init__` 对 AK/SK 直接 **`.strip()`**；若 **`os.getenv(...)` 为 `None`**，会在 **`.strip()`** 处 **`AttributeError`**（在 **`retrieve`** 之前就会触发，因为 **`QwenKBRagService()` 会立即 `AliyunKBService()`**）。

```43:54:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\services\aliyun_kb_service.py
    def __init__(self) -> None:
        # Official Retrieve OpenAPI uses AK/SK.
        self.access_key_id = (
            os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
        ).strip()
        self.access_key_secret = (
            os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        ).strip()
        self.endpoint = (os.getenv("BAILIAN_ENDPOINT") or "bailian.cn-beijing.aliyuncs.com").strip()
        self.workspace_id = (os.getenv("BAILIAN_WORKSPACE_ID") or "").strip()
        self.index_id = (os.getenv("BAILIAN_INDEX_ID") or "").strip()
```

**说明**：用户界面若已是 **HTTP 500 且能读到纯文本**，应与 **`Failed to fetch`** 区分；**后者**仍以 **浏览器网络/CORS/地址** 为主因假设。

### 5.4 若 POST 成功时，失败可能落在 `QwenKBRagService.ask` 的哪些阶段

结合 **`new_feature_qwen_kb/service.py`**（逻辑顺序）：

1. **Query rewrite**：`ReasoningService.generate` → DashScope；异常被 **`except` 捕获** 并回退，一般不直接导致路由外 500。  
2. **`parse_query_rewrite_result`**：解析失败时同上，多被吞并回退。  
3. **`AliyunKBService.retrieve`**：`_validate()` 或百炼 SDK / 超时 / `Success=False` 抛 **`RuntimeError`** 等 → 路由内 **`HTTPException(500, detail=...)`**（通常为 **JSON**）。  
4. **`parse_law_chunk_text`**：在 `_node_to_citation` 路径中，异常可能导致 500。  
5. **`_filter_effective_citations` 为空**：返回固定文案，**不**抛错。  
6. **回答生成**：再次 **`ReasoningService.generate`**。  
7. **DashScope**：`DASHSCOPE_API_KEY` 缺失时在 **`create_chat_completion`** 抛 **`RuntimeError`**。

```140:142:d:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\config\dashscope_config.py
    api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("Environment variable `DASHSCOPE_API_KEY` is required.")
```

---

## 6. CORS 检查

### 6.1 `api/main.py` 配置

- **`allow_origins`**：**仅**  
  - **`http://localhost:3000`**  
  - **`http://127.0.0.1:3000`**  
- **`allow_credentials=True`**，**`allow_methods=["*"]`**，**`allow_headers=["*"]`**。

### 6.2 `OPTIONS` 预检实测

**Origin: `http://localhost:3000`**

- 响应含：**`access-control-allow-origin: http://localhost:3000`**  
- **`access-control-allow-methods`**：包含 **POST**  
- **`access-control-allow-headers`**：包含 **`content-type`**（小写，与常见请求一致）

**Origin: `http://127.0.0.1:3000`**

- 响应含：**`access-control-allow-origin: http://127.0.0.1:3000`**

**Origin: `http://localhost:3001`（不在白名单）**

- 返回 **`400 Bad Request`**，正文 **`Disallowed CORS origin`**  
- 浏览器中典型表现：**预检失败** → **`fetch` reject** → **`Failed to fetch`**

### 6.3 风险小结

| 前端 Origin | 是否匹配当前 CORS |
|-------------|-------------------|
| `http://localhost:3000` | 是 |
| `http://127.0.0.1:3000` | 是 |
| `http://localhost:3001` / 其它端口 | **否** → **高风险 `Failed to fetch`** |
| `http://[::1]:3000`（IPv6 本机） | **未配置** → **高风险** |
| **`https://localhost:3000`**（若误用 HTTPS 前端） | **未配置**；且混合内容还需单独评估 | 

---

## 7. 环境变量检查（不泄露密钥）

在 **`Legal_AI_Zhong`** 下执行（**`load_dotenv()`**，反映 **项目根 `.env`** 是否被当前 shell 进程加载；**与 uvicorn 子进程环境可能一致也可能不一致**）：

```bash
python -c "import os; from dotenv import load_dotenv; load_dotenv(); keys=['DASHSCOPE_API_KEY','DASHSCOPE_BASE_URL','REASONING_MODEL_NAME','NEW_QWEN_MODEL_NAME','ALIBABA_CLOUD_ACCESS_KEY_ID','ALIBABA_CLOUD_ACCESS_KEY_SECRET','BAILIAN_WORKSPACE_ID','BAILIAN_INDEX_ID','BAILIAN_ENDPOINT']; [print(k, 'SET' if os.getenv(k) else 'MISSING') for k in keys]"
```

**本次审计 shell 输出摘要**：上述变量 **均为 `MISSING`**（仓库根 **无有效 `.env` 被本进程加载**，或文件不存在）。

| 变量 | 是否存在（审计 shell） | 用途 | 缺失或异常时的典型影响 |
|------|------------------------|------|-------------------------|
| `DASHSCOPE_API_KEY` | MISSING | DashScope OpenAI 兼容调用 | **`RuntimeError`**（在 `create_chat_completion`） |
| `DASHSCOPE_BASE_URL` | MISSING | 兼容模式 Base URL | 使用代码内 **默认** `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `REASONING_MODEL_NAME` | MISSING | 默认推理模型名 | 使用 **`ModelRegistry`** 默认值（如 **`qwen-max`**） |
| `NEW_QWEN_MODEL_NAME` | MISSING | RAG 优先模型 | 回退到 **`REASONING_MODEL_NAME`** / 默认 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | MISSING | 百炼 AK | **`None.strip()` → AttributeError`**（构造 `AliyunKBService` 时） |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | MISSING | 百炼 SK | 同上 |
| `BAILIAN_WORKSPACE_ID` | MISSING | 业务空间 | 同上或 `_validate` **`RuntimeError`** |
| `BAILIAN_INDEX_ID` | MISSING | 知识库索引 | 同上 |
| `BAILIAN_ENDPOINT` | MISSING | OpenAPI Endpoint | 使用默认 **`bailian.cn-beijing.aliyuncs.com`** |

**与 `.env.example` 的差异提示**：示例文件中出现 **`BAILIAN_BASE_URL`**，而代码读取的是 **`BAILIAN_ENDPOINT`**（见上表）。若只配置了前者，**可能导致 endpoint 仍走默认**，一般**不致于**单独导致 AK 为 `None` 的问题，但容易在运维上产生误解。

---

## 8. 后端内部异常风险点（结合代码）

1. **`QwenKBRagService()` 构造**：**`AliyunKBService.__init__`** 对可能为 **`None`** 的 **`getenv` 结果** 调用 **`.strip()`** → **`AttributeError`**（**不在** `ask_new_rag` 的 `try` 内）→ **纯文本 500**。  
2. **Query rewrite**：`ReasoningService.generate` / DashScope 调用失败 → 多被 **`service.ask` 捕获** 并回退。  
3. **`parse_query_rewrite_result`**：解析失败 → 回退。  
4. **`AliyunKBService.retrieve`**：`_validate()`、SDK、超时、`Success=False` → **`RuntimeError`** 等 → 路由内 **`HTTPException(500)`**（多为 JSON）。  
5. **`parse_law_chunk_text`**：元数据/正文解析异常 → 可能 500。  
6. **`_filter_effective_citations` 为空**：返回固定回答，**不**抛错。  
7. **回答生成**：DashScope **`responses.create`** / `_extract_openai_text` → **`RuntimeError`**。  
8. **响应序列化**：`NewRagAskResponse` 与返回字典不匹配时理论上可能 500（当前路径以 str/int/list 为主，风险相对较低）。

---

## 9. 初步结论

**针对用户可见文案「`调用失败：Failed to fetch`」**（与 **`fetch` reject** 一致）：

- **最可能（浏览器层 / 跨域 / 地址）**  
  - **后端未监听**或 **`NEXT_PUBLIC_API_BASE_URL` 指向错误主机/端口** → **`ERR_CONNECTION_REFUSED` / `ERR_FAILED`** → **`Failed to fetch`**。  
  - **前端 Origin 不在 CORS 白名单**（如 **`localhost:3001`**、**`[::1]:3000`**、**非 http**）→ 预检失败 → **`Failed to fetch`**。  
  - **混合内容**（HTTPS 页请求 HTTP API）或 **企业代理 / 扩展拦截**。  

**次要（若 Network 面板实际有 HTTP 响应）**  

- 若实际是 **500** 且响应体为 **`Internal Server Error`**，则用户文案更可能接近 **`调用失败：Internal Server Error`**；此时应重点查 **§5 / §8**（尤其 **`AliyunKBService` 构造与 AK/SK`**）。

**本次在同一台机器上对 `127.0.0.1:8000` 的实测**  

- **`openapi.json` 可访问**；**`/new-rag/ask` 在 OpenAPI 中存在**。  
- **`POST /new-rag/ask` 返回 500 纯文本**（与 **`Failed to fetch`** 不是同一类前端表现，但说明 **接口路径存在且进程内仍有配置/代码路径异常**）。  

**CORS 风险**  

- **仅**放行 **`localhost:3000`** 与 **`127.0.0.1:3000`**；其它端口或未列 Origin **会**导致 **`Failed to fetch`**。  

**环境变量**  

- 审计 shell 下 **全部关键变量 MISSING**；与 **500 纯文本** 现象 **相容**（尤其 **`None.strip()`** 场景）。用户需在 **实际运行 uvicorn 的环境** 中再次用 **`SET`/`MISSING`** 自检（勿打印密钥值）。

---

## 10. 建议修复顺序（仅建议，未改代码）

1. **先确认后端**：浏览器或 `curl` 打开 **`http://127.0.0.1:8000/docs`** 或 **`/openapi.json`** 是否 **200**。  
2. **`curl` 直连 `POST /new-rag/ask`**：确认是 **连接失败** 还是 **500/422**；**500 纯文本** 时看 **uvicorn 控制台 traceback**（重点 **`AliyunKBService` / `QwenKBRagService()`**）。  
3. **核对前端请求 URL**：DevTools **Network** 里完整 URL 是否为 **`{预期主机}:{端口}/new-rag/ask`**；核对 **`NEXT_PUBLIC_API_BASE_URL`**（需在 **`frontend/.env.local`** 等配置并由 **`npm run dev` 重启** 生效）。  
4. **核对 CORS**：页面地址栏 Origin 是否为 **`http://localhost:3000`** 或 **`http://127.0.0.1:3000`**；否则需调整部署或 Origin 白名单（本报告不改代码）。  
5. **最后配置模型与百炼**：**`DASHSCOPE_API_KEY`**、百炼 **AK/SK**、**`BAILIAN_WORKSPACE_ID`**、**`BAILIAN_INDEX_ID`**；并修正 **`.env.example` 与代码变量名** 的认知偏差（**`BAILIAN_ENDPOINT`**）。

---

## 11. 需用户在浏览器中补充的信息（若仍无法定论）

1. **Console** 完整报错（含 **`TypeError`** / **`CORS`** / **`ERR_*`**）。  
2. **Network** 中 **`/new-rag/ask`** 的 **完整 Request URL**。  
3. 该请求状态：**pending / failed / (blocked:cors) / 4xx / 5xx** 等。  
4. **Request Headers**：**`Origin`**、**`Referer`**。  
5. **Response** 或 **Preview** 正文。  
6. 实际打开前端的 URL（含 **端口、协议、主机名**）。

---

## 12. 命令执行附录

| 命令 | 结果摘要 |
|------|----------|
| `python -c "from api.main import app"`（审计默认环境） | **失败**：缺 **`alibabacloud_bailian20231229`**（应先 **`pip install -r requirements.txt`** 于 venv） |
| `curl.exe` → **`/openapi.json`** | **HTTP 200** |
| 解析 **`paths` 含 `new-rag`** | **`['/new-rag/ask']`** |
| **`POST /new-rag/ask`**（JSON **`question`**) | **HTTP 500**，**`text/plain`**，**`Internal Server Error`** |
| **`OPTIONS`** + **`Origin: http://localhost:3000`** | **200**，含 **`access-control-allow-origin`** 等 |
| **`OPTIONS`** + **`Origin: http://localhost:3001`** | **400**，**`Disallowed CORS origin`** |
| `node -e "console.log(process.env.NEXT_PUBLIC_API_BASE_URL)"`（裸 Node） | **`undefined`**（不代表 Next 注入后仍为 undefined） |
| **`frontend`**：`npm run lint` / **`npm run build`** | **均成功**（本次执行） |

---

## 13. 对话结论摘要（供 Cursor 汇总）

| 项 | 值 |
|----|-----|
| **文档路径** | **`D:\2201630106wyyz\work\legal_ai\Legal_AI_Zhong\docs\runtime-fetch-failure-audit.md`** |
| **当前最可能原因（针对「Failed to fetch」文案）** | **浏览器侧 `fetch` 未拿到响应**：**连接目标错误/后端未监听** 或 **CORS 不允许当前 Origin（含错误端口、IPv6、https 等）**；需用 **Network + Console** 确认 |
| **`curl` 能否访问 `POST /new-rag/ask`** | **能连上**，但当时返回 **HTTP 500**（**非**连接失败） |
| **OpenAPI 是否包含 `/new-rag/ask`** | **是** |
| **CORS 风险** | **存在**：仅 **`localhost:3000`** 与 **`127.0.0.1:3000`**；其它 Origin 易导致 **`Failed to fetch`** |
| **环境变量缺失风险** | **存在**：审计 **`load_dotenv()`** 下全 **MISSING**；且与 **`AliyunKBService` `None.strip()`** 及 **500 纯文本** **相容**（用户 uvicorn 环境需自行再验） |
