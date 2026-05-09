# SQLite 登录与会话隔离：当前工程审计报告

**审计日期**：2026-05-09  
**范围**：Legal_AI 后端（FastAPI）、前端（Next.js）聊天与会话存储；未改动业务代码，结论仅基于仓库现状。

**目标背景**：计划使用 SQLite 实现固定 6 个账号登录，并使不同账号的聊天历史完全隔离。

---

## 执行验证命令结果

在 `Legal_AI` 与 `Legal_AI/frontend` 下执行了下列命令，均 **成功退出（exit code 0）**：

| 命令 | 结果 |
|------|------|
| `python -m compileall api config services new_feature_qwen_kb` | 通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过（Next.js 16.2.1 webpack） |

---

## 1. 当前是否有登录系统

**结论：没有面向终端用户的登录 / 鉴权系统。**

依据：

- `api/main.py` 仅挂载两个路由：`kb_update_router`（前缀 `/kb-update`）与 `new_rag_router`（前缀 `/new-rag`），未注册 `/auth/*`，也未挂载全局认证中间件或 `Depends` 型鉴权。
- 全库检索未发现 `/auth/login`、`/auth/logout`、`/auth/me` 等路由实现。
- `new_feature_qwen_kb/router.py` 中 `/new-rag/ask` 与 `/new-rag/ask-stream` 的处理函数仅接收请求体并调用 `QwenKBRagService`，无用户身份参数。
- `api/kb_update_api.py` 中 `/kb-update/jobs*` 等接口同样未见登录校验。

因此：**当前为匿名可调用的 API + 浏览器本地持久化聊天列表**，不是多租户或账号体系。

---

## 2. 当前会话是否仍依赖 localStorage

**结论：是。新特性对话页的会话列表与消息主体依赖浏览器 `localStorage`，无服务端会话绑定用户。**

### 2.1 `frontend/src/lib/chat-sessions.ts`

- 键名：`legal-ai-chat-sessions-v1`（会话列表 JSON）、`legal-ai-active-session-id-v1`（当前会话 id）。
- `getChatSessions` / `saveChatSessions` / `updateChatSession` / `deleteChatSession` / `getActiveSessionId` / `setActiveSessionId` 均通过 `window.localStorage` 读写。
- 数据模型为前端 `ChatSession`（含 `messages` 数组），最多保留 50 条会话。

### 2.2 `frontend/src/app/new-feature-chat/page.tsx`

- 挂载时从 `getChatSessions()` / `getActiveSessionId()` 恢复状态；若无有效会话则 `createChatSession` + `saveChatSessions` + `persistActiveSessionId`。
- 发送消息、停止生成、切换会话等路径中多次调用 `updateChatSession(..., { messages: ... })`，持续写回 **同一浏览器** 的 localStorage。
- 调用后端时使用 `fetch(\`${getApiBaseUrl()}/new-rag/ask-stream\`, { ... })`，请求体仅含 `question` 与 `conversation_history`，**未携带** Cookie、`Authorization` 头或其它用户标识。

**服务端会话存储**：当前 **没有** 与「登录用户」绑定的服务端 Session（如服务器侧 session store、签名的 session cookie 与 Redis/SQLite 会话表等）。聊天内容不落库到应用自有「聊天表」。

---

## 3. 后端鉴权与 `/new-rag/ask-stream` 可访问性

| 检查项 | 结论 |
|--------|------|
| `POST /auth/login` | **不存在** |
| `POST /auth/logout` | **不存在** |
| `GET /auth/me`（或等价） | **不存在** |
| `POST /new-rag/ask-stream` | **已实现**（`new_feature_qwen_kb/router.py`），**未登录即可访问**；任意能访问 API 地址的客户端均可 POST JSON 触发 RAG 流式回答。 |

补充：`api/main.py` 对浏览器直连开启了 CORS，且 `allow_credentials=True`；当前聊天请求未使用凭证，但 **API 本身仍无身份校验**，属于开放端点（仍受网络边界与部署方式约束，见第 5 节）。

---

## 4. 后端数据库现状（SQLite 与聊天隔离）

### 4.1 是否已有 SQLite 初始化逻辑

**有，但用途是知识库更新任务作业，不是聊天。**

- `api/kb_update_api.py`：使用 `sqlite3`，库文件路径为 `Legal_AI/data/kb_update.db`（相对 `kb_update_api.py` 解析的 `data/kb_update.db`）。
- `_init_db()` 中 `CREATE TABLE IF NOT EXISTS`：`kb_jobs`、`kb_job_steps`、`kb_job_logs`。

### 4.2 是否已有 `chat_sessions` / `chat_messages` 表

**没有。** 在当前审计范围内未发现在应用 SQLite（或其它 DB）中定义 **聊天会话表 / 消息表**。

### 4.3 是否已有 `user_id` 隔离

**没有。** 现有 SQLite 表结构围绕 `job_id` 等作业字段，与终端用户、`user_id` 无关；聊天数据在前端 localStorage，后端流式接口无用户维度。

---

## 5. 部署到服务器后，多账号「共用」当前实现的风险

在 **不增加登录与按用户隔离存储** 的前提下，若多名用户共用同一部署（同一前端域名 + 同一 API）：

1. **聊天历史互不隔离（同浏览器维度）**  
   localStorage 按 **浏览器配置文件 / 设备** 分隔，不是按「人」。同一台电脑同一浏览器仍只有一份会话；换账号（若只做前端假切换而无后端身份）无法真正隔离。

2. **跨设备无同步**  
   会话仅在本机 localStorage，服务器看不到用户级聊天归档。

3. **API 滥用与成本风险**  
   `/new-rag/ask-stream`（及 `/new-rag/ask`）匿名可调用，若 API 暴露在公网，存在被扫榜、刷接口、消耗模型与向量检索配额的风险。

4. **数据与合规**  
   对话内容若含敏感信息，仅存在用户浏览器本地，备份与审计不在服务端；与此同时，任何能获得 API 访问的人都可以发起提问，**无法在服务端按账号做访问控制或留存策略**。

5. **`/kb-update` 作业接口**  
   同样未见登录保护；若对外可达，存在被误触发或恶意创建作业的风险（取决于部署防火墙与反代配置）。

---

## 6. 需要新增哪些后端文件（建议清单，非实施）

以下为达成「SQLite + 固定 6 账号 + 聊天按用户隔离」时 **典型会新增或拆分** 的文件/模块类型（名称可按项目惯例调整）：

- **数据库层**：例如 `db.py` / `database.py`：SQLite 路径、连接、`init_schema()`、`chat`/`user`/`session` 相关 DAO。
- **认证**：例如 `auth/router.py`（login/logout/me）、`auth/passwords.py`（哈希与校验）、`auth/session.py`（签发与校验 session token 或 signed cookie）。
- **依赖注入**：例如 `auth/deps.py`：`get_current_user` / `require_user`，供 RAG 与聊天 CRUD 使用。
- **聊天 CRUD API**：例如 `chat/router.py`：`GET/POST` 会话列表、消息追加、按 `user_id` 过滤（若历史改服务端存储）。
- **配置**：环境变量或配置文件中的 `SECRET_KEY`、cookie 参数、SQLite 路径等。
- **（可选）迁移/种子脚本**：初始化 6 个账号、`users` 表插入或 `password_hash` 导入。

同时需在 **`api/main.py`** 中挂载新路由，并对 **`/new-rag/ask-stream`**（及如需保护的 `/kb-update/*`）加上鉴权策略。

---

## 7. 需要新增哪些前端文件（建议清单，非实施）

- **登录页**：例如 `src/app/login/page.tsx`。
- **认证状态**：例如 `src/lib/auth.ts` 或 `src/contexts/auth-context.tsx`：登录后保存会话策略（若用 **HttpOnly Cookie**，前端 mainly 读 `/auth/me`；若用 token，则需安全存储策略，通常仍优先 Cookie）。
- **路由守卫**：对 `/new-feature-chat`（及其它需登录页）在 layout 或 middleware 中校验已登录，未登录重定向登录页。
- **API 封装**：`fetch` 增加 `credentials: "include'`（若基于 Cookie）或统一附加 `Authorization`。
- **会话存储改造**：将「会话列表 + 消息」从纯 localStorage 改为 **拉取/同步服务端按用户隔离的接口**，localStorage 仅可作缓存或完全移除。

---

## 8. 推荐的 SQLite 表结构（草案）

以下为满足 **固定少量用户、服务端会话 cookie、聊天按用户隔离** 的常见最小集合（字段可按是否需要「刷新令牌」「设备列表」扩展）。

```sql
-- 固定账号（6 个）；密码仅存哈希
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 服务端会话（浏览器 Cookie 存 session_id，此处存令牌哈希防窃取重用）
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- 每个用户下的对话线程
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,  -- 或 INTEGER + UUID
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_sessions_user_updated ON chat_sessions(user_id, updated_at DESC);

-- 消息归属会话与用户（冗余 user_id 便于强制校验与查询）
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  -- 可选：结构化卡片、引用、过程事件的 JSON
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_session_created ON chat_messages(session_id, created_at);
```

**说明**：

- 若希望 **消息体与前端 `ChatItem` 对齐**，可将 `processEvents`、`answerCard` 等整体序列化进 `payload_json`，同时保留 `content` 供检索摘要。
- **流式接口**仍可不强制写库；通常在收到最终 `answer` 事件后由前端或服务端落一条 `assistant` 消息，以保证与现有 UX 一致。

---

## 9. 摘要表

| 问题 | 结论 |
|------|------|
| 是否有登录系统？ | **无** |
| 会话是否依赖 localStorage？ | **是**（聊天会话与消息） |
| 是否有聊天相关 SQLite 表？ | **无** |
| `/new-rag/ask-stream` 是否匿名可访问？ | **是** |
| 是否有服务端用户会话存储？ | **无**（与聊天用户无关；仅有 kb 作业库） |

---

*本报告仅描述现状与改造方向建议，未修改任何业务代码。*
