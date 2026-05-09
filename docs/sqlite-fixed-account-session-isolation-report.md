# 固定账号登录 + SQLite 会话隔离 — 综合验收报告

**验收日期**：2026-05-09  
**性质**：基于当前仓库代码与配置的静态核对 + 命令执行结果；第 7～8 项中含需在真实环境执行的模拟测试与回归清单。

---

## 执行命令结果

| 命令 | 结果 |
|------|------|
| `cd Legal_AI && python -m compileall api config services new_feature_qwen_kb auth chat_store scripts` | **通过**（exit code 0） |
| `cd Legal_AI/frontend && npm run lint` | **通过** |
| `cd Legal_AI/frontend && npm run build` | **通过** |

---

## 1. 后端登录

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| `POST /auth/login` | **有** | `auth/router.py`：`@router.post("/login")` |
| `POST /auth/logout` | **有** | `auth/router.py`：`@router.post("/logout")`，并 `delete_cookie` |
| `GET /auth/me` | **有** | `auth/router.py`：`@router.get("/me")`，依赖 `get_current_user` |
| HttpOnly Cookie | **是** | `login`：`response.set_cookie(..., httponly=True, samesite="lax", path="/", secure=settings.cookie_secure)` |
| bcrypt | **是** | `auth/security.py`：`verify_password` 使用 `bcrypt.checkpw` |
| 无明文密码写入代码 | **是（配置约定）** | 账号来自环境变量 `AUTH_USERS_JSON`，字段为 `password_hash`；`auth/config.py` 从 JSON 加载，不包含明文密码字段。实际部署需确保 `.env` 不落库、不把明文写进仓库。 |

---

## 2. SQLite（聊天库）

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| `CHAT_DB_PATH` 生效 | **是** | `chat_store/db.py`：`get_chat_db_path()` 读取 `os.environ.get("CHAT_DB_PATH", "data/legal_ai_chat.db")`，相对路径相对于 `Legal_AI` 根目录解析 |
| 库文件不存在时自动创建 | **是** | `init_db()`：`path.parent.mkdir(...)` + `sqlite3.connect(str(path))` |
| `chat_sessions` / `chat_messages` 自动建表 | **是** | `SCHEMA_SQL` 中 `CREATE TABLE IF NOT EXISTS ...` |
| 索引 | **是** | `idx_chat_sessions_user_updated`、`idx_chat_messages_session_created`、`idx_chat_messages_user` |
| 数据库文件不提交 Git | **需在仓库策略中确认** | 当前工作区快照中**未发现** `.gitignore` 文件；**未见**由本报告代为 guarantee。建议在仓库 `Legal_AI/data/` 或 `*.db` 维度增加忽略规则，避免 `legal_ai_chat.db`、`kb_update.db` 等误提交。 |

---

## 3. 后端鉴权（new-rag）

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| `/new-rag/ask` 需登录 | **是** | `Depends(get_current_user)` |
| `/new-rag/ask-stream` 需登录 | **是** | `Depends(get_current_user)` |
| 未登录返回 401 | **是** | `auth/dependencies.py`：`get_current_user` 无有效 Cookie 时 `HTTPException(401, "Not authenticated")` |
| 前端不传 `user_id` | **是** | new-rag 请求体仍为 `question` + `conversation_history`（`NewRagAskRequest`）；用户身份仅来自 Cookie |

---

## 4. 会话隔离（服务端）

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| `chat_sessions.user_id` | **有** | `chat_store/db.py` 表定义 |
| `chat_messages.user_id` | **有** | 同上 |
| 列表 / 详情 / 更新 / 删除 / 插消息带 `user_id` | **是** | `chat_store/service.py`：`WHERE user_id = ?` 或与 `id` 组合约束归属 |
| 他人 `session_id` 不可读 | **是（表现为 404）** | `chat_store/router.py`：会话不存在或不归属当前用户时 `_not_found()`（404），避免枚举 |

---

## 5. 前端登录与凭证

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| 未登录访问 `/new-feature-chat` → `/login` | **是** | 挂载后 `fetchMe()`，`401` 时 `router.replace("/login")`；并有「验证登录…」门禁 |
| 登录成功进入聊天 | **是** | `login/page.tsx` 登录成功后 `router.replace("/new-feature-chat")` |
| 退出清空当前显示状态 | **是** | `handleLogout` 清空 messages、sessions、meta、`sessionReady`、`persistActiveSessionId(null)` 等 |
| `credentials: "include"` | **是** | `auth-client.ts` 中 auth 请求；`/new-rag/ask-stream` 的 `fetch` 含 `credentials: "include"`；`chat-session-api` 通过 `apiFetch` 默认携带 Cookie |

---

## 6. localStorage 迁移

| 检查项 | 结论 | 依据摘要 |
|--------|------|----------|
| 会话列表来自后端 | **是** | `apiListSessions()` → `GET /chat/sessions`，`refreshSessionsList` |
| 消息历史来自后端 | **是** | `GET /chat/sessions/{id}` → `apiGetSessionMessages`，bootstrap 与切换会话均拉详情 |
| 不同账号不共享「历史数据源」 | **是（数据面）** | 正文与列表均在服务端按用户隔离；浏览器侧 **不再读取** `legal-ai-chat-sessions-v1` |
| `active_session_id` 失效恢复 | **是** | 仅存 `legal-ai-active-session-id-v1`；bootstrap 若存储 id 无效或详情失败，则刷新列表后选首条或新建会话 |

**说明**：`active_session_id` 仍为**浏览器维度**，同一浏览器先后登录不同账号时，本地可能残留上一账号的 id 字符串；首次加载会通过服务端校验并纠正，**不会**把另一账号的会话内容当作数据源。

---

## 7. 模拟测试（需在浏览器或 API 客户端手动执行）

下列步骤用于验收「账号 ↔ 会话」隔离，建议在**两台浏览器配置文件**或**隐身窗口**交替登录以减少 Cookie 干扰。

1. 用户 **A** 登录 → 进入 `/new-feature-chat` → **新建对话 A1**（应产生服务端会话 id）。
2. **A** 退出登录。
3. 用户 **B** 登录 → 侧边栏应 **看不到 A1**。
4. **B** **新建对话 B1**，退出。
5. **A** 再次登录 → 应 **只看到 A1**，**看不到 B1**。
6. **A** 在浏览器地址栏或开发者工具中 **伪造请求**（或直接调用 API）：对 **B1 的 `session_id`** 请求 `GET /chat/sessions/{B1_id}`（带 A 的 Cookie）→ 预期 **404**（与聊天页内「不能读取」一致）。

**注意**：若仅用同一浏览器、未完全清除 Cookie 就换账号，应先确认已退出并重新登录，避免旧会话 Cookie 影响判断。

---

## 8. 功能回归（建议在联调环境勾选）

| 项 | 说明 |
|----|------|
| `/new-rag/ask-stream` | 登录后流式 NDJSON 仍走原 `page.tsx` 消费逻辑；需带 Cookie，否则 401。 |
| `answer_delta` | 流式阶段仍处理 delta；落库侧设计为**不写**半成品 delta（仅存完整 assistant 一条）。 |
| 多轮上下文 | `buildConversationHistoryForAskStream` 仍基于当前内存 messages；与服务端历史加载一致时需保证切换会话后 messages 已替换。 |
| 停止生成 | `stopGeneration` 仍会中止 fetch；有草稿时 **POST** assistant 说明「可能不完整」。 |
| 动态回答模块 / 引用侧栏 / ActionStepsTable | 组件文件按迭代约束未被改写逻辑栈；验收需在 UI 上目测卡片拆分、引用面板与步骤表是否正常。 |

---

## 部署与测试结论

- **报告路径**：`Legal_AI/docs/sqlite-fixed-account-session-isolation-report.md`
- **compileall / lint / build**：均 **通过**（见文首表）。
- **是否可部署到服务器实测**：**可以**，前提是配置齐全：`AUTH_USERS_JSON`、`AUTH_SESSION_SECRET`、`CHAT_DB_PATH`（或默认路径可写）、`NEXT_PUBLIC_API_BASE_URL`、HTTPS 下 `AUTH_COOKIE_SECURE=true`、CORS 放行前端来源且允许凭证。

---

## 仍建议优化的问题

1. **Git 忽略数据库文件**：为 `Legal_AI/data/*.db` 或具体文件名增加 `.gitignore`，防止提交含用户数据的 SQLite。
2. **`active_session_id` 与用户绑定**：若有同一浏览器多账号切换诉求，可在登录成功后将旧 active id 清空再 bootstrap，进一步减少一次无效请求（当前逻辑已能通过服务端纠正）。
3. **`/kb-update` 等其它路由**：本次验收聚焦登录与聊天链路；知识库作业接口仍可能无登录依赖，若公网暴露需单独加固或网络 ACL。
4. **会话删除 UI**：后端已实现 `DELETE /chat/sessions/{id}`，前端侧可按产品需要接入侧边栏删除入口。
5. **自动化测试**：第 7～8 项建议补充 Playwright / pytest 集成测试，避免仅靠手工回归。

---

*本报告仅描述验收核对结果，不包含代码变更。*
