# Legal_AI

仓库主体在 **`Legal_AI_Zhong/`**（下文路径均相对于该目录）。

## 能力概览

### a. 法规爬取与知识库更新（`/kb-update`）

- **后端**：`api/kb_update_api.py`，前缀 **`/kb-update`**。
- **执行**：按任务步骤异步拉起 **`law_spider/*.py`** 爬虫子进程，日志写入任务对象。
- **持久化**：Python **`sqlite3`**，数据库文件 **`data/kb_update.db`**。
- **前端**：Next.js 路由 **`/kb-update`**（首页、新建向导、历史、单任务运行与结果页）。

### b. 百炼知识库 Retrieve

- **实现**：`services/aliyun_kb_service.py`（阿里云百炼 OpenAPI）。
- **环境变量**：**`BAILIAN_WORKSPACE_ID`**、**`BAILIAN_INDEX_ID`**、**`ALIBABA_CLOUD_ACCESS_KEY_ID`**、**`ALIBABA_CLOUD_ACCESS_KEY_SECRET`** 等（详见 `.env.example`）。

### c. 千问（Qwen）模型调用

- **实现**：`services/reasoning_service.py` → **`config/dashscope_config.py`** 中 **`create_chat_completion`**。
- **正式环境（DashScope）**：**`MODEL_BACKEND=dashscope`**（或未设置时的默认）。使用 **`DASHSCOPE_API_KEY`**（必填）、**`DASHSCOPE_BASE_URL`**（可选，OpenAI 兼容 base）、**`NEW_QWEN_MODEL_NAME`** / **`REASONING_MODEL_NAME`**、**`REASONING_TEMPERATURE`**；请求走 DashScope 兼容 **`responses.create`**。
- **本地开发（Ollama）**：**`MODEL_BACKEND=ollama`** 时走 **`OLLAMA_BASE_URL`**（默认 `http://127.0.0.1:11434/v1`）、**`OLLAMA_API_KEY`**（默认 `ollama`）、**`LOCAL_MODEL_NAME`**（默认 `qwen2.5:7b`）；请求走 **`chat.completions`**。不会在 DashScope 失败后自动 fallback。
- **完全本地联调 `/new-rag/ask`（不依赖 DashScope 与百炼）** 示例：

```text
RAG_BACKEND=local
MODEL_BACKEND=ollama
LOCAL_KB_PATH=data/dev_law_chunks.json
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_MODEL_NAME=qwen2.5:7b
```

需本机已 **`ollama serve`** 且已拉取对应模型；并保证 **`data/dev_law_chunks.json`** 存在。

### d. 问答接口（`/new-rag/ask`）

- **后端**：`new_feature_qwen_kb/router.py` → **`POST /new-rag/ask`** → `new_feature_qwen_kb/service.py`（先 Retrieve，再 **`ReasoningService.generate`**）。
- **前端**：页面 **`/new-feature-chat`** 内直接请求 **`POST /new-rag/ask`**（不经 `services/api.ts` 封装）。

### e. 前端页面

- **`/new-feature-chat`**：知识库问答 UI。
- **`/kb-update`**：法规爬取 / 任务编排控制台。
- 根路径 **`/`** 重定向至 **`/new-feature-chat`**。

## 本地启动（Windows / PowerShell）

### 后端

需 **Python 3.11+**。在 **`Legal_AI_Zhong`** 下：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
uvicorn api.main:app --host 127.0.0.1 --port 8000
```

打开 **`http://127.0.0.1:8000/docs`** 可调试 **`POST /new-rag/ask`** 与 **`/kb-update`** 等接口。

### 前端

在 **`Legal_AI_Zhong/frontend`** 下：

```powershell
npm install
npm run dev
```

可选指定后端：

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8000"
npm run dev
```

浏览器访问 **`http://localhost:3000`**。

> `api/main.py` 已对 **`http://localhost:3000`** / **`http://127.0.0.1:3000`** 启用 CORS。
