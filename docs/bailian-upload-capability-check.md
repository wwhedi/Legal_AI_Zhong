# 百炼上传脚本 — 稳定增量更新能力检查

**审计日期：** 2026-05-09  
**范围：** `law_spider/法规爬虫5-上传阿里云知识库.py`（及同文件内调用的 `apply_upload_lease`、`add_file_by_lease`、`upload_file_to_presigned_url`、`describe_file`、`submit_index_add_documents_job`、`upload_cleaned_files_to_bailian`、`main`）；全仓库检索是否另有百炼 Index/Document Job 相关调用。  
**结论前置：** 当前脚本 **不满足**「稳定增量更新」所需的幂等、去重、旧版下线与索引任务状态闭环；适合 **全量或人工管控频率** 的上传，重复执行 **高风险产生重复侧文档/向量条目**。

---

## 检查项结果

| # | 检查项 | 结论 |
|---|--------|------|
| 1 | `ApplyFileUploadLease` / `AddFile` | **已调用。** `apply_upload_lease` → `apply_file_upload_lease_with_options`；`add_file_by_lease` → `add_file_with_options`（`AddFileRequest`）。 |
| 2 | `SubmitIndexAddDocumentsJob` | **已调用。** `submit_index_add_documents_job` → `submit_index_add_documents_job_with_options`。 |
| 3 | `GetIndexJobStatus` | **未调用。** 仓库内无对应 SDK 方法调用；索引任务提交后 **不轮询** Job 状态。 |
| 4 | `ListIndexDocuments` | **未调用。** 无法基于代码枚举 Index 内已有文档。 |
| 5 | `DeleteIndexDocument` | **未调用。** 无删除 Index 文档逻辑。 |
| 6 | 区分 `file_id` 与 index `document_id` | **未明确区分。** 脚本收集并使用 **`file_id`**（`AddFile` 返回）；`SubmitIndexAddDocumentsJobRequest` 上亦设置 `file_ids` / `document_ids` 等字段（SDK 兼容赋值），**未**在后续逻辑中单独保存或对比「Index 中的 document_id」。 |
| 7 | 是否记录 `job_id` | **未结构化记录。** `SubmitIndexAddDocumentsJob` 的完整响应写入 `summary["submit_index_add_documents_job"]`（并落盘 `aliyun_upload_report.json`），但 **无** 专门解析、持久化 **`JobId`** 字段供轮询；也 **无** `GetIndexJobStatus` 消费该 ID。 |
| 8 | 是否记录 `upload_status` | **部分等价，非统一枚举。** 单文件维度有 **`parse_status`**（如 `PENDING`、`PARSE_SUCCESS`、`PARSE_FAILED`、`TIMEOUT`）及 **`success`**；无与百炼 Index 任务一致的 **`RUNNING` / `FINISH` / `INSERT_ERROR`** 等 **索引入库**状态表或字段。 |
| 9 | `law_id` + `version_hash` 幂等跳过 | **不支持。** 无本地或远端对比逻辑；每次运行对 master 列表中的路径一律上传。 |
| 10 | 删除旧版本 | **不支持。** 无 Delete API、无按法规替换策略。 |
| 11 | 重复上传是否导致重复文档 | **高风险会。** 每次 `AddFile` 产生 **新** `file_id`，再提交 `SubmitIndexAddDocumentsJob`；**无**去重，**极可能在同一 Index 中累积多份相同/相近内容**（具体以百炼侧策略为准，应用层未防）。 |
| 12 | 当前知识库是否为「文档搜索类」 | **代码层面：** 使用 **`DATA_CENTER_FILE`**（可 env 覆盖）、**Index**、`chunk_mode`/`separator`/`chunk_size`，属于 **文件上传 → 解析 → 入知识库索引** 的路径，与 **Retrieve/RAG** 用法一致（见 `services/aliyun_kb_service.py`）。**不能**仅凭脚本断言控制台里产品套餐名称，但 **不是**「仅关键词、无向量」的狭义网页搜索；实为 **文档型知识库 + 切片检索** 模型。 |
| 13 | `RUNNING` / `FINISH` / `INSERT_ERROR` / `DELETED` | **未处理（索引任务维）。** 脚本对 **`describe_file`** 返回的 **文件解析**状态处理 **`PARSE_SUCCESS` / `PARSE_FAILED` / `FAILED`** 等；**未**对 Index 入库任务状态做轮询，故 **不涉及** 上述索引 Job 状态枚举。若 **`DELETED`** 指文件/文档删除态，脚本 **未**查询或处理。 |

---

## 当前已支持能力

- **上传链路：** 租约申请 → 预签名 PUT/POST → `AddFile` → 轮询 **`DescribeFile`** 直至解析成功或失败/超时。  
- **入索引：** 配置 `BAILIAN_INDEX_ID` 时，对 **`uploaded_file_ids`** 调用 **`SubmitIndexAddDocumentsJob`**，并传入 **regex 切块**相关参数；失败时对 HTTP/`Code` 做 **退避重试**（`BAILIAN_INDEX_JOB_RETRY`）。  
- **可追溯产物：** `aliyun_upload_report.json` 含 `uploaded_file_ids`、`details`、`submit_index_add_documents_job` 等；**不**写入应用 SQLite。  
- **解析侧状态：** 单文件的 **`parse_status`** 与成功计数，便于发现解析失败。

---

## 当前缺失能力

| 类别 | 缺失内容 |
|------|----------|
| 索引任务闭环 | **`GetIndexJobStatus`**（或等价）：不知入库是否 **`FINISH`** 或 **`INSERT_ERROR`**，无法在脚本内判定「可检索」。 |
| 增量与幂等 | **`ListIndexDocuments`**、与 **`law_id`/`version_hash`** 对比、**跳过已入库且未变**的对象。 |
| 版本替换 | **`DeleteIndexDocument`**（或删除数据中心文件 + 再入库）、**旧版下线**。 |
| 概念分层 | 持久化并区分 **数据中心 `file_id`** 与 **Index 内文档 ID**（若 API 返回），便于精确删除。 |
| 状态模型 | 索引任务 **`RUNNING`/`FINISH`/`INSERT_ERROR`** 与文件 **`PARSE_*`** 未统一；无 **`upload_status`** 跨阶段状态机。 |

---

## 哪些缺失会导致「重复上传」

1. **无 `law_id` + `version_hash` 幂等** → 同一法规重复跑流水线会 **多次 AddFile + SubmitIndex**，重复风险最高。  
2. **无 `ListIndexDocuments`（或等价）去重** → 无法在脚本侧发现「已存在同名/同内容文档」。  
3. **无索引 Job 成功准则**（缺 **`GetIndexJobStatus`**）→ 可能误以为需重跑整批，加剧重复提交（尤其在部分失败场景下人工重试）。

---

## 哪些缺失会导致「旧版本残留」

1. **无 `DeleteIndexDocument`（或从 Index 移除文档）** → 新版本文件入库后，**旧 `file_id` 对应条目通常仍留在 Index**，除非在控制台或别的 API 手动清理。  
2. **无按法规 ID 的替换策略** → 无法保证「一部法规只保留一条最新切片集合」。  
3. **无文档级 inactive/archived** → 应用层未实现。

---

## 推荐下一步先补什么

**优先级 1（最小闭环 + 减重复）：**

1. 调用 **`GetIndexJobStatus`**（若 Submit 响应含 JobId，先解析落库），轮询至 **`FINISH`** 或 **`INSERT_ERROR`**，避免盲目重跑整批。  
2. 增加 **`ListIndexDocuments`**（或控制台约定 + 本地 `kb_upload_records` 表）记录 **`index document_id` / `file_id` / `law_id` / `content_sha256`**，实现 **「hash 未变则跳过」**。  

**优先级 2（解决旧版残留）：**

3. 在确认幂等与映射关系后，新增 **`DeleteIndexDocument`**（或产品文档推荐的删除路径），对 **同一 `law_id` 仅保留最新 `file_id` 对应文档。

以上均可先做 **不影响现有问答** 的侧车存储（SQLite/JSON），再逐步接入爬虫 5 的主流程。

---

## 附：与「稳定增量更新」的差距一句话

当前脚本实现的是 **「批量上传 + 文件解析 + 提交建索引任务」**，**不是** **「可验证、可去重、可替换」的增量管线**。
