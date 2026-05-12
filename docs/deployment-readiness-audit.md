# Legal_AI 部署就绪审计报告

**审计日期：** 2026-05-12  
**范围：** 将仓库上传 GitLab，并在 Linux 服务器上对外提供 Web 访问（本报告**不修改任何业务代码**，仅陈述现状与建议）。

---

## 执行摘要

当前仓库已具备 **FastAPI + Next.js** 的本地/单机运行能力（`README.md`、依赖与脚本），但 **缺少容器编排、反向代理示例与 CI 流水线文件**。生产部署需在 **环境变量、CORS、持久化卷、爬虫依赖（浏览器）与 `pywin32` 平台差异** 等方面做运维层面的补齐。下文按检查项逐条给出证据与建议。

---

## 1. Dockerfile

| 结论 | **未发现** 项目内任何 `Dockerfile` 或 `Dockerfile.*`（已对 `Legal_AI` 目录递归检索）。 |
|------|---------------------------------------------------------------------------------------------|

**影响：** 需自行编写多阶段镜像（Python 后端 + Node 构建前端，或前后端分镜像），或采用裸机 `systemd` + `venv`/`npm` 部署。

---

## 2. docker-compose.yml

| 结论 | **未发现** `docker-compose.yml` / `docker-compose.*.yml`。 |
|------|-----------------------------------------------------------|

**影响：** 本地/服务器上一键拉起 API、前端、（可选）反向代理与数据卷需新建 compose 文件或等价编排。

---

## 3. Nginx 配置

| 结论 | **未发现** 仓库内 `nginx*.conf` 或 `deploy/nginx` 等示例配置。 |
|------|----------------------------------------------------------------|

**影响：** 对外 HTTPS、WebSocket/流式响应（若经网关）、静态与 `next start` 反代、上传体大小限制等，需在服务器侧单独维护。

---

## 4. Frontend 是否支持生产构建

| 结论 | **支持。** `frontend/package.json` 已定义 `build`（`next build --webpack`）与 `start`（`next start`）。 |
|------|----------------------------------------------------------------------------------------------------------|

**说明：**

- 生产需执行 `npm ci`/`npm install` 后 `npm run build`，再以 `npm run start` 或进程管理器托管。
- 浏览器访问的后端地址通过环境变量 **`NEXT_PUBLIC_API_BASE_URL`** 配置（见 `frontend/src/services/api.ts`；未设置时默认 `http://localhost:8000`）。部署到公网时必须在**构建阶段**注入正确的公网或内网 API 基址。

---

## 5. Backend 是否支持 uvicorn 生产启动

| 结论 | **支持 ASGI 启动方式。** `requirements.txt` 包含 `uvicorn`；`README.md` 示例为 `uvicorn api.main:app --host 127.0.0.1 --port 8000`。 |
|------|-------------------------------------------------------------------------------------------------------------------------------------|

**生产注意（运维层面，非改代码）：**

- 监听地址通常改为 `0.0.0.0` 或仅本机 + 前置 Nginx。
- 多 worker、超时、graceful shutdown、访问日志等建议按负载在启动命令或进程管理中配置。
- `api/main.py` 中 **CORS `allow_origins` 当前硬编码** 为 `http://localhost:3000` 与 `http://127.0.0.1:3000`；公网域名前端若未列入，浏览器跨域将失败——部署时需通过配置或网关策略解决（属于已知缺口，不在本审计中改代码）。

---

## 6. `.env` / `law_spider/.env` 是否会被误提交

| 结论 | **按当前 `.gitignore` 规则，正常 `git add` 不会跟踪上述文件。** |
|------|------------------------------------------------------------------|

**证据：**

- 仓库根 `.gitignore` 第 1 行为 `.env`，对全仓库任意路径下名为 `.env` 的文件生效。
- 在本机执行 `git check-ignore -v` 显示 `law_spider\.env` 与根目录 `.env` 均被该规则忽略。

**残余风险（流程与人为）：**

- 使用 `git add -f` 强制添加、或删除/篡改 `.gitignore`、或将密钥写入**未被** `.env` / `.env.*` 覆盖的文件名（如 `secrets.json`），仍可能泄露。
- `law_spider` 下存在独立 `.env` 时，**不会**被根目录 `.env.example` 自动描述；团队需在文档中约定「爬虫专用变量仅放服务器、不进仓库」。

---

## 7. SQLite 数据库路径是否可配置到持久化目录

| 子系统 | 可配置性 |
|--------|-----------|
| **聊天会话库** | **可配置。** `chat_store/db.py` 中 `get_chat_db_path()` 读取环境变量 **`CHAT_DB_PATH`**（默认 `data/legal_ai_chat.db`）；相对路径相对于项目根目录解析，也支持绝对路径。适合挂载 Docker volume 或服务器数据盘。 |
| **KB 更新任务库** | **不可配置（代码写死）。** `api/kb_update_api.py` 中 `DB_PATH = Path(__file__).resolve().parents[1] / "data" / "kb_update.db"`，未读取环境变量。持久化依赖「整个项目根下 `data/` 目录所在磁盘可写且可备份」，或通过整目录绑定/volume 挂载到该相对位置。 |

---

## 8. LegalData 路径是否存在 Windows 绝对路径依赖

| 结论 | **应用与编排代码未发现硬编码 `LegalData` 或典型盘符路径常量；数据根目录由任务请求中的 `storage_root` 等输入决定。** |
|------|---------------------------------------------------------------------------------------------------------------|

**说明：**

- `kb_update_api` 通过 `Path(__file__).resolve().parents[1]` 定位 `law_spider` 下脚本，为**跨平台相对路径**。
- 爬虫脚本内部使用 `os.path.join(base_path, "法规爬虫", ...)` 等形式；若在 Windows 上曾为任务配置 `E:\LegalData` 等，**换到 Linux 后必须改为 Linux 下的绝对路径**（如 `/data/legal`），否则子进程无法访问原路径。

---

## 9. kb-update 是否已 admin 限制

| 结论 | **是。** `/kb-update` 下已列出的 HTTP 接口均通过 `Depends(require_admin)` 注入，未登录为 401，非 admin 为 403（逻辑见 `auth/dependencies.py` 中 `require_admin`）。 |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|

**接口范围（与代码一致）：** `POST /kb-update/jobs`、`POST .../start`、`POST .../stop`、`GET /kb-update/jobs`、`GET .../validate-report-summary`、`GET .../{job_id}` 均带 `_admin: Annotated[..., Depends(require_admin)]`。

---

## 10. GitLab CI/CD 建议准备的变量（按场景）

以下为**典型** GitLab CI/CD **受保护变量 / 文件型变量** 建议清单（名称可按团队规范调整）：

| 类别 | 变量示例 | 用途 |
|------|-----------|------|
| 前端构建 | `NEXT_PUBLIC_API_BASE_URL` | Next 构建时注入浏览器访问的 API 根 URL |
| 模型与云 | `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`（可选） | DashScope / 千问 |
| 百炼 | `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`BAILIAN_WORKSPACE_ID`、`BAILIAN_INDEX_ID`、`BAILIAN_ENDPOINT` 等 | 检索与知识库 |
| RAG/模型开关 | `RAG_BACKEND`、`MODEL_BACKEND`、`LOCAL_KB_PATH`（若 local） | 与 `.env.example` 一致 |
| 认证 | `AUTH_USERS_JSON`、`AUTH_SESSION_SECRET`（≥32 字符）、`AUTH_COOKIE_NAME`、`AUTH_COOKIE_SECURE`、`AUTH_SESSION_EXPIRE_DAYS` | 登录与会话；**`AUTH_COOKIE_SECURE` 在 HTTPS 生产环境通常应为 true** |
| 聊天库（可选） | `CHAT_DB_PATH` | 将 SQLite 指到持久卷路径 |
| 百炼索引轮询（若使用） | `BAILIAN_INDEX_JOB_POLL_*` 等 | 与根 `.env` 中已有项对齐 |

**说明：** 若 CI 仅做 lint/测试而不部署，可只对 Runner 注入最小子集；若 **build Docker 镜像**，应避免将生产密钥 bake 进镜像层，优先运行时挂载或编排注入。

---

## 11. 部署到 Linux 服务器时建议关注的路径与行为调整

| 项目 | 说明 |
|------|------|
| **任务数据根 `storage_root`** | 在管理界面或 API 中为爬虫/导出指定的目录必须是 **Linux 上存在且可写** 的路径；从 Windows 拷贝的配置不可直接使用。 |
| **`law_spider` 子进程** | `kb_update_api` 使用 `sys.executable` 在 `law_spider` 目录下执行脚本；服务器需安装 README 要求的 Python 依赖，且爬虫链路若依赖 **Chrome / ChromeDriver**，需在 Linux 上单独安装并与无头模式配置一致。 |
| **`requirements.txt` 中的 `pywin32`** | 该包面向 **Windows**；在纯 Linux 容器或主机上 `pip install -r requirements.txt` 可能失败或产生无用工件。运维上需 **条件安装**、拆分依赖文件或锁定 Linux 友好清单（属于部署策略，本审计未改仓库）。 |
| **CORS** | 当前仅放行本地前端来源；生产前端 origin 需与运行配置一致（见第 5 节）。 |
| **调试日志路径** | `api/main.py` 等处的 debug 日志路径指向仓库上级相对路径下的 `debug-312446.log`；在容器或只读文件系统中可能不可写或位置怪异，部署时宜关闭或重定向（运维层）。 |
| **文档与目录名** | `README.md` 正文仍写 **`Legal_AI_Zhong`**，与实际目录名 **`Legal_AI`** 不一致，易造成克隆路径与文档命令不符——部署文档建议以真实仓库根为准。 |

---

## 12. 是否需要新增 `deploy/` 目录

| 结论 | **非必须**，但**强烈推荐**新增 `deploy/`（或等价名称）集中存放 **Dockerfile、compose 示例、nginx 示例、systemd unit 示例、环境变量说明**，与业务代码分离。 |
|------|--------------------------------------------------------------------------------------------------------------------------------------------------------|

当前仓库无该目录；是否创建由团队规范决定，从可维护性与 onboarding 角度利大于弊。

---

## 当前已具备能力（汇总）

- FastAPI 应用入口 `api/main:app`，生命周期内初始化聊天库；路由包含认证、聊天、kb-update、new-rag 等。
- 前端 Next.js 16，具备 `build`/`start` 与 `NEXT_PUBLIC_API_BASE_URL` 约定。
- 根 `.gitignore` 忽略 `.env`、构建产物、`*.db` 等，降低密钥与本地数据库误提交概率。
- 聊天 SQLite 路径可通过 `CHAT_DB_PATH` 指向持久化位置。
- `/kb-update` 后端接口已统一 **admin** 鉴权。

---

## 缺失文件 / 能力（汇总）

| 缺失项 | 说明 |
|--------|------|
| Dockerfile / compose | 无现成容器化定义 |
| Nginx（或 Traefik 等）示例 | 无仓库内反向代理配置 |
| `.gitlab-ci.yml` | 无现成 CI/CD 流水线 |
| KB 任务库路径环境变量 | `kb_update.db` 路径写死在代码中 |
| 生产 CORS 可配置性 | 来源列表写死在 `api/main.py` |
| Linux 友好依赖声明 | `pywin32` 对 Linux 部署不友好 |

---

## 推荐部署架构（概念）

```text
                    ┌─────────────────┐
   用户浏览器 ───►  │ Nginx (TLS)     │
                    │  /  → Next.js   │  npm run start 或静态导出策略
                    │  /api → 反代    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ uvicorn (FastAPI)│
                    │  环境变量注入     │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        SQLite (chat)   SQLite (kb)    外呼 DashScope/百炼
        卷挂载路径      data/ 卷        出网策略 / 密钥
```

- **小型单机：** 同一主机上 Nginx + `next start` + uvicorn，SQLite 与（可选）`storage_root` 数据目录挂载同一块数据盘并纳入备份。
- **略大规模：** API 与前端分容器，Secrets 由 GitLab + 部署环境注入，爬虫步骤仅在具备浏览器与足够资源的 Runner/工作节点执行。

---

## 建议新增的文件（清单，不要求本次实现）

| 文件/目录（建议） | 用途 |
|-------------------|------|
| `deploy/Dockerfile.backend` | Python 依赖、非 Windows 依赖拆分、uvicorn 启动 |
| `deploy/Dockerfile.frontend` 或前端多阶段 | `npm run build` + `next start` |
| `deploy/docker-compose.yml` | API、前端、网络、volume |
| `deploy/nginx.conf.example` | TLS、`proxy_pass`、缓冲与超时（流式接口需调大相关超时） |
| `deploy/.env.production.example` | 仅占位符，与 GitLab 变量说明对应 |
| `.gitlab-ci.yml` | lint、test、build、（可选）deploy job |

---

## 绝不能进入 GitLab 仓库的敏感信息（类别）

以下**类别**应仅存在于 GitLab **CI/CD 受保护变量**、部署主机密钥管理或密钥管理服务中，**不得**提交到公开或内网默认可见的 Git 历史：

- `DASHSCOPE_API_KEY` 及等价模型调用密钥  
- `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`  
- 百炼 / Workspace / Index 等可与账号绑定的配置（若视为敏感）  
- **`AUTH_SESSION_SECRET`**、**`AUTH_USERS_JSON`**（含密码哈希与账号体系）  
- 任意生产数据库文件、生产用 `storage_root` 下的爬取与清洗数据（体积与合规另议）  
- `law_spider/.env` 中若存有上述同类密钥  

**注意：** 若历史上曾将真实 `.env` 提交过 Git，仅删除文件不够，需轮换所有已泄露密钥并清理历史（如 `git filter-repo`），本报告不展开操作步骤。

---

## Linux 服务器部署注意事项（简表）

1. **Python 版本**：与 README 一致（3.11+），虚拟环境与系统库分离。  
2. **依赖安装**：处理 `pywin32` 与 Linux 的兼容性（见第 11 节）。  
3. **爬虫链路**：确认 Chrome/Chromedriver、字体、时区与磁盘空间；`storage_root` 与权限（非 root 运行更佳）。  
4. **HTTPS 与 Cookie**：生产环境 `AUTH_COOKIE_SECURE=true`，否则安全_cookie 可能无法随 HTTPS 发送。  
5. **备份**：`CHAT_DB_PATH` 指向的库、`data/kb_update.db`、以及法规数据根目录。  
6. **出网**：确保服务器可访问 DashScope、百炼/OpenAPI 端点。  
7. **编码**：爬虫与路径中含中文目录名，系统区域设置与文件系统 UTF-8 需正常。

---

## 审计方法说明

- 在 `Legal_AI` 根目录递归检索 `Dockerfile`、`docker-compose*.yml`、`*.gitlab-ci.yml`、`nginx*.conf`：**无匹配**。  
- 阅读 `frontend/package.json`、`requirements.txt`、`README.md`、`api/main.py`、`api/kb_update_api.py`、`chat_store/db.py`、`.gitignore`、`.env.example`，并执行 `git check-ignore` 验证忽略规则。  
- 对 `law_spider` 做语义检索：**数据根路径由输入/环境驱动，未发现写死的 `LegalData` 常量。**

---

**声明：** 本报告依据审计时工作区快照编写；若之后合并了 Docker/CI 等提交，应以最新仓库为准再次核对。
