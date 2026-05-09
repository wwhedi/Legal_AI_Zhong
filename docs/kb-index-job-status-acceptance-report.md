# 第 6 步验收报告：GetIndexJobStatus 索引任务状态闭环

**报告路径：** `Legal_AI/docs/kb-index-job-status-acceptance-report.md`  
**验收方式：** 对照需求与当前仓库实现（`law_spider/法规爬虫5-上传阿里云知识库.py`、`kb_upload_store/service.py`）静态核对；已执行用户指定 `compileall`、`eslint`、`next build`。  
**说明：** 未在验收环境对真实百炼账号做端到端联调；第八、九节含建议的手动验证步骤。

---

## 一、GetIndexJobStatus 接入

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 是否在 `law_spider/法规爬虫5-上传阿里云知识库.py` 中接入 GetIndexJobStatus | **通过。** 定义 `get_index_job_status()`，内部调用 `get_index_job_status_with_options`，请求体为 `GetIndexJobStatusRequest`（`index_id`、`job_id`），与 `alibabacloud_bailian20231229` 一致。 |
| 2 | 是否能从 SubmitIndexAddDocumentsJob 响应中解析 `bailian_job_id` | **通过。** 沿用 `extract_bailian_job_id(job_resp)`；解析为空时进入 `SKIPPED_NO_JOB_ID` 分支，不轮询。 |
| 3 | SDK 不支持时是否有明确降级 | **通过。** `Client` 无 `get_index_job_status_with_options` 或调用报 `RuntimeError`（含 SDK/缺少等）时：`index_job_poll_status` 为 `SDK_UNSUPPORTED_OR_ERROR`，日志说明升级 pip；**不抛死主流程**，库内保持 `INDEX_SUBMITTED` / `SUBMITTED`。 |
| 4 | 是否没有硬编码错误接口 | **通过。** 使用官方 SDK 方法与模型类，无手写 HTTP 路径拼接。 |
| 5 | 是否没有影响原有上传流程 | **通过。** 租约、`AddFile`、解析轮询、`SubmitIndexAddDocumentsJob` 原路径保留；轮询仅在提交成功且配置允许时追加执行。 |

---

## 二、轮询配置

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | `BAILIAN_INDEX_JOB_POLL_ENABLED` | **通过。** `os.getenv(..., "true")`，经 `_parse_bailian_bool_default_true`：`false`/`0`/`no`/`off` 关闭，否则开启。 |
| 2 | `BAILIAN_INDEX_JOB_POLL_INTERVAL_SECONDS` | **通过。** 默认 `"10"`，代码 `max(3, int(...))`。 |
| 3 | `BAILIAN_INDEX_JOB_POLL_TIMEOUT_SECONDS` | **通过。** 默认 `"1800"`，代码 `max(30, int(...))`。 |
| 4 | 默认值是否合理 | **合理。** 与需求一致；下限避免过短间隔或过短总超时导致无意义抖动。 |

---

## 三、状态映射

**说明：** 上传阶段成功后库内会先出现 `upload_status=UPLOADED`（第 5 步）；本节侧重 **索引任务闭环** 阶段的 `upload_status` / `index_status` 变化。

| 验收项 | 结论 |
|--------|------|
| `upload_status` 集合（闭环相关） | **覆盖：** `INDEX_SUBMITTED`（提交后至终止前）、`FINISH`（成功结束）、`INDEX_ERROR`（任务失败或文档 `INSERT_ERROR`）。**超时**时按设计 **保持 `INDEX_SUBMITTED`**，仅 `index_status=TIMEOUT` 与 `last_error` 记录原因。 |
| `index_status` 集合 | **覆盖：** `SUBMITTED`（`_apply_index_outcome` 写入）、`RUNNING`（轮询中任务为 `PENDING`/`RUNNING`/`PROCESSING` 或空态时）、`FINISH`（成功）、`INSERT_ERROR`（文档级）、`FAILED`（任务级 `FAILED`/`ERROR`）、`TIMEOUT`、`UNKNOWN`（文档未知状态）。 |

**逐项确认：**

1. **FINISH / SUCCESS / COMPLETED → `upload_status=FINISH`？**  
   **通过（任务完成 + 文档级）。** 任务级 `Data.Status ∈ {COMPLETED,SUCCESS,FINISH}` 时调用 `_apply_index_job_completed_to_records`：匹配到的文档若状态为 `FINISH`/`SUCCESS`/`COMPLETED` 则 `update_record_index_finish`（`upload_status=FINISH`，`index_status=FINISH`）；未在 `Documents` 中出现的文件默认视为成功并 `FINISH`（任务已标记完成时的兜底）。

2. **INSERT_ERROR / FAILED / ERROR → `upload_status=INDEX_ERROR`？**  
   **通过。** 文档 `INSERT_ERROR` → `update_after_index_error(..., index_status="INSERT_ERROR")`（`upload_status=INDEX_ERROR`）。任务级 `FAILED`/`ERROR` → 对批次内记录 `update_after_index_error(..., index_status="FAILED")`（`upload_status=INDEX_ERROR`）。

3. **PENDING / RUNNING / PROCESSING → `index_status=RUNNING`？**  
   **通过。** 上述任务态下调用 `update_records_index_running`：`upload_status` 仍为 `INDEX_SUBMITTED`，`index_status=RUNNING`。

4. **超时 → `index_status=TIMEOUT`？**  
   **通过。** `update_record_index_timeout`：`index_status=TIMEOUT`，`last_error` 写入超时说明；`upload_status` **保持 `INDEX_SUBMITTED`**（与第 6 步需求一致）。

---

## 四、kb_upload_records 回写

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | Submit 后是否先 `INDEX_SUBMITTED` / `SUBMITTED` | **通过。** `_apply_index_outcome_to_kb_upload_records` 成功路径调用 `update_after_index_submitted`。 |
| 2 | 轮询中是否更新 `RUNNING` | **通过。** `update_records_index_running`。 |
| 3 | 轮询成功是否 `FINISH` / `FINISH` | **通过。** `update_record_index_finish`（及文档级成功分支）。 |
| 4 | 轮询失败是否 `INDEX_ERROR` | **通过。** 任务失败与文档 `INSERT_ERROR` 均写 `INDEX_ERROR`（见第三节）。 |
| 5 | 超时是否记录 `last_error` | **通过。** `update_record_index_timeout` 写入截断后的超时说明。 |
| 6 | 是否只回写本批次实际上传/参与索引的记录 | **通过（语义）。** `_index_success_batch_pairs` 取自 `details` 中 `success==True` 且非「纯 `skipped`」的行，**包含 `reuse_for_index`**，与本轮 `uploaded_file_ids` 参与 Submit 的集合一致；**幂等 `full_skip` 行无 `success` 参与索引**，不会被写入。 |
| 7 | 幂等跳过是否不被本轮覆盖 | **通过。** `idempotent_skip` 行 `skipped=True` 且无 `reuse_for_index`，不进入 `_index_success_batch_pairs`；`_apply_index_outcome` 亦 `continue` `skipped` 行。 |

---

## 五、报告输出（aliyun_upload_report.json）

| 序号 | 字段 | 结论 |
|------|------|------|
| 1 | `index_job_poll_enabled` | **通过。** |
| 2 | `index_job_poll_status` | **通过。** 含 `TERMINAL_OK`、`TERMINAL_FAILED`、`TIMEOUT`、`DISABLED`、`SKIPPED_NO_JOB_ID`、`SDK_UNSUPPORTED_OR_ERROR`、`NOT_APPLICABLE`、`NO_FILES_NO_SUBMIT`、`SUBMIT_FAILED_NO_POLL`、`ERROR` 等。 |
| 3 | `index_job_poll_started_at` | **通过。** 轮询函数内设置；部分短路径下可为空字符串。 |
| 4 | `index_job_poll_finished_at` | **通过。** |
| 5 | `index_job_poll_attempts` | **通过。** |
| 6 | `index_job_poll_last_error` | **通过。** |
| 7 | `index_job_final_status` | **通过。** |
| 8 | `index_job_status_raw` | **通过。** 为截断 JSON 文本（约 2000 字符）。 |

**补充（非第五节清单）：** 报告中另有 `reused_for_index_count`（复用 `file_id` 参与索引条数）。

---

## 六、错误处理

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 轮询失败不导致已上传记录丢失 | **通过。** 轮询仅 `UPDATE`；不删除表行；不重新走 `AddFile`。 |
| 2 | 网络错误是否重试/继续轮询 | **通过。** 一般异常与部分 `RuntimeError` 捕获后 `sleep(interval)` 继续循环直至超时或 SDK 硬错误早退。 |
| 3 | 超时不会重新 AddFile | **通过。** 超时分支仅 DB `TIMEOUT` 与报告字段。 |
| 4 | 超时不会重新 SubmitIndex | **通过。** 无二次提交逻辑。 |
| 5 | `job_id` 为空是否 `SKIPPED_NO_JOB_ID` | **通过。** |
| 6 | 轮询失败不会自动重复上传 | **通过。** |

---

## 七、幂等跳过联动（相对第 5 步）

**已调整：** 爬虫 5 使用 `classify_upload_skip(require_index_submission=will_submit_index)`，不再仅用「`UPLOADED` 一律跳过」。

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | `FINISH` 是否跳过 | **是。** `full_skip`。 |
| 2 | `INDEX_SUBMITTED` 是否跳过 | **是。** `full_skip`（避免重复 Submit 批次）。 |
| 3 | `UPLOADED` 是否还跳过 | **分情况。** 未配置 Index：仍 `full_skip`（与仅上传终态一致）。配置 Index：有 `bailian_file_id` 且无 `bailian_job_id` → **`reuse_file`**（不重复 `AddFile`，`file_id` 进入本轮 Submit）；有 `job_id` → `full_skip`。 |
| 4 | Index + 仅 `UPLOADED` 无 `job_id` 是否合理 | **通过。** `reuse_file` 路径避免「已上传却永远不再入索引」。 |
| 5 | 是否避免「已上传未入索引却永远跳过」 | **显著缓解。** 上述 `reuse_file` 覆盖主场景。 |

**残余边界（建议知晓）：** 若记录已为 `INDEX_SUBMITTED` 但上轮轮询 **超时**（`upload_status` 仍为 `INDEX_SUBMITTED`，`index_status=TIMEOUT`），当前 `classify_upload_skip` 仍视为 `full_skip`，**不会**自动再次 Submit；需人工处理 DB 或后续产品化「仅重提索引」能力。

---

## 八、仍未实现能力

当前 **仍未实现**：

1. `ListIndexDocuments`  
2. `DeleteIndexDocument`  
3. 自动删除百炼旧版本  
4. 定时自动上传  
5. 条文级更新覆盖  

---

## 九、建议本地 / 测试 Index 验证方式

1. **第一次上传新版本：** 配置 `BAILIAN_INDEX_ID`、清洗产物与 `law_master.jsonl`，运行爬虫 5；确认 `AddFile`、解析、`SubmitIndexAddDocumentsJob` 成功。  
2. **观察 `INDEX_SUBMITTED`：** 在 `legal_kb_structured.db` 的 `kb_upload_records` 中，`upload_status=INDEX_SUBMITTED`、`index_status=SUBMITTED`。  
3. **轮询到 `FINISH`：** 默认 `BAILIAN_INDEX_JOB_POLL_ENABLED=true`，等待 `index_job_poll_status=TERMINAL_OK`，库内 `upload_status=FINISH`、`index_status=FINISH`。  
4. **检查 `kb_upload_records`：** `bailian_job_id`、`last_error`、`updated_at` 与报告一致。  
5. **第二次同版本：** 应 `full_skip` 或正常幂等跳过，`skipped_count` 上升；不应重复 `AddFile`。  
6. **模拟 poll disabled：** 设 `BAILIAN_INDEX_JOB_POLL_ENABLED=false`，报告 `DISABLED`、`index_job_final_status=SUBMITTED_ONLY`，库内保持 `INDEX_SUBMITTED`。  
7. **模拟 `job_id` 为空：** 人为构造或拦截响应使 `extract_bailian_job_id` 为空；报告 `SKIPPED_NO_JOB_ID`，库内仍为提交阶段写入的状态。  
8. **模拟超时或失败：** 将 `BAILIAN_INDEX_JOB_POLL_TIMEOUT_SECONDS` 设为较小值或制造任务失败；分别验证 `TIMEOUT`（`index_status=TIMEOUT`）与 `TERMINAL_FAILED` / 文档 `INSERT_ERROR`（`INDEX_ERROR`）。

---

## 十、下一步建议（是否进入第 7 步）

**第 7 步议题：** `ListIndexDocuments` + `DeleteIndexDocument` 旧版本下线。

| 问题 | 结论 |
|------|------|
| 是否可以进入第 7 步 | **可以进入方案与开发设计阶段**；与第 6 步轮询正交，但依赖百炼侧列表/删除 API 与业务规则（删错风险）。 |
| 是否有阻塞 | **无来自第 6 步代码的硬阻塞**；**软阻塞**为：删除策略、审计、与 `kb_upload_records` 的一致性、以及生产权限。 |
| 是否建议先在测试 Index 验证第 6 步 | **强烈建议。** |
| 是否建议先人工确认百炼后台文档状态 | **建议。** 对照 `GetIndexJobStatus` 与控制台文档状态，校验 `DocId`/`FileId` 对齐逻辑。 |
| 是否建议先不要接定时 | **建议。** 删除与定时耦合风险高，宜在手动跑通后再考虑。 |

---

## 十一、构建与静态检查

已执行：

```text
cd Legal_AI
python -m compileall api config services new_feature_qwen_kb law_spider scripts auth chat_store kb_upload_store
```

**结果：通过**（exit code 0）。

```text
cd Legal_AI/frontend
npm run lint
npm run build
```

**结果：通过。**

---

## 汇总表（用户要求输出）

| 项目 | 内容 |
|------|------|
| 1. 报告路径 | `Legal_AI/docs/kb-index-job-status-acceptance-report.md` |
| 2. 第 6 步是否完成 | **已完成**（与当前实现一致） |
| 3. 是否可确认索引任务最终状态 | **在 SDK 正常、能解析 `job_id`、且轮询开启的前提下可确认**；报告字段 `index_job_poll_status` / `index_job_final_status` + 库内 `upload_status`/`index_status` 形成闭环。降级路径下保持 `INDEX_SUBMITTED` 仅表示「已提交未验证」。 |
| 4. 是否存在高风险问题 | **整体中等偏低风险。** 需关注：`DocId`/`FileId` 与本地 `file_id` 对齐误差、未知任务态长期重试至超时、`INDEX_SUBMITTED`+`TIMEOUT` 不自动重提索引（见第七节）。 |
| 5. 是否可以进入第 7 步 | **可以**，但建议完成第九节测试并在测试 Index 上验证后再动删除类 API。 |
| 6. compileall / lint / build | **均已通过** |
