# 第 6.5 步：测试 Index 中 GetIndexJobStatus 闭环 — 人工测试报告

**报告路径：** `Legal_AI/docs/kb-index-job-status-test-index-smoke-report.md`  
**性质：** 人工冒烟 / 回归检查单（本仓库未代跑真实百炼调用；下列「实测结果」须由测试人员在**独立测试 Workspace + 测试 Index** 中填写）。  
**关联实现：** 第 6 步（`法规爬虫5-上传阿里云知识库.py` + `kb_upload_store`）。

---

## 测试元信息（必填）

| 项 | 填写 |
|----|------|
| 测试日期 | *［待填写］* |
| 测试人 | *［待填写］* |
| 百炼 WorkspaceId（可脱敏） | *［待填写］* |
| **测试 Index ID**（须与生产 Index 隔离） | *［待填写］* |
| 数据根目录 / `law_master.jsonl` 路径 | *［待填写］* |
| **测试使用的法规文件数量**（master 去重后条数 / 实际上传批次数） | *［待填写］* |
| 本地上传库路径 | 默认 `Legal_AI/data/legal_kb_structured.db`（或 `LEGAL_KB_STRUCTURED_DB`） |

---

## 1. 环境变量检查

在运行爬虫 5 前，确认（建议在 `Legal_AI/law_spider/.env` 或进程环境中）：

| 变量 | 要求 | 实测 |
|------|------|------|
| `BAILIAN_WORKSPACE_ID` | 已设置且与控制台一致 | *［待填写］* |
| `BAILIAN_INDEX_ID` | **指向测试 Index**，非生产 | *［待填写］* |
| `BAILIAN_INDEX_JOB_POLL_ENABLED` | 场景 A：`true`；场景 5：`false` | *［待填写］* |
| `BAILIAN_INDEX_JOB_POLL_INTERVAL_SECONDS` | 可选，默认 `10`（代码侧最小 3） | *［待填写］* |
| `BAILIAN_INDEX_JOB_POLL_TIMEOUT_SECONDS` | 可选，默认 `1800`（代码侧最小 30） | *［待填写］* |
| 其他 | `BAILIAN_LAW_TYPE`、`BAILIAN_BASE_PATH`、`BAILIAN_CATEGORY_ID` 等与现网一致 | *［待填写］* |

**指导：** 在测试 Index 验证期间，勿将 `BAILIAN_INDEX_ID` 指到生产知识库；必要时单独建「测试用」Category / Index 并在控制台记录 ID。

---

## 2. 第一次上传新版本（轮询开启）

**前置：** `BAILIAN_INDEX_JOB_POLL_ENABLED=true`（或未设置，默认为开启）。

**操作：** 在 `Legal_AI` 下按现有方式运行 `law_spider/法规爬虫5-上传阿里云知识库.py`（或经 kb-update 任务触发同一脚本，与本地习惯一致即可）。

| 检查项 | 如何确认 | 实测（通过/失败 + 备注） |
|--------|----------|---------------------------|
| AddFile 是否成功 | 控制台无批量上传失败；`summary.uploaded` / `uploaded_count` > 0；或失败时有 `failed_details` | *［待填写］* |
| 解析是否成功 | `parse_success` 与预期一致；失败见 `failed_details` | *［待填写］* |
| SubmitIndexAddDocumentsJob 是否成功 | 无 `submit_index_add_documents_job_error`；控制台有成功日志 | *［待填写］* |
| 是否解析到 `bailian_job_id` | `extract_bailian_job_id` 非空；报告中非 `SKIPPED_NO_JOB_ID`（若为空见第 6 节） | *［待填写］* |
| `aliyun_upload_report.json` | 存在 `index_job_poll_enabled`、`index_job_poll_status`、`index_job_poll_started_at`、`index_job_poll_finished_at`、`index_job_poll_attempts`、`index_job_poll_last_error`、`index_job_final_status`、`index_job_status_raw` | *［待填写］* |

**第一次上传结果摘要（必填）：**

- 报告路径：`*［清洗产物目录下 aliyun_upload_report.json 绝对或相对路径］*`  
- `index_job_poll_status`：`*［如 TERMINAL_OK / TIMEOUT / …］*`  
- `index_job_final_status`：`*［如百炼返回的 COMPLETED 等］*`  

---

## 3. 轮询状态与库表

**SQLite 示例（按需调整路径）：**

```sql
-- 替换为本次涉及的 law_id 或全表抽查
SELECT law_id, version_hash, upload_status, index_status, bailian_file_id, bailian_job_id, last_error, updated_at
FROM kb_upload_records
ORDER BY updated_at DESC
LIMIT 20;
```

| 检查项 | 预期 | 实测 |
|--------|------|------|
| Submit 后是否出现 `INDEX_SUBMITTED` / `index_status=SUBMITTED` | 是 | *［待填写］* |
| 轮询过程中是否出现 `index_status=RUNNING`（`upload_status` 仍为 `INDEX_SUBMITTED`） | 通常至少一次（取决于轮询抓取时机） | *［待填写］* |
| 成功结束时是否 `upload_status=FINISH`、`index_status=FINISH` | 是 | *［待填写］* |

---

## 4. 第二次同版本运行（幂等）

**操作：** 不修改 `law_master.jsonl` 中对应条的 `content_sha256` / 导出文件内容，再次运行爬虫 5。

| 检查项 | 预期 | 实测 |
|--------|------|------|
| 是否幂等跳过（或 `reuse_file` 仅补索引场景） | 对已 `FINISH` 的行应 `full_skip`，不重复 AddFile | *［待填写］* |
| 是否不重复 AddFile | 控制台无对新文件租约上传；`uploaded_count==0` 或仅新文件 | *［待填写］* |
| 是否不重复 SubmitIndex（无新 `uploaded_file_ids` 时） | 日志提示跳过 Submit；`NO_FILES_NO_SUBMIT` 或等价 | *［待填写］* |
| `skipped_count` 是否增加 | 相对第一次应明显增加 | *［待填写］* |

**第二次幂等跳过结果摘要：** *［待填写：skipped_count、uploaded_count、是否调用 SubmitIndex］*

---

## 5. 关闭轮询测试

**操作：** 设置 `BAILIAN_INDEX_JOB_POLL_ENABLED=false`，使用**新任务或新文件**（或清空/调整测试库记录后）再跑一轮，避免与第 2 节状态混淆。

| 检查项 | 预期 | 实测 |
|--------|------|------|
| 报告 `index_job_poll_status` | `DISABLED`；`index_job_final_status` 可为 `SUBMITTED_ONLY` | *［待填写］* |
| 库内是否保持 `INDEX_SUBMITTED` / `SUBMITTED` | 无轮询则不应自动变 `FINISH` | *［待填写］* |
| 上传主流程 | AddFile / 解析 / Submit 行为与轮询无关，仍应可用 | *［待填写］* |

---

## 6. 异常边界（可选专项）

在**测试 Index** 上按需选做，避免污染生产。

| 场景 | 如何构造 | 预期 | 实测 |
|------|----------|------|------|
| `job_id` 为空 | 极少见；依赖响应被截断或解析失败 | 报告 `SKIPPED_NO_JOB_ID`；库保持提交阶段写入或错误分支 | *［可选］* |
| 超时 | 将 `BAILIAN_INDEX_JOB_POLL_TIMEOUT_SECONDS` 设为较小值 | `index_job_poll_status=TIMEOUT`；`index_status=TIMEOUT`；`upload_status` 仍为 `INDEX_SUBMITTED`；**不会**自动再次 AddFile / Submit | *［可选］* |
| 任务失败 | 依赖百炼侧返回 `FAILED` / 文档 `INSERT_ERROR` | `INDEX_ERROR` 等；**不会**自动重复上传 | *［可选］* |

---

## 7. 汇总输出（报告末尾结论区）

### 7.1 测试 Index ID

*［填写测试用 `BAILIAN_INDEX_ID`，可脱敏保留前后各 4 位］*

### 7.2 测试使用的法规文件数量

*［填写 master 行数 / 上传文件数］*

### 7.3 第一次上传结果

*［简述：成功/失败；`index_job_poll_status`；是否 FINISH］*

### 7.4 第二次幂等跳过结果

*［简述：`skipped_count`、`uploaded_count`、是否未再 Submit］*

### 7.5 kb_upload_records 查询结果

*［粘贴关键行或截图说明；至少包含一轮 FINISH 样例］*

### 7.6 aliyun_upload_report.json 关键字段

*［粘贴片段：`index_job_poll_*`、`uploaded_file_ids` 长度、`skipped_count` 等］*

### 7.7 是否可以进入 DeleteIndexDocument 旧版本下线设计

**结论（在未填实测前为原则性意见）：**  
若本节 2–4 在**测试 Index** 上均通过，且已人工对照百炼控制台文档/任务状态与库表一致，则可**启动第 7 步方案设计**（含删除范围、幂等、回滚与权限）。  
若任一项失败，应先修环境/SDK/参数或修代码，再进入删除类能力。

*［实测后勾选：］* ☐ 可以进入设计 ☐ 暂缓（原因：___）

### 7.8 是否存在阻塞

**原则性说明：** 第 6.5 步本身**不引入代码阻塞**；阻塞通常来自——未准备测试 Index、凭证/配额、网络、或 `job_id` 解析异常。  
*［实测填写：］* ☐ 无阻塞 ☐ 有阻塞（说明：___）

---

## 附：控制台与日志建议核对点

- 百炼控制台：对应 Index 的**导入任务**是否从进行中到完成。  
- 本机：`aliyun_upload_report.json` 与 `legal_kb_structured.db` 时间戳、`bailian_job_id` 是否一致。  
- 勿在生产 Index 上刻意制造 `FAILED`/超时，除非已变更隔离环境。

---

*本文件为模板；填写完成后即视为第 6.5 步人工测试记录。*
