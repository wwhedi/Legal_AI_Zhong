# 第 5 步验收报告：kb_upload_records + law_id / version_hash 幂等跳过

**报告路径：** `Legal_AI/docs/kb-upload-records-idempotency-acceptance-report.md`  
**验收依据：** 当前仓库中 `kb_upload_store` 与 `law_spider/法规爬虫5-上传阿里云知识库.py` 的静态核对；构建命令已在本机执行并记录结果。  
**说明：** 未在验收环境中实际调用百炼 API 做端到端联调；第七节为建议的本地模拟步骤。

---

## 一、上传记录库

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 是否新增 `kb_upload_store` 模块 | **通过。** 存在 `kb_upload_store/__init__.py`、`db.py`、`models.py`、`service.py`。 |
| 2 | 是否使用独立 SQLite：`data/legal_kb_structured.db` | **通过。** `get_kb_upload_db_path()` 默认 `LEGAL_KB_STRUCTURED_DB` 未设置时为 `Legal_AI/data/legal_kb_structured.db`（相对路径相对项目根解析）。 |
| 3 | 是否新增 `kb_upload_records` 表 | **通过。** `db.py` 中 `CREATE TABLE IF NOT EXISTS kb_upload_records`。 |
| 4 | 表字段是否包含所列 14 项 | **通过。** 与需求字段一致（`id` … `updated_at`）。 |
| 5 | 是否有 `UNIQUE(law_id, version_hash)` | **通过。** |
| 6 | 是否有必要索引 | **通过。** `idx_kb_upload_records_law_id`、`idx_kb_upload_records_status`。 |

---

## 二、law_id / version_hash 规则

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | `law_id` 是否优先取 `bbbs` | **通过。** 非空则 `bbbs:{值}`。 |
| 2 | `bbbs` 不存在时是否取 `doc_id` | **通过。** `doc_id:{值}`。 |
| 3 | 都不存在时是否有稳定兜底 | **通过。** `file:{sha256(文件名)}`（UTF-8，`errors='replace'`）。 |
| 4 | `version_hash` 是否优先取 `content_sha256` | **通过。** 行内非空则直接用。 |
| 5 | `content_sha256` 不存在时是否计算文件 sha256 | **通过。** `sha256_file(export_file_path)`。 |

---

## 三、幂等跳过逻辑

上传前对每个 `upload_file_path` 结合 master 行计算 `law_id`、`version_hash`，查询 `kb_upload_records`，由 `should_skip_upload` 判断：`upload_status ∈ {"UPLOADED","INDEX_SUBMITTED","FINISH"}` 时跳过。

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 是否按 `law_id + version_hash` 查询 | **通过。** `fetch_record(law_id, version_hash, …)`。 |
| 2 | 上述三态是否跳过该文件 | **通过。** 在 `upload_cleaned_files_to_bailian` 中 `continue`，不进入租约/上传循环。 |
| 3 | 跳过时是否不再调用 `ApplyFileUploadLease`、`AddFile` | **通过。** 跳过分支在整段上传逻辑之前返回。 |
| 4 | 跳过的文件是否不再进入本轮 `uploaded_file_ids` | **通过。** 故不会进入本轮 `SubmitIndexAddDocumentsJob` 的 `file_ids` 列表。 |
| 5 | `FAILED` / `PARSE_FAILED` / `INDEX_ERROR` 是否允许重新上传 | **通过（逻辑等价）。** 代码以「仅三态跳过」为准；其余状态（含所列失败态与无记录）均会走正常上传。`UPLOAD_RETRY_STATUSES` 在 `service.py` 中定义为文档化常量，与跳过集合互补。 |

**说明：** `SubmitIndexAddDocumentsJob` 在本脚本中为**按批次**一次提交 `uploaded_file_ids`；被跳过的文件不会出现在该列表中。若**全部**文件被跳过，主流程显式不调用该接口（见兼容性第三节）。

---

## 四、上传后记录

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | `AddFile` 成功后是否写入 `bailian_file_id` | **通过。** `upsert_after_add_file`。 |
| 2 | 是否写入 `upload_status="UPLOADED"` | **通过。** |
| 3 | `SubmitIndexAddDocumentsJob` 后是否写入 `bailian_job_id` | **通过。** `update_after_index_submitted`（从响应中 `extract_bailian_job_id` 解析，可能为空字符串）。 |
| 4 | 是否写入 `upload_status="INDEX_SUBMITTED"` | **通过。** |
| 5 | 是否写入 `index_status="SUBMITTED"` | **通过。** |
| 6 | 失败时是否记录 `last_error` | **通过。** 上传失败 `upsert_after_upload_failure`、解析失败 `update_after_parse_failure`、索引阶段 `update_after_index_error`；成功路径会清空 `last_error`（置 `NULL`）。 |

**补充：** 未配置 Index 时，解析成功后调用 `update_after_parse_success_terminal`，将 `upload_status` 置为 `FINISH`、`index_status` 为 `PARSE_SUCCESS`，与「仅 UPLOADED 长期悬挂」的规避设计一致。

---

## 五、报告输出（aliyun_upload_report.json）

| 序号 | 字段 | 结论 |
|------|------|------|
| 1 | `total_master_files` | **通过。** |
| 2 | `uploaded_count` | **通过。**（与 `uploaded` 同值） |
| 3 | `skipped_count` | **通过。** |
| 4 | `failed_count` | **通过。**（与 `failed` 同值） |
| 5 | `skipped_records` | **通过。** |
| 6 | `upload_records_db_path` | **通过。** |

---

## 六、兼容性

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 原有 `uploaded_file_ids` 是否仍保留 | **通过。** 返回字典仍含该字段；仅本轮实际上传的 file id 会加入。 |
| 2 | 原有上传成功路径是否仍可用 | **通过。** 无 master 幂等参数时逻辑仍可走原目录扫描路径（本脚本主流程固定走 `law_master.jsonl`，与改造前一致）。 |
| 3 | 全部跳过是否不调用 `SubmitIndexAddDocumentsJob` | **通过。** `elif index_id and not summary.get("uploaded_file_ids")` 分支打印说明并跳过提交。 |
| 4 | 无 `law_master.jsonl` 是否保持原错误逻辑 | **通过。** 仍由 `load_upload_entries_from_master` / 原 `load_upload_files_from_master` 等价约束抛出 `RuntimeError`，禁止目录扫描回退。 |
| 5 | 是否未调用 `DeleteIndexDocument` | **通过。** 仓库内 `*.py` 无 `DeleteIndexDocument` 引用。 |
| 6 | 是否未接入定时 | **通过。** 无定时相关改动。 |
| 7 | 是否未改变 RAG 问答逻辑 | **通过。** 第 5 步仅新增 `kb_upload_store` 与爬虫 5 脚本；未改 `new_feature_qwen_kb`、`services` 中 RAG 链路等。 |

---

## 七、建议进行的本地模拟测试

以下需在已配置百炼凭证与 `BAILIAN_*` 环境、且已生成 `law_master.jsonl` 与清洗文件的环境中执行。

1. **第一次运行爬虫 5**  
   - 预期：正常走租约 → 上传 → 解析；`legal_kb_structured.db` 中 `kb_upload_records` 新增行；`aliyun_upload_report.json` 中 `uploaded_count`（或 `uploaded`）大于 0，`skipped_count` 为 0（无历史记录时）。  

2. **第二次使用同一 `law_master.jsonl`（未改 `content_sha256` / 文件内容导致 version 不变）**  
   - 预期：`skipped_count > 0`，`uploaded_count == 0`；控制台出现「幂等跳过」日志；`uploaded_file_ids` 为空则不会调用 `SubmitIndexAddDocumentsJob`；百炼侧不应为同一版本再次产生新的本地上传记录（AddFile 分支未进入）。  

3. **修改某条对应的导出 Markdown 或 master 行中的 `content_sha256`**  
   - 预期：`version_hash` 变化，视为新版本，应重新上传并在库中形成新的 `(law_id, version_hash)` 行（在 `law_id` 不变的前提下）。  

**数据库自检（可选）：**  
`sqlite3 data/legal_kb_structured.db "SELECT law_id, version_hash, upload_status, bailian_file_id FROM kb_upload_records LIMIT 20;"`

---

## 八、仍未实现能力

当前实现**仍未包含**（与第 5 步范围一致，未在本次交付）：

1. `GetIndexJobStatus`  
2. `ListIndexDocuments`  
3. `DeleteIndexDocument`  
4. 自动删除百炼旧版本  
5. 定时自动上传  
6. 条文级更新覆盖（仍为「法规文件 + 版本哈希」粒度幂等）

---

## 九、下一步建议：是否进入第 6 步（GetIndexJobStatus 闭环）

| 问题 | 结论 |
|------|------|
| 是否可以进入第 6 步 | **可以进入设计与实现阶段**；与本地 `kb_upload_records` 正交，可在写入 `bailian_job_id` 后轮询任务状态并回写 `index_status` / `upload_status`。 |
| 是否有阻塞 | **无来自第 5 步的硬阻塞**；依赖百炼 OpenAPI 是否稳定暴露任务 ID 与状态字段、以及 SDK 版本兼容性。 |
| 是否建议先做本地模拟测试 | **建议。** 至少覆盖第七节三类场景，避免在生产 Index 上误提交重复任务。 |
| 是否建议先在测试 Index 上跑 | **建议。** 索引任务与解析参数强相关，测试 Index 可降低对生产知识库的影响。 |

---

## 十、构建与静态检查（用户指定命令）

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

**结果：通过**（`eslint` 与 `next build` 均成功）。

---

## 汇总表（用户要求输出）

| 项目 | 内容 |
|------|------|
| 1. 报告路径 | `Legal_AI/docs/kb-upload-records-idempotency-acceptance-report.md` |
| 2. 第 5 步是否完成 | **已完成**（与代码与设计目标一致） |
| 3. 是否可有效避免同版本重复上传 | **可有效避免**（在 `law_id`/`version_hash` 稳定且库记录与百炼侧一致的前提下；百炼侧历史重复不受本表约束） |
| 4. 是否存在高风险问题 | **整体风险可控。** 需知悉边界：`upload_status=UPLOADED` 即参与跳过；若在「已 AddFile、尚未落库或尚未完成解析」的极窄窗口异常中断，理论上可能出现行为与预期不一致，概率低，可通过第七节回归降低。 |
| 5. 是否可以进入第 6 步 | **可以** |
| 6. compileall / lint / build | **均已通过** |
