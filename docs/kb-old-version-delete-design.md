# 第 7 步设计审计：ListIndexDocuments + DeleteIndexDocument 旧版本下线

**文档路径：** `Legal_AI/docs/kb-old-version-delete-design.md`  
**性质：** 设计审计与方案说明；**本步不要求实现代码**，且**不调用**百炼删除类 API。  
**前置状态（来自第 6.5 步实测结论）：** `kb_upload_records` 可用；同版本幂等与索引闭环（`TERMINAL_OK` / `FINISH`）已验证。

---

## 检查清单（逐项结论）

### 1. 当前 `kb_upload_records` 是否足够支持旧版本定位

**基本足够做「法规维度 + 版本维度」决策，但不足以单独完成「索引文档主键」删除而无对照。**

现有字段（见 `kb_upload_store/db.py`）：

- `law_id`：法规稳定标识（`bbbs:` / `doc_id:` / `file:` 前缀策略）。
- `version_hash`：版本标识（`content_sha256` 或文件 SHA256）。
- `bailian_file_id`：**数据中心文件侧** AddFile 返回的 Id。
- `bailian_job_id`：索引任务 Id。
- `upload_status` / `index_status`：上传与索引生命周期。
- **缺失（若要做合规下线审计）：** 建议后续扩展 **`bailian_document_id`**（索引内文档主键）、**`deleted_at`**、可选 **`delete_reason`**（设计见第九节）。

结论：**可定位「同一法规的哪几条版本记录」**；**删除 API 所需的「索引文档 Id」需额外字段或 List 映射补齐**（见第 4–6 节）。

### 2. 是否能按 `law_id` 找到同一法规的多个 `version_hash`

**可以。** 表上有 `idx_kb_upload_records_law_id`，业务上按 `law_id` 查询即可得到该法规下所有版本行（每行一条 `(law_id, version_hash)`，`UNIQUE(law_id, version_hash)`）。

### 3. 哪些状态的旧版本允许删除（策略建议）

以下为 **「允许发起 DeleteIndexDocument」** 的**推荐策略**（实现时可配置化）：

| 状态（本地） | 是否建议允许删除索引文档 | 说明 |
|--------------|--------------------------|------|
| `upload_status=FINISH` 且 `index_status=FINISH` | **允许（仅当已判定为「非当前保留版本」）** | 典型「旧版本下线」对象；仍需避免删错「最新一条」。 |
| `upload_status=INDEX_ERROR` | **审慎允许** | 可能已在百炼侧产生失败/残留文档；删除前应 List 核对文档仍存在且 Id 匹配。 |
| 文档级 `INSERT_ERROR`（多存在于任务/列表回报，不一定在本表单行） | **审慎允许** | 优先通过 **ListIndexDocuments** 按 `document_status=INSERT_ERROR` 扫描后定向删除。 |
| `index_status=RUNNING` / 任务仍在进行 | **禁止** | 易导致不一致或与任务并发冲突。 |
| `upload_status=INDEX_SUBMITTED`（未完成闭环） | **默认禁止** | 可能仍在入库；除非人工确认任务已失效且控制台无对应 RUNNING。 |
| `index_status=TIMEOUT` | **默认禁止自动删除** | 本地不知索引实际是否已完成；需人工或 List 复核后再删。 |
| `UPLOADED`（未完成索引） | **一般禁止删「索引文档」** | 可能没有对应索引文档；若误用 List 得到 Id，需单独审计。 |

说明：**INSERT_ERROR** 更多是百炼侧 **文档导入状态**，本地表未必持久化到 `index_status`；清理时建议 **List + 过滤** 为主。

### 4. DeleteIndexDocument 需要的是 file_id、document_id 还是其它字段

依据当前 **alibabacloud_bailian20231229** 模型 **`DeleteIndexDocumentRequest`**：

- **必填 `index_id`**：知识库（Index）主键。
- **必填 `document_ids`**（请求体字段 `DocumentIds`）：**索引内文档的主键 Id 列表**（注释表述为 *primary key IDs of the documents*）。

即：删除接口需要的是 **「索引文档 Id」**，不是笼统的「数据中心 FileId」字段名；是否与 AddFile 的 `file_id` 相同需 **以 List 回报或官方文档为准**，不可在未验证前等同。

### 5. 当前 `bailian_file_id` 是否等同于 DeleteIndexDocument 所需 document_id

**不能在不验证的情况下等同。**

- 本地 `bailian_file_id` 来自 **AddFile / 数据中心文件** 链路。
- SDK 中 **DeleteIndexDocument** 使用的是 **`DocumentIds`**，语义为 **索引文档主键**。
- **ListIndexDocuments** 返回文档对象含 **`Id`**（注释：*primary key ID of the document*），通常这才是 **`DocumentIds`** 应对齐的值。

**推荐：** 在测试 Index 上对同一文件走完上传→索引成功后，调用 **ListIndexDocuments**，比对 **`Id` 与 `SourceId`/`Name`** 与本地 `bailian_file_id` 的对应关系，再固化映射规则或新增存储字段。

### 6. 是否必须先调用 ListIndexDocuments 建立 file_id / document_id 映射

**强烈建议至少首次与周期性以 List 为真相来源之一。**

理由：

- 避免 **`bailian_file_id` ≠ 索引文档 `Id`** 导致删除错误或无效调用。
- 处理 **重复导入**、**控制台手工变更**、**历史脏数据** 时，本地表可能落后于百炼真实文档集合。

可选实现路径：

1. **强依赖 List：** 删除前按 `index_id` 分页拉全量或按过滤条件拉取，构建 `document_Id ↔ source_id/name ↔ 可选 metadata` 映射，再与 `law_id/version_hash` 关联（关联规则需产品设计）。
2. **弱依赖 List：** 在上传/索引闭环成功时，从 **GetIndexJobStatus** 的 **Documents** 中若能稳定拿到 `DocId`，写入 **`bailian_document_id`**，删除时优先用该字段，List 仅做校验/兜底。

### 7. 删除前是否需要 dry-run

**需要。**

建议输出：

- 拟删除的 **`index_id`**、`document_ids` 列表（或对应的 `law_id`/`version_hash`）。
- 每条记录在百炼 List 中的 **当前 status**（`FINISH` / `INSERT_ERROR` / …）。
- **明确排除「保留版本」**（见第 11–12 节）。

dry-run **不调删除 API**，仅打印或写审计文件。

### 8. 删除前是否需要 admin 二次确认

**需要（生产）；测试 Index 可降低为单次确认或仅限运维脚本开关。**

与现有 **kb-update 仅 admin** 一致：删除属于高风险操作，建议：

- 后端：**admin + 显式确认 token / 二次 POST body `confirm=DELETE_OLD_VERSIONS`**。
- 前端（若做）：独立「清理旧版本」向导，展示 dry-run 结果后再提交。

### 9. 删除后如何回写 `kb_upload_records`

当前表 **无 `deleted_at`**，若实施删除闭环，建议 **迁移扩展**：

| 字段 | 建议 |
|------|------|
| `deleted_at` | ISO 时间戳；非空表示索引文档已从当前 Index 删除（或已发起删除且确认成功）。 |
| `upload_status` | 可设为 **`DELETED`**（新建枚举）或保留 `FINISH` 另依 `deleted_at` 判断；需统一产品语义。 |
| `index_status` | 可设为 **`DELETED`** 或与百炼 **`DELETED`** 对齐（List 中文档状态亦有 `DELETED`）。 |
| `last_error` | 成功删除可清空或写简短说明；失败写 API message / request_id。 |

**注意：** 若保留 `(law_id, version_hash)` 行仅作审计，可不清物理行，仅用 **`deleted_at` + 状态** 标记。

### 10. 删除失败如何记录 `last_error`

- 单次删除失败：**追加或覆盖 `last_error`**（建议包含 **HTTP/Code/Message/RequestId** 截断文本）。
- **`deleted_at` 保持空**，**不改变为已成功删除**。
- 可选：`failed_delete_attempts` 计数（需schema）。

### 11. 如何避免误删当前最新版本

**必须引入「保留策略」：**

- **按 `law_id` 分组**，对 `version_hash` 做 **全序**（例如：优先 **`updated_at`** / **`uploaded_at`**，辅以 **`gmt_modified`（来自 List）**，再不济用 **`content_sha256` 字典序**——需在设计上写明优先级）。
- **默认删除：** 「同一 `law_id` 下除保留集合外的所有 FINISH 版本」。
- **默认保留：** **最新 1 条**（可配置 **保留最近 K 个版本**，见第 12 节）。
- **人工白名单：** `law_id` 维度禁止自动清理。

### 12. 是否需要保留最近一个历史版本

**建议默认 `K=2`（当前最新 + 上一版本）或至少 `K=1`（仅最新）。**

- **K=1：** 最激进，仅适合磁盘/索引极度敏感且能接受不可回滚的场景。
- **K=2：** 常见「可回滚上一版」需求。

应为 **可配置**，且在 dry-run 中明示「将删除几条、保留几条」。

### 13. 是否只允许测试 Index 先验证

**强烈建议第一阶段仅允许测试 IndexId（配置 allowlist / 环境门禁）。**

- 与第 6.5 步一致：先在 **隔离 Index** 验证 List→Delete→本地回写→检索副作用。
- 生产启用需 **单独变更审批 + admin + dry-run 归档**。

### 14. 是否需要单独的「清理旧版本」按钮，而不是自动删除

**建议：单独入口 + 禁止默认自动删除。**

- **不参与定时任务**（与用户约束一致）。
- UI：**kb-update 子页「清理旧版本」** 或运维脚本 `--dry-run` / `--execute`。
- **禁止**在上传成功链路中默默删除旧版（除非未来明确产品需求且二次确认）。

---

## 汇总输出（审计结论）

### 1. 当前是否具备删除旧版本的最小条件

**不完全具备。**  
已有：**法规/版本维度记录 + IndexId + 文件侧 Id + 索引任务闭环**。  
尚缺：**索引文档主键与本地行的可靠绑定**、**删除后字段（如 `deleted_at`、`bailian_document_id`）**，以及 **经测试 Index 验证过的 Id 映射规则**。

### 2. 是否必须先补 ListIndexDocuments

**不是绝对「必须先」，但是工程上强烈建议作为真相校验与映射构建的核心能力。**  
至少：**上线前在测试 Index 上用 List 校验 `DocumentIds` 与本地字段对应关系**。

### 3. DeleteIndexDocument 需要哪些参数

（以当前 SDK 为准）

- **`index_id`**（IndexId）
- **`document_ids`**：`DocumentIds` 数组，元素为 **索引文档主键 Id**

### 4. 推荐删除策略

1. **范围：** 按 `law_id` 分组，只对「非保留版本」且本地状态 **已达终态（优先 FINISH）** 的条目候选删除。  
2. **禁止：** `RUNNING`、`INDEX_SUBMITTED`（未闭环）、`TIMEOUT` 默认自动删。  
3. **映射：** List（分页）或闭环时写入 `bailian_document_id`；删除前 dry-run。  
4. **权限：** admin + 二次确认；测试 Index allowlist。  
5. **入口：** 独立清理动作，不接定时、不接上传主链路。

### 5. dry-run 方案

- 输入：`index_id`、保留策略 K、可选 `law_id` 过滤。  
- 输出：候选删除列表（本地 `law_id/version_hash` + 百炼 `document Id` + List 中 status），**不调用 Delete**。  
- 可选：落盘 JSON 审计。

### 6. 风险点

- **`bailian_file_id` 与 `DocumentIds` 混用**导致删错对象。  
- **重复导入**导致同一法规多文档，仅凭本地一行无法覆盖全部索引文档。  
- **删除与检索并发**：用户正在问答时删除段落索引。  
- **INDEX_SUBMITTED/TIMEOUT** 误判删运行时文档。  
- **生产误配置 IndexId**：allowlist 与双人复核可降低风险。

### 7. 下一步代码实现建议（不在本步落地）

1. Schema：`bailian_document_id`、`deleted_at`（及可选计数/原因）。  
2. 闭环增强：在 **GetIndexJobStatus COMPLETED** 且 Documents 含 **DocId** 时写入 `bailian_document_id`（需实测字段对齐）。  
3. 服务模块：`list_index_documents_paginated`、`delete_index_documents_batch`（封装 SDK）、**dry-run 纯内存**。  
4. API：**admin-only**；`POST .../dry-run`、`POST .../execute` + 确认 body。  
5. 前端：**kb-update** 下独立页面或脚本文档说明。  
6. **仅测试 Index**  Feature flag，直至映射与策略签字。

### 8. 声明

**本文档仅为设计审计；未修改业务代码；未调用 DeleteIndexDocument 或其它删除 API。**
