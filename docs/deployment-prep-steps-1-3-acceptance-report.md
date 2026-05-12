# 部署准备第 1～3 步 — 综合验收报告

**报告路径：** `Legal_AI/docs/deployment-prep-steps-1-3-acceptance-report.md`  
**验收方式：** 对照仓库静态检查 + 本地命令验证（**未修改**业务代码；本报告为新增文档）。  
**验收日期：** 以工作区快照为准（2026-05-12）。

---

## 一、第 1 步：生产配置化

| # | 检查项 | 结论 | 证据摘要 |
|---|--------|------|----------|
| 1.1 | CORS 是否已支持环境变量 `CORS_ALLOW_ORIGINS` | **通过** | `api/main.py` 中 `_parse_cors_allow_origins()` 读取 `os.environ.get("CORS_ALLOW_ORIGINS", "").strip()`，逗号分隔解析。 |
| 1.2 | 未配置时是否仍保留 localhost 默认值 | **通过** | 未配置或解析后为空时返回 `_DEFAULT_CORS_ORIGINS`：`http://localhost:3000`、`http://127.0.0.1:3000`。 |
| 1.3 | `KB_UPDATE_DB_PATH` 是否已支持环境变量 | **通过** | `api/kb_update_api.py` 中 `_kb_update_db_path()` 读取 `KB_UPDATE_DB_PATH`。 |
| 1.4 | 相对路径是否相对项目根目录解析 | **通过** | 非绝对路径时返回 `(_LEGAL_AI_ROOT / p).resolve()`，`_LEGAL_AI_ROOT = Path(__file__).resolve().parents[1]`（即 `Legal_AI/`）。 |
| 1.5 | 父目录是否会自动创建 | **通过** | `_init_db()` 中 `db_path = _kb_update_db_path()` 后执行 `db_path.parent.mkdir(parents=True, exist_ok=True)`。 |
| 1.6 | 是否新增 `requirements-server.txt` / `requirements-linux.txt` | **部分** | 已新增 **`requirements-server.txt`**。仓库中**未发现** `requirements-linux.txt`（与最初「二选一」命名方案一致时可接受）。 |
| 1.7 | Linux 依赖文件是否排除了 `pywin32` | **通过** | `requirements-server.txt` 全文无 `pywin32`；`requirements.txt` 仍含 `pywin32==311`。 |
| 1.8 | `requirements.txt` 是否仍保留给 Windows 本地开发 | **通过** | 根目录 `requirements.txt` 仍存在且含 `pywin32`。 |
| 1.9 | 是否未改 RAG / kb-update 业务逻辑 | **通过（配置层）** | 第 1 步变更为 **CORS 解析**、**KB 库路径解析**、**依赖清单拆分**与文档；`kb_update_api` 中任务模型、步骤、子进程编排、`require_admin` 等逻辑未改语义，仅 DB 文件路径可配置。 |

---

## 二、第 2 步：`deploy/` 目录

### 2.1 文件是否已新增

| 文件 | 结论 |
|------|------|
| `deploy/Dockerfile.backend` | **存在** |
| `deploy/Dockerfile.frontend` | **存在** |
| `deploy/docker-compose.yml` | **存在** |
| `deploy/nginx.conf.example` | **存在** |
| `deploy/.env.production.example` | **存在**（点开头文件；部分工具 `list_dir` 可能不显示，但路径可读） |
| `deploy/README_DEPLOY.md` | **存在** |

### 2.2 行为与设计核对

| # | 检查项 | 结论 | 证据摘要 |
|---|--------|------|----------|
| 2.1 | backend 镜像是否使用 `requirements-server.txt` | **通过** | `Dockerfile.backend`：`COPY requirements-server.txt .` 与 `pip install -r requirements-server.txt`。 |
| 2.2 | backend 启动是否为 `uvicorn api.main:app` | **通过** | `CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]`。 |
| 2.3 | frontend 是否支持 `NEXT_PUBLIC_API_BASE_URL=/api` | **通过** | `Dockerfile.frontend`：`ARG NEXT_PUBLIC_API_BASE_URL=/api`、`ENV NEXT_PUBLIC_API_BASE_URL=...`；compose 中 `build.args` 默认 `${NEXT_PUBLIC_API_BASE_URL:-/api}`。 |
| 2.4 | docker-compose 是否包含 backend / frontend / nginx | **通过** | `deploy/docker-compose.yml` 定义三服务。 |
| 2.5 | data、LegalData、logs 是否通过 volume 挂载 | **通过** | backend：`/opt/legal-ai/data:/app/data`、`/opt/legal-ai/LegalData:/opt/legal-ai/LegalData`、`/opt/legal-ai/logs:/app/logs`。 |
| 2.6 | nginx 是否将 `/api/` 反代到 backend | **通过** | `location /api/` + `proxy_pass http://legal_ai_backend/;`（尾斜杠剥离前缀）。 |
| 2.7 | nginx 是否关闭流式 buffering 或合理超时 | **通过** | `proxy_buffering off`、`proxy_cache off`、`gzip off`、`X-Accel-Buffering no`、`proxy_read_timeout` / `proxy_send_timeout` 3600s。 |
| 2.8 | `.env.production.example` 是否只有占位符 | **通过** | 内容为 `your-*`、`REPLACE_*`、`https://app.example.com` 等占位；无真实云密钥形态。 |
| 2.9 | README_DEPLOY 是否说明敏感文件不能进 GitLab | **通过** | 第一节表格明确生产 `.env`、`/opt/legal-ai/.env`、SQLite、`law_spider/.env` 等勿提交。 |
| 2.10 | README_DEPLOY 是否说明 SQLite 备份、admin、生产知识库仅建议服务器更新 | **通过** | 含「备份 SQLite」章节；「kb-update 与管理员」说明 admin；生产知识库更新建议服务器内网由管理员执行。 |

### 2.3 Docker 镜像构建验证

本验收环境**未执行** `docker build` / `docker compose config`（主机可能未安装 Docker）。**建议**在具备 Docker 的机器上对 `deploy/Dockerfile.*` 与 `deploy/docker-compose.yml` 做一次构建与启动烟测；**不作为**第 1～3 步配置化与 CI 清单的阻塞项。

---

## 三、第 3 步：GitLab CI

| # | 检查项 | 结论 | 证据摘要 |
|---|--------|------|----------|
| 3.1 | 是否包含 `backend_check` | **通过** | `.gitlab-ci.yml` 定义 `backend_check`。 |
| 3.2 | 是否包含 `frontend_build` | **通过** | 定义 `frontend_build`。 |
| 3.3 | backend 是否使用 `requirements-server.txt` | **通过** | `pip install -r requirements-server.txt`。 |
| 3.4 | 是否执行 `python -m compileall` | **通过** | 与第 1 步相同目录列表。 |
| 3.5 | frontend 是否执行 `npm ci` / lint / build | **通过** | `npm ci`、`npm run lint -- .`、`npm run build`。 |
| 3.6 | `NEXT_PUBLIC_API_BASE_URL` 是否在 CI 构建中设为 `/api` | **通过** | `NEXT_PUBLIC_API_BASE_URL=/api npm run build`。 |
| 3.7 | 是否没有读取生产 `.env` | **通过** | 脚本中无 `dotenv`/`source` 生产路径。 |
| 3.8 | 是否没有打印密钥 | **通过** | 无 `echo`/打印环境变量类命令；注释提示勿打印敏感变量。 |
| 3.9 | 是否没有上传 `data/*.db` 或 LegalData | **通过** | `artifacts: when: never`。 |
| 3.10 | 是否没有自动部署服务器 | **通过** | 无 SSH、`docker push`、远程执行等步骤。 |

**说明：** `workflow.rules` 当前仅在 **Merge Request** 与 **`main` 分支 push** 时创建流水线；其他分支纯 push 不跑 CI（若需全分支可后续放宽规则，**非本报告阻塞**）。

---

## 四、安全与 Git

| # | 检查项 | 结论 | 证据摘要 |
|---|--------|------|----------|
| 4.1 | `.env` 是否仍被 gitignore | **通过** | `.gitignore` 首行 `.env`。 |
| 4.2 | `law_spider/.env` 是否仍被 gitignore | **通过** | 规则 `.env` 匹配任意路径下同名文件（与既有 `git check-ignore` 行为一致）。 |
| 4.3 | `data/*.db` 是否不会被提交 | **通过** | `.gitignore` 含 `*.db`、`*.sqlite`（通配全仓库）。 |
| 4.4 | LegalData 是否不会被提交 | **注意** | 根 `.gitignore` **未**单独列出 `LegalData/`。若工作区内存在该目录且被 `git add`，**仍可能被提交**；运维上建议数据根放在仓库外（如仅 `/opt/legal-ai/LegalData`），或在 `.gitignore` 增加 `LegalData/`（属后续加固，**不视为第 1～3 步硬阻塞**）。 |
| 4.5 | `deploy/.env.production.example` 是否没有真实密钥 | **通过** | 占位符与示例域名/ID。 |
| 4.6 | `AUTH_USERS_JSON` / `AUTH_SESSION_SECRET` 是否未硬编码进代码 | **通过** | 认证自 `os.environ` / `AUTH_USERS_JSON` 读取（见 `auth/config.py`）；验收抽样检索源码未见典型硬编码会话密钥。 |
| 4.7 | 百炼 AK/SK 是否未硬编码进代码 | **通过** | 对 `*.py`/`*.ts` 等做密钥形态抽样检索未见命中；密钥应仅存 `.env`（且已被忽略）。**注意：** 开发者本地 `.env` 若曾含真实密钥，须确保从未执行 `git add -f .env`；历史泄露需轮换密钥（流程问题，非本步代码缺陷）。 |

---

## 五、本地构建验证（本机执行记录）

在 **`Legal_AI/`** 下执行：

```bash
python -m compileall api auth chat_store kb_upload_store law_spider scripts services config
```

**结果：** **通过**（退出码 0）。

在 **`Legal_AI/frontend/`** 下执行：

```bash
npm run lint -- .
set NEXT_PUBLIC_API_BASE_URL=/api   # Windows；Linux 用 export
npm run build
```

**结果：** **通过**（退出码 0；Next.js 生产构建完成并输出路由表）。

---

## 六、下一步建议：是否可进入「第 4 步：服务器手动部署」

**结论：可以进入第 4 步（服务器手动部署）**，当前**无**必须回退代码的阻塞项；建议在首次上生产前完成下列准备并完成一次 **Docker 镜像烟测**（若采用容器部署）。

### 服务器手动部署前建议准备清单

1. **域名**：解析到服务器公网 IP（或内网 DNS）；与 `CORS_ALLOW_ORIGINS`、浏览器访问 URL 一致。  
2. **Linux 服务器**：建议 Ubuntu 22.04+ / 等价发行版；满足 CPU/内存与出网访问 DashScope、百炼等。  
3. **Docker / Docker Compose**：与 `deploy/README_DEPLOY.md` 一致；验证 `docker compose -f deploy/docker-compose.yml` 可 build/up。  
4. **HTTPS 证书**：生产环境建议 TLS；按 `nginx.conf.example` 注释块挂载证书并开放 443。  
5. **`/opt/legal-ai` 目录**：按 README 创建 `data`、`LegalData`、`logs` 与权限。  
6. **生产 `.env`**：从 `deploy/.env.production.example` 复制并填写真实值；**不入库**。  
7. **data / LegalData / logs 持久化**：与 compose 卷一致；SQLite 路径与 `CHAT_DB_PATH`、`KB_UPDATE_DB_PATH` 对齐。  
8. **初始 admin 账号**：`AUTH_USERS_JSON` 需 **恰好 6 个用户**（应用校验）；至少一名 `role: "admin"`；`password_hash` 为 bcrypt。  
9. **百炼生产 Index 或测试 Index**：`BAILIAN_WORKSPACE_ID`、`BAILIAN_INDEX_ID` 等与运行环境一致；区分测试/生产避免误写生产索引。

---

## 七、总览输出（对应用户要求的 5 条）

1. **报告路径：** `docs/deployment-prep-steps-1-3-acceptance-report.md`（即本文件）。  
2. **前三步是否完成：** **是**（第 1 步配置化、第 2 步 `deploy/` 示例、第 3 步 `.gitlab-ci.yml` 检查/构建均已落地）。  
3. **是否存在阻塞问题：** **无必须阻塞**；**非阻塞注意项：**（a）未单独 `gitignore LegalData/`；（b）Docker 镜像未在本机执行 build 验证；（c）无 `requirements-linux.txt` 文件名（已有 `requirements-server.txt`）。  
4. **是否可以进入服务器手动部署：** **可以**；建议先完成第六节清单并在有 Docker 的环境做一次 compose 烟测。  
5. **compileall / lint / build 是否通过：** **均通过**（本机本次执行退出码均为 0）。
