# 第 7 步：ListIndexDocuments + dry-run + DeleteIndexDocument 测试执行综合验收报告

**报告路径：** `Legal_AI/docs/kb-old-version-delete-acceptance-report.md`

**证据工件（仓库内）：**

| 工件 | 路径 |
|------|------|
| 删除后审计快照 | `data/bailian_index_documents_audit_after_delete_test.json`（`generated_at_utc`: 2026-05-11T01:11:38Z） |
| 删除后 dry-run 计划 | `data/bailian_old_version_delete_plan_after_delete_test.json`（`generated_at_utc`: 2026-05-11T01:12:12Z） |
| 删除执行报告（测试） | `data/bailian_old_version_delete_execute_report_test.json`（`generated_at_utc`: 2026-05-11T01:09:16Z） |

**结论概要：** 第 7 步（代码与设计 + 上述测试工件）**已完成**。删除后复核 **通过**。在默认「dry-run 优先、不默认执行删除」前提下 **可以进入第 8 步**（管理页接入）。构建链：**compileall / lint / build 均已通过**（见文末）。

---

## 一、第 7.1 ListIndexDocuments 映射

| # | 检查项 | 结论 | 依据 |
|---|--------|------|------|
| 1 | 是否能拉取远端 Index 文档 | **通过** | `kb_upload_store/bailian_index_documents.py` 中 `list_all_index_documents` 分页调用 `list_index_documents_with_options`。删除后审计中 `total_remote_documents`/`total_fetched` 为 **724**，表明已成功拉取列表。 |
| 2 | 是否能将本地 `kb_upload_records` 与远端文档匹配 | **通过** | `compute_document_matches` 对本地行与扁平化远端文档做贪心匹配；`scripts/audit_bailian_index_documents.py` 聚合输出 `matched_count` 等字段。 |
| 3 | 是否确认 `remote.Id` 与本地 `bailian_file_id` 可对齐 | **通过** | 审计快照中 6 条匹配均为 `match_method`: **`A_remote.Id_eq_local.bailian_file_id`**，且 `local_bailian_file_id` 与 `remote_document_id` 字符串一致。 |
| 4 | 是否未调用 DeleteIndexDocument | **通过** | `audit_bailian_index_documents.py` 文档字符串与 JSON `note` 均声明只读；模块 `bailian_index_documents.py` 顶部说明不提供 Delete。 |

---

## 二、第 7.2 dry-run 删除预览

| # | 检查项 | 结论 | 依据 |
|---|--------|------|------|
| 1 | 是否只处理 managed-only 范围 | **通过** | `plan_bailian_old_version_delete.py` 仅允许 `--scope managed-only`；`plan_old_version_delete_dry_run(..., managed_only=True)` 且非 managed-only 直接报错。报告字段 `scope`: **`managed-only`**。 |
| 2 | 是否只处理本地 `kb_upload_records` 中存在的 law_id | **通过** | 实现按本地 `law_id` 分组迭代（`by_law`），仅对这些 law 构造 `law_groups`。删除后计划中 `managed_law_count` **6** 与本地 6 条一致。 |
| 3 | 是否能按 bbbs 找到同法规重复远端文档 | **通过** | `parse_bbbs_from_law_id` + 按 law 收敛远端子集；每组 `reason` 中含「bbbs 命中…」说明。执行报告中删除的 `remote_document_name` 均含同一 bbbs 片段，与「同法规历史重复」一致。 |
| 4 | 是否正确生成 keep_documents | **通过** | 每组含 `keep_documents`；删除后计划中每组仅保留 1 条 FINISH 对应远端，`keep_count` **6**。 |
| 5 | 是否正确生成 delete_candidates | **通过** | 执行前计划（引自执行报告 `source_plan_path`）对应 **`total_candidates`: 18**；候选仅为各 law 下非保留 FINISH 远端（历史重复）。删除后计划 `delete_candidate_count` **0**。 |
| 6 | 是否没有把所有 unmatched_remote 都列为删除 | **通过** | dry-run 仅在 managed law 的远端子集中生成 `delete_candidates`；718 条量级的一般远端未匹配文档不会自动进入删除候选（审计中 `unmatched_remote_count` 远大于 18）。 |
| 7 | 是否未调用 DeleteIndexDocument | **通过** | `plan_bailian_old_version_delete.py` 与 `plan_old_version_delete_dry_run` 文档明确不写库、不删除；计划 JSON 中 `dry_run`: **true**。 |

---

## 三、第 7.3 测试 Index 删除执行

以 `data/bailian_old_version_delete_execute_report_test.json` 及 `scripts/execute_bailian_old_version_delete.py` 为准。

| # | 检查项 | 结论 | 依据 |
|---|--------|------|------|
| 1 | 是否必须 `--execute` | **是** | 未传 `--execute` 时脚本仅写预览报告（`execute`: false），不调用删除 API。 |
| 2 | 是否必须 `--confirm DELETE_OLD_VERSIONS` | **是** | 执行分支在校验确认短语后才继续；否则退出且不调用 API。 |
| 3 | 是否必须 `--allow-index-id` | **执行删除时必须** | 仅当存在 `--execute` 时校验 `--allow-index-id` 与计划 `index_id` 完全一致，否则拒绝。 |
| 4 | 是否只删除 delete_candidates | **是** | 删除 ID 仅来自 `law_groups[].delete_candidates` 展开且去重。 |
| 5 | 是否不会删除 keep_documents / blocked_candidates | **是** | 执行前对 `delete_candidates` 与 keep/blocked 的 `remote_document_id` 做交集校验，有交集则中止。 |
| 6 | DeleteIndexDocument 是否执行成功 | **是** | `failed_count`: **0**；`batch_results` 两批 `ok`: **true**，`response_code`: **Success**。 |
| 7 | `deleted_count` 是否为 18 | **是** | `deleted_count`: **18**，与 `total_candidates` 一致。 |
| 8 | `failed_count` 是否为 0 | **是** | `failed_count`: **0**，`failed_documents` 为空数组。 |
| 9 | 执行报告是否完整 | **是** | 含 `generated_at_utc`、`index_id`、`execute`、`total_candidates`、计数、`deleted_documents`、`failed_documents`、`skipped_documents`、`source_plan_path`，以及分批 **`batch_results`**。 |

---

## 四、删除后复核

基于 `data/bailian_index_documents_audit_after_delete_test.json` 与 `data/bailian_old_version_delete_plan_after_delete_test.json`：

| # | 检查项 | 目标 | 实际 | 结论 |
|---|--------|------|------|------|
| 1 | `matched_count` 仍为 6 | 6 | **6** | **通过** |
| 2 | `unmatched_local_count` 为 0 | 0 | **0** | **通过** |
| 3 | `delete_candidate_count` 变为 0 | 0 | **0** | **通过** |
| 4 | `keep_count` 为 6 | 6 | **6** | **通过** |
| 5 | 是否没有误删当前保留文档 | 保留的 6 个 `remote_document_id` 仍在索引且列为 keep | 审计中 6 条匹配的 `remote_document_id`（如 `file_a116508f...` 等）与执行报告 `deleted_documents` 中 18 个 ID **无交集**；删除均为历史重复 `file_23501efb...` 等 | **通过** |

---

## 五、仍未建议做的事

当前仍**不建议**：

1. **自动接定时删除**（无人值守批量删索引风险高）。  
2. **生产 Index 自动删除**（需人工选计划、确认 index、环境隔离）。  
3. **上传成功后自动删除旧版本**（易误删、与索引最终一致性行为强耦合）。  
4. **条文级覆盖**（范围与合规边界未单独评审前勿扩展）。

---

## 六、下一步建议

**可以进入第 8 步**：在 kb-update 管理页面接入「旧版本清理」，且 **默认仅展示 dry-run 结果**（或只触发只读计划生成），**不默认执行 DeleteIndexDocument**；执行删除需独立显式操作与确认（与当前 CLI 的 `--execute` + `--confirm` + `--allow-index-id` 精神一致）。

---

## 附录：构建与静态检查结果

在本仓库环境下已执行：

```bash
cd Legal_AI
python -m compileall scripts kb_upload_store law_spider api auth chat_store
```

```bash
cd Legal_AI/frontend
npm run lint
npm run build
```

**结果：** `compileall` 退出码 0；`npm run lint` 退出码 0；`npm run build`（Next.js 16）成功完成。

---

## 交付清单（用户要求输出）

1. **报告路径：** `Legal_AI/docs/kb-old-version-delete-acceptance-report.md`  
2. **第 7 步是否完成：** **是**（与代码、脚本及仓库内测试工件一致）。  
3. **删除后复核是否通过：** **是**（见第四节量化表）。  
4. **是否可以进入第 8 步：** **可以**（在默认仅 dry-run、不默认执行删除的前提下）。  
5. **compileall / lint / build 是否通过：** **均通过**。
