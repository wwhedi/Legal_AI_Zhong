# Legal_AI 生产部署说明（Docker 示例）

本目录提供 **Dockerfile、Compose、Nginx 与生产环境变量示例**，不修改业务代码。默认假设：

- 服务器数据与日志放在 **`/opt/legal-ai/`**；
- 在 **仓库根目录 `Legal_AI/`** 下执行 `docker compose -f deploy/docker-compose.yml`，以便卷路径 `./deploy/nginx.conf.example` 正确解析。

---

## 1. 哪些文件不能进 Git

| 类别 | 说明 |
|------|------|
| **生产 `.env`** | 含 `AUTH_SESSION_SECRET`、`AUTH_USERS_JSON`、云厂商 AK/SK、`DASHSCOPE_API_KEY` 等，**禁止**提交到 GitLab。仅使用本目录 **`.env.production.example`** 作占位模板。 |
| **`/opt/legal-ai/.env`** | 仅在服务器上创建与维护；通过 `env_file` 注入后端容器。 |
| **SQLite 数据文件** | 如 `legal_ai_chat.db`、`kb_update.db` 等，应在 `.gitignore` 中忽略（仓库根已忽略 `*.db`）。 |
| **法规数据目录 `LegalData`** | 体积大、可能涉合规，勿提交；仅通过卷挂载进容器。 |
| **`law_spider/.env`** | 若含密钥，同生产 `.env` 处理。 |

---

## 2. 服务器目录结构（建议）

```text
/opt/legal-ai/
├── .env                 # 生产环境变量（不入库）
├── data/                # 挂载为容器 /app/data（SQLite 等）
├── LegalData/           # kb-update / 爬虫 storage_root 建议使用此路径
└── logs/                # 挂载为容器 /app/logs（应用或运维日志）
```

首次部署前：

```bash
sudo mkdir -p /opt/legal-ai/{data,LegalData,logs}
sudo chown -R 1000:1000 /opt/legal-ai   # 按运行用户调整；避免容器内无法写卷
```

将 `deploy/.env.production.example` 复制为 `/opt/legal-ai/.env` 并替换全部占位符。

---

## 3. 首次部署

**前置：** 已安装 Docker Engine 与 Docker Compose v2；已准备 `/opt/legal-ai/.env` 与目录权限。

在 **克隆后的仓库根目录** `Legal_AI/` 执行：

```bash
docker compose -f deploy/docker-compose.yml --env-file /opt/legal-ai/.env up -d --build
```

说明：

- **backend**：镜像内 **不包含** `.env`；运行时通过 `env_file: /opt/legal-ai/.env` 注入。
- **frontend**：`NEXT_PUBLIC_*` 在 **构建阶段** 写入；`docker compose` 会从 `--env-file` 读取同名变量参与 `build.args` 插值。若未设置，默认 **`/api`**（与 Nginx 反代一致）。
- **nginx**：监听 **80**，将 `./deploy/nginx.conf.example` 挂载为默认站点配置。

部署后浏览器访问：`http://<服务器IP>/`（HTTPS 需在 `nginx.conf.example` 基础上自行启用证书与 443 映射）。

---

## 4. 查看日志

```bash
docker compose -f deploy/docker-compose.yml logs -f
docker compose -f deploy/docker-compose.yml logs -f backend
docker compose -f deploy/docker-compose.yml logs -f frontend
docker compose -f deploy/docker-compose.yml logs -f nginx
```

主机侧日志目录（若应用写入 `/app/logs`）：

```bash
ls -la /opt/legal-ai/logs
```

---

## 5. 备份 SQLite

数据库文件路径取决于 `.env` 中的 **`CHAT_DB_PATH`**、**`KB_UPDATE_DB_PATH`**（示例中为容器内 `/app/data/*.db`，即主机 **`/opt/legal-ai/data/`**）。

建议在业务低峰期执行拷贝：

```bash
sudo cp -a /opt/legal-ai/data/legal_ai_chat.db "/opt/legal-ai/data/legal_ai_chat.db.bak.$(date +%Y%m%d)"
sudo cp -a /opt/legal-ai/data/kb_update.db "/opt/legal-ai/data/kb_update.db.bak.$(date +%Y%m%d)"
```

---

## 6. kb-update 与管理员

- **`/kb-update` 前端与后端 API** 需 **已登录且 `role` 为 `admin`** 的用户；普通用户为 **403**。生产环境请至少配置一名管理员（见 `AUTH_USERS_JSON`）。
- **生产知识库更新**（爬取、清洗、上传百炼）建议在 **服务器内网** 由管理员执行，避免在不可信网络暴露爬虫与 AK/SK 风险面。

---

## 7. 文件清单

| 文件 | 用途 |
|------|------|
| `Dockerfile.backend` | Python 3.11-slim，`requirements-server.txt`，`uvicorn` 监听 `0.0.0.0:8000` |
| `Dockerfile.frontend` | Node 20 构建 + 运行 `next start`；`ARG` / `ENV` **`NEXT_PUBLIC_API_BASE_URL`** |
| `docker-compose.yml` | 服务 **backend / frontend / nginx**；卷与 `env_file` |
| `nginx.conf.example` | `/` → 前端；`/api/` → 后端（剥离前缀）；流式关闭缓冲；超时加大 |
| `.env.production.example` | 仅占位符，复制到服务器后填写 |

---

## 8. 常见问题

- **CORS 错误**：在 `/opt/legal-ai/.env` 中设置 **`CORS_ALLOW_ORIGINS`** 为实际浏览器访问的页面 Origin（与仓库根 `README.md` 一致）。
- **前端仍请求 localhost:8000**：需 **重新构建** frontend 镜像，确保构建时 `NEXT_PUBLIC_API_BASE_URL` 为 **`/api`** 或完整 HTTPS API 地址。
- **Linux 依赖**：后端镜像使用 **`requirements-server.txt`**（不含 `pywin32`）。

---

## 9. 更新镜像

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file /opt/legal-ai/.env up -d --build
```
