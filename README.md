# Legal_AI

本仓库包含：
- `api/`：FastAPI 后端（合同审查 `review`、法律问答 `qa`）
- `frontend/`：Next.js 前端

## 模型调用：直接模型 vs 调用智能体应用

后端统一通过 `config/dashscope_config.py:create_chat_completion` 调用大模型，支持三种模式：
- 直接模型（DashScope Generation）：`farui-*`
- 兼容模式（OpenAI SDK + DashScope compatible-mode）：`qwen*` 等
- **调用智能体应用（百炼 Agent 应用）**：将模型名写为 `app:APP_ID`

如果你要把推理链路改为“调用智能体应用”，只需要在 `.env` 里设置：
- `DASHSCOPE_API_KEY=sk-...`
- `REASONING_MODEL_NAME=app:你的APP_ID`

## 本地启动（Windows / PowerShell）

### 1) 后端

先确保已安装 **Python 3.11+**，并且 `python` 命令在 PATH 中可用（运行 `python --version` 能看到版本号）。

在 `Legal_AI/` 目录下：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt

uvicorn api.main:app --host 127.0.0.1 --port 8000
```

后端启动后：
- `GET http://127.0.0.1:8000/docs`：Swagger UI
- `GET http://127.0.0.1:8000/qa/ping`：模型/依赖连通性自检（需要对应的 `.env` 配置）

> 说明：前端会从浏览器直接请求后端，所以 `api/main.py` 已启用 CORS（默认允许 `http://localhost:3000`）。

### 2) 前端

在 `Legal_AI/frontend/` 目录下：

```powershell
npm install
npm run dev
```

可选：通过环境变量指定后端地址（默认 `http://localhost:8000`）：

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8000"
npm run dev
```

打开 `http://localhost:3000`。

