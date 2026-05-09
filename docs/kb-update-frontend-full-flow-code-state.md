# 知识库更新：前端 + 后端编排 + 爬虫清洗 + 百炼上传 — 完整流程代码状态

**审计日期：** 2026-05-09  
**范围：** `frontend/src/app/kb-update/**`、`frontend/src/services/api.ts`、`frontend/src/types/index.ts`（KB 相关）、`api/kb_update_api.py`、`law_spider/法规爬虫1-5*.py`、百炼上传能力（与 `docs/bailian-upload-capability-check.md` 一致）、`auth/*`、`data/*` 表；**未修改业务代码**，仅新增本报告。  
**说明：** 实际页面路径以仓库为准：`jobs/[jobId]/run`、`jobs/[jobId]/result`（无单独的 `jobs/[jobId]/page.tsx`）。

---

## 一、前端 kb-update 页面

### 1.1 目录与入口

| 路径 | 作用 |
|------|------|
| `/kb-update` | `page.tsx` → `KbUpdateHomeClient`：入口、最近 3 条任务、链到新建/历史 |
| `/kb-update/new` | 选 `law_type`、`storage_root`、`run_mode`（full/step），跳转步骤页 |
| `/kb-update/new/steps` | `StepSelectionClient`：勾选步骤（默认 `DEFAULT_STEPS` = 全部 `STEP_OPTIONS`） |
| `/kb-update/new/config` | `JobConfigClient`：分页/条约参数，**创建任务并跳转 run** |
| `/kb-update/history` | 列表任务（`listKBUpdateJobs`，默认后端 limit=20） |
| `/kb-update/jobs/[jobId]/run` | 自动 `start`，**1.5s 轮询** `getKBUpdateJob`，步骤点 + 日志 |
| `/kb-update/jobs/[jobId]/result` | 单次拉取任务详情，步骤耗时、**推导的输出路径**、失败建议 |

### 1.2 对照用户关心的 19 项

| # | 能力 | 代码结论 |
|---|------|----------|
| 1 | 入口 | **有**（侧栏若配置则可达；根 layout 无登录守卫） |
| 2 | 新建任务 | **有** |
| 3 | 选择步骤 | **有**（条约类型隐藏 `law_index_update`） |
| 4 | storage_root、law_type、分页等 | **有**；百炼 **chunk/parser/env** 不在前端配置，依赖服务端 `.env` + 爬虫5 |
| 5 | 启动任务 | **有**：配置页 `createKBUpdateJob` 后跳转 run；run 页自动 `startKBUpdateJob` |
| 6 | 取消 | **有**（RUNNING 时 `stopKBUpdateJob`） |
| 7 | 历史 | **有**（仅列表，无分页参数） |
| 8 | 单 job 日志 | **有**（日志在 `job.logs`，无独立 `/logs` API） |
| 9 | 轮询 | **有**（run 页 1500ms） |
| 10 | 每步成功/失败/跳过 | **有**（`step_progress`） |
| 11 | 子进程日志 | **有**（后端写入 `job.logs` 行） |
| 12 | 上传结果 | **部分**：结果页展示 **`aliyun_upload_report.json` 路径未列出**；仅提示清洗产物路径；上传脚本路径一则 **错误**（见第四节） |
| 13 | 失败重试入口 | **无**（不可对同一 job 再 start；需新建任务） |
| 14 | 继续失败步骤 | **无**（后端不支持续跑） |
| 15 | full_run / step_run | **UI 可选**，但 **`JobConfigClient` 创建请求始终传 `run_mode: "step_run"`**，与向导第一步冲突（见第二节） |
| 16 | 「重复上传自动覆盖」误导 | **无明示覆盖承诺**；但未提示「追加上传可能重复」（见第六节） |
| 17 | 上传前校验入口 | **无** |
| 18 | 定时配置入口 | **无** |
| 19 | 管理员入口 | **无** |

### 1.3 前端已有 / 缺失 / 对齐 / 误导 / 下一步

- **已有：** 新建→步骤→参数→创建→监控（轮询 + 停）→结果；清洗产物路径提示（含 `law_master.jsonl`、`clean_report.txt`）；条约分页/PDF。  
- **缺失：** `run_mode` 真正下发、`credentials: include`、401 区分、列表分页、校验报告、定时、管理员门禁、重试/续跑、`aliyun_upload_report.json` 展示、失败文件清单从报告读取。  
- **与后端字段：** 请求体字段名 **snake_case** 与 FastAPI **一致**；**`run_mode` 前端发送值与向导不一致**。  
- **误导性文案示例：**  
  - 首页：「支持一键全流程、分步执行、**失败重试**与历史复用」—— **无失败重试 API**；「历史复用」链接 **未带参数**，并非真正复制配置。  
  - 结果页失败建议：「可使用 **仅重试失败步骤**」—— **后端无此能力**。  
  - `STEP_OPTIONS` 中 `env_check` 描述「网络可达性」—— 后端 **仅 `mkdir`**。  
- **前端最应补：** **修正 `run_mode` 提交**；**百炼增量/重复风险提示**；**上传校验脚本结果展示**（若后续加脚本）。

---

## 二、前端 API 封装（`frontend/src/services/api.ts`）

| 项 | 状态 |
|----|------|
| `/kb-update/jobs` POST | **有** `createKBUpdateJob` |
| GET `/kb-update/jobs` | **有** `listKBUpdateJobs`（**无** `limit`/`offset` 查询参数） |
| GET `/kb-update/jobs/{id}` | **有** `getKBUpdateJob` |
| POST `.../start`、`.../stop` | **有** |
| getLogs 单独封装 | **无**（日志在 job 内） |
| `credentials` | **未设置**（默认 `same-origin`）；与 `new-feature-chat` 使用的 **`credentials: "include"`** 不一致；**kb-update 请求不携带会话 Cookie** |
| 401 / 500 | **统一** `!resp.ok` → `throw Error`，正文拼接；**无**结构化 `detail` 解析 |
| 超时 | **无** `AbortSignal` 默认超时（调用方可传 `signal`） |

**契约：** `KBCreateJobRequest` 与后端 `CreateJobRequest` **字段一致**。  
**风险：** 若未来给 `/kb-update` 加 Cookie 鉴权，必须 **`credentials: "include"`**，否则 **loading 正常但 401**（当前后端 **未鉴权**，故暂未暴露）。

---

## 三、后端 `kb_update_api.py`

| # | 项 | 结论 |
|---|-----|------|
| 1–5 | CRUD 路由 | **有**：`POST /jobs`、`POST .../start|stop`、`GET /jobs`、`GET /jobs/{id}` |
| 6 | 独立日志接口 | **无** |
| 7 | 状态落库 | **有**：`kb_jobs`、`kb_job_steps`、`kb_job_logs` |
| 8 | 步骤级状态 | **有** |
| 9 | 失败重试 | **无** |
| 10 | 从失败继续 | **无**；`SUCCESS`/`FAILED`/`CANCELLED` **不可再 start** |
| 11 | 定时 | **无** |
| 12 | `run_mode` 生效 | **`_run_job` 未读取 `job.run_mode`**，与背景文档一致 |
| 13 | stdout/stderr | stderr **合并到 stdout** 管道；按 **行** `readline` 写入日志 |
| 14 | 退出码 | 非 0 → `RuntimeError`，job **FAILED** |
| 15 | `storage_root` 校验 | **仅** `mkdir(parents=True)`，无路径白名单 |
| 16 | 路径注入 | 子进程 **cwd** 为脚本目录；参数进 stdin；**无 shell**；风险主要在 **主机路径任意写** |
| 17 | 鉴权 | **无** `Depends(get_current_user)` |
| 18 | 仅 admin | **无** |

---

## 四、爬虫 1–5 与前端衔接

### 4.1 脚本仍依赖 `input()`？

**是。** 五支脚本均以 **`input()`** 为主要交互；`/kb-update` 通过 **`stdin` 写入预置行**（`_build_interactive_input`）模拟输入。

### 4.2 参数如何传入

- **爬虫 1 / 条约分支：** `law_type`、`storage_root`、`start_page`/`end_page` 或条约参数。  
- **爬虫 2、3、4：** `law_type` + `storage_root` + 空行（规避脚本 3 续传询问）。  
- **爬虫 5：** `law_type` + `storage_root` + **多行空字符串**，以便在无交互时用 **`.env`**。

### 4.3 前端配置是否都能传到脚本

- **能：** `law_type`、`storage_root`、`start/end_page`、`treaty_start_page`、`download_pdf`、所选 **steps**（决定跑哪几步）。  
- **不能直接配置：** 百炼 **Workspace/Index/Chunk**（靠服务器环境变量与爬虫5目录下 `.env`）。

### 4.4 产物路径与前端展示

- **`JobConfigClient` / 结果页** 使用 **`{storage_root}/法规爬虫/{类型中文}/清洗产物/...`**，与爬虫 4/5 中 **`DIC` + 目录名** 一致。  
- **`law_master.jsonl`、`clean_report.txt`：** 前端 **文字列出路径**；**不读取文件内容**。  
- **`aliyun_upload_report.json`：** 爬虫 5 写入清洗产物目录；**前端结果页未列出该文件**。

### 4.5 失败定位

- **日志：** 后端收集脚本 **stdout 行**；爬虫 5 失败时 summary 在报告 JSON 内，**前端未解析**。  
- **结果页** `buildOutputItems` 中 **`上传执行脚本` 路径为 `${storage_root}/法规爬虫5-上传阿里云知识库.py`** — **与仓库真实路径 `law_spider/法规爬虫5-上传阿里云知识库.py` 不符**，易误导排查。

### 4.6 中文路径 / Windows

- 前端默认展示 **`e:\LegalData`** 风格；后端文本模式 **UTF-8**；子进程 **Windows** 下路径含空格依赖用户输入正确引用 — **无额外转义层**。

---

## 五、上传前校验

- **`scripts/validate_kb_export.py`：** **不存在**（`scripts/` 仅见 `generate_password_hash.py`）。  
- **`/kb-update` 流程：** **未调用**任何校验脚本。  
- **结论：** 清单 1–11 **均为缺失**；建议后续新增脚本 + 可选接入编排或结果页。

---

## 六、百炼能力与前端表达（结合 `docs/bailian-upload-capability-check.md`）

| 事实 | 前端是否明确说明 |
|------|------------------|
| Lease + AddFile + SubmitIndexAddDocumentsJob | **未**逐条说明 |
| 无 GetIndexJobStatus / List / Delete | **未**说明 |
| 无幂等、无 kb_upload_records | **未**说明 |
| 重复运行高风险重复文档 | **未**提示 |
| 不自动覆盖旧文档 | **未**提示 |

**误导排查：** 首页/结果页 **未写「自动覆盖」**；但 **「失败重试」「仅重试失败步骤」** 与真实能力不符，易让用户以为可 **无损重跑覆盖**。

**后端是否支撑覆盖：** **否**（无 Delete / 无替换逻辑）。

**建议 UI 文案方向：** 「每次上传会在百炼 **新增文件并入索引**；**不会自动删除**旧版本；重复执行可能 **重复检索**；如需替换需在控制台或后续对接删除 API。」

---

## 七、结构化库

- **`data/legal_kb_structured.db`、law_documents / law_articles / kb_chunks / kb_upload_records：** **未发现**。  
- **当前主线：** **Markdown + `law_master.jsonl`** + `aliyun_upload_report.json`（磁盘）。  
- **`kb_upload_records`：** 建议 **独立** 于 `kb_update.db`（任务编排）；前端可在有 API 后再展示。

---

## 八、权限与账号

| 项 | 结论 |
|----|------|
| kb-update 前端需登录 | **否**（无 `middleware`、layout 未校验） |
| kb-update 后端需登录 | **否**（router **无** `Depends(get_current_user)`） |
| 登录用户是否都能创建任务 | **任意客户端** 可调 API（若 URL 可达） |
| `AuthUserRecord` | **无** `role` 字段 |
| 权限风险 | **高**：未授权可触发 **长时间子进程 + 本机路径写入 + 百炼上传**（若服务端配置了 AK） |

**建议：** 优先 **`Depends(get_current_user)` + `require_admin`**（需扩展 `AUTH_USERS_JSON` 或等价配置）。

---

## 九、定时任务

- **cron / APScheduler / `run_kb_update_daily.py`：** **无**。  
- **前端定时配置：** **无**。  
- **能否安全接定时：** **当前不安全** — 缺少 **上传幂等 / 去重 / 旧版下线**（见既有审计）；定时只会放大重复与费用风险。

**阻塞点：** 幂等与百炼侧 **Delete/List/Job 状态**；其次 **管理员权限**。

---

## 十、最终建议（分步，与指令对齐）

| 步 | 内容 | 主要改动面 | 对问答影响 | 风险 | 百炼依赖 | 前端 |
|----|------|------------|------------|------|----------|------|
| 1 | 上传前校验 + 展示 | 新 `scripts/validate_kb_export.py`；可选 API；结果页链接 | 无 | 低 | 无 | 建议加区块 |
| 2 | `kb_upload_records` + 幂等 | 爬虫5 + DB；可能读 List API | 无（仅上传） | 中 | 需 List/元数据 | 可选状态页 |
| 3 | GetIndexJobStatus 闭环 | 爬虫5 或独立 worker | 无 | 中 | 是 | 可选进度 |
| 4 | List + Delete 旧版下线 | 爬虫5 + 合规删除流程 | **有**（索引内容变） | 高 | 是 | 提示文案 |
| 5 | kb-update admin | `auth` + router Depends | 无 | 中 | 否 | 保护路由 |
| 6 | 定时 | cron 或 APScheduler | 依上传策略 | 中–高 | 依步骤 2–4 | 可选 |
| 7 | 结构化法规库 | 新 DB + ETL | 间接 | 高 | 可选 | 长期 |

---

## 执行命令结果

在 `Legal_AI` 下：

```bash
python -m compileall api config services new_feature_qwen_kb law_spider scripts auth chat_store
```

**退出码：0**

在 `Legal_AI/frontend` 下：

```bash
npm run lint
npm run build
```

**退出码：0**（Next.js 16.2.1 构建成功）。

---

## 输出摘要（指令要求的一条列表）

1. **报告路径：** `Legal_AI/docs/kb-update-frontend-full-flow-code-state.md`  
2. **前端 kb-update 当前能力：** 见第一节 — 基本 **创建/配置/启动/轮询/停/历史/结果**，缺 **真实 run_mode、校验、定时、权限、重试、上传报告解析**。  
3. **前后端接口是否对齐：** **字段名对齐**；**`run_mode` 业务语义不对齐**（前端配置页 **固定 `step_run`**）。  
4. **当前是否能安全定时自动上传：** **否**（无定时 + 无幂等 + 重复风险）。  
5. **重复上传风险：** **高**（百炼侧无应用层去重；重复跑任务即重复 AddFile）。  
6. **管理员权限风险：** **有**（前后端均未限制 kb-update）。  
7. **推荐下一步优先：** **（A）修正 `run_mode` 与误导文案** + **（B）上传前校验脚本 + 结果展示**；并行规划 **admin 依赖** 与 **kb_upload_records**。  
8. **compileall / lint / build：** **均通过**。
