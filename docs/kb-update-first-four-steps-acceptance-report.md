# kb-update 前四步改造 — 综合验收报告

**报告路径：** `Legal_AI/docs/kb-update-first-four-steps-acceptance-report.md`  
**验收方式：** 对照需求逐项核对当前仓库实现（静态代码审查），并执行 `compileall`、`eslint`、`next build`。  
**说明：** 未在本机执行完整浏览器端到端流程（新建任务 → 轮询 → 取消等）；以下「功能回归」结论以路由与调用链一致性为主，上线前建议用 admin 账号做一次人工 smoke。

---

## 一、第 1 步：前端流程修复

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | `run_mode` 是否按用户选择传递，而非固定 `step_run` | **通过。** `JobConfigClient` 中 `run_mode` 为 `isRunMode(runMode) ? runMode : "full_run"`，与 URL 传入的 `runMode` 一致后提交 `createKBUpdateJob`（`new/config/page.tsx` 将 `runMode` 从 query 传入客户端）。 |
| 2 | 是否移除「失败重试 / 仅重试失败步骤」等误导性文案 | **通过。** `kb-update` 下已无「仅重试失败步骤」类表述；首页与结果页改为明确说明「不支持同一任务内续跑失败步骤、需新建任务」等。 |
| 3 | 是否增加百炼「追加导入、不自动覆盖、重复执行可能重复检索」提示 | **通过。** `new/page.tsx` 有简要说明；参数页在勾选上传步骤（`hasKbUpload`）时展示「百炼知识库上传说明」三条（追加导入、重复检索、后续优化方向）。 |
| 4 | kb-update 相关 API 是否已加 `credentials: "include"` | **通过。** `frontend/src/services/api.ts` 中统一 `request()` 对 `fetch` 设置 `credentials: "include"`，覆盖创建/启动/停止/查询任务及校验摘要接口。 |
| 5 | 结果页是否展示 `law_master.jsonl`、`clean_report.txt`、`aliyun_upload_report.json` | **通过。** `jobs/[jobId]/result/page.tsx` 的 `outputItems` 包含上述路径说明（另含上传目录、校验报告路径等）。 |
| 6 | 上传脚本路径是否已修正（不再错误指向 `storage_root` 下脚本） | **通过。** 上传脚本展示为仓库相对路径 `law_spider/法规爬虫5-上传阿里云知识库.py`，而非数据根目录下的假路径。 |

---

## 二、第 2 步：admin 权限

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | `AUTH_USERS_JSON` 是否支持 `role` 字段 | **通过。** `auth/config.py` 中 `AuthUserRecord` 含 `role`，校验失败信息中已列明 `role`。 |
| 2 | `role` 缺失时是否默认 `user` | **通过。** `Field(default="user")` + `normalize_role`（空值或非 `admin`/`user` 均归为 `user`）。 |
| 3 | `/auth/me` 是否返回 `role` | **通过。** `UserPublic` 含 `role`；`me` 使用 `to_public_user`，其中包含 `"role": record.role`。 |
| 4 | 是否实现 `require_admin` | **通过。** `auth/dependencies.py` 中 `require_admin`：未登录 401，非 admin 403。 |
| 5 | `/kb-update` 后端所有接口是否已加 admin 限制 | **通过。** `kb_update_api.py` 中 `POST /jobs`、`POST .../start`、`POST .../stop`、`GET /jobs`、`GET .../validate-report-summary`、`GET .../{job_id}` 均依赖 `require_admin`。 |
| 6 | 未登录访问 `/kb-update` 是否跳转 `/login` | **通过。** `kb-update/layout.tsx` 中 `fetchMe()` 无用户时 `router.replace('/login?next=...')`。 |
| 7 | 普通 user 访问 `/kb-update` 是否显示无权限 | **通过。** `me.role !== "admin"` 时 `gate === "forbidden"`，展示「无权限 / 仅管理员可访问知识库更新」。 |
| 8 | admin 用户是否可正常进入 `/kb-update` | **通过。** `role === "admin"` 时渲染子路由（需 `.env` 中至少一名用户配置 `"role": "admin"`，属运维前提）。 |
| 9 | 前端是否不会给普通用户显示创建任务入口 | **通过。** 整个 `/kb-update` 树由 layout 门禁；`src` 内无指向 `kb-update` 的站外导航，普通用户无法进入该 UI，故看不到「新建任务」等入口。 |

---

## 三、第 3 步：上传前校验脚本

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 是否新增 `scripts/validate_kb_export.py` | **通过。** |
| 2 | 是否支持 `--master` | **通过。** `required=True`。 |
| 3 | 是否支持 `--export-dir` | **通过。** `required=True`。 |
| 4 | 是否支持 `--output` | **通过。** `required=True`。 |
| 5 | 是否支持 `--strict` | **通过。** `action="store_true"`。 |
| 6 | 是否能校验 `law_master.jsonl` | **通过。** `validate_master()` 读 master 并产出 master 侧 issue。 |
| 7 | 是否能校验 Markdown 切片 | **通过。** 对 `--export-dir` 下 `*.md` 逐文件 `validate_markdown_file()`。 |
| 8 | 是否能发现所列数据质量问题 | **通过（代码级）。** 脚本含：`chunk.url_id_break_space`、`chunk.body_has_source_or_url`（正文混入 URL/source 线索）、重复条号相关（如 `chunk.duplicate_article_in_chapter`、`_duplicate_article_tokens_in_chapter`）、`chunk.empty_body`、`chunk.invalid_date`、`chunk.non_active_law_status` / `chunk.invalid_effective_status`（非现行/已废止等，与 `strict` 联动 severity）等；具体命中取决于真实数据。 |
| 9 | 是否输出 JSON 报告 | **通过。** 写入 `--output` 指定路径，`json.dumps(..., indent=2)`。 |
| 10 | strict 模式下有 error 是否 exit 1 | **通过。** `if args.strict and error_count > 0: return 1`。 |

---

## 四、第 4 步：结果页展示校验报告

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1 | 结果页是否能展示 `validate_report.json` 的摘要 | **通过。** 调用 `GET /kb-update/jobs/{job_id}/validate-report-summary`，展示解析后的摘要区块。 |
| 2 | 是否展示 `total_chunks`、`warning_count`、`error_count`、`allow_upload`、报告路径 | **通过。** 与 `KBValidateReportSummaryResponse` 及结果页 UI 字段一致。 |
| 3 | 报告不存在时是否显示「未执行上传前校验」 | **通过。** 文案为「未执行上传前校验（在清洗产物目录未找到 validate_report.json）。」，并可有「预期路径」。 |
| 4 | 是否暂时没有强制阻断上传 | **通过。** 结果页说明「不会阻断任务与百炼上传流程」；任务管线未据校验结果拦截上传。 |
| 5 | 是否不影响原任务运行 | **通过。** 校验为独立脚本 + 只读摘要 API；未改核心步骤调度逻辑。 |

---

## 五、功能回归

| 序号 | 验收项 | 结论 |
|------|--------|------|
| 1–7 | 新建任务、步骤选择、启动、轮询、取消、历史页、结果页 | **未做 E2E 自动化实测。** 前端路由与 `services/api.ts` 调用与后端路由对齐；**建议人工 smoke。** |
| 8 | 非 admin 不能访问 | **通过（门禁逻辑）。** layout + `require_admin`。 |
| 9 | admin 可以访问 | **通过（门禁逻辑）。** 需配置 admin 用户。 |
| 10 | `new-feature-chat` 问答不受影响 | **通过（影响面）。** `new-feature-chat` 与 kb-update API 无交叉引用。 |
| 11 | 登录、退出不受影响 | **通过（影响面）。** auth 路由仅扩展 `role` 与依赖项，登录/登出流程保持。 |

---

## 六、仍然不能做的事（当前版本）

以下能力**仍未实现**（前四步未承诺交付），与既有产品/技术边界一致：

1. **自动覆盖**百炼侧旧文档。  
2. **同法规同版本幂等跳过**（无上传记录表与版本哈希闭环）。  
3. **GetIndexJobStatus** 类索引任务状态闭环。  
4. **ListIndexDocuments**。  
5. **DeleteIndexDocument**。  
6. **定时自动上传**。

---

## 七、下一步建议（是否进入第 5 步）

1. **四步是否全部完成：** 以「需求项 + 仓库实现」为准，**第 1–4 步验收项均满足**（功能回归以人工 smoke 补强）。  
2. **是否存在阻塞问题：** **无代码层面阻塞**；运维上需保证至少一名 `role: "admin"`，否则 kb-update 全站不可用。  
3. **是否可以进入第 5 步**（`kb_upload_records` + `law_id`/`version_hash` 幂等跳过）：**可以进入设计与实现**；第 5 步依赖数据模型与百炼侧能力衔接，与第 1–4 步正交。  
4. **若不能进入：** 当前无「必须先修」的硬阻塞；若业务要求「无 admin 也能跑 kb-update」，则需另起需求（与本阶段 admin 设计冲突）。  

---

## 八、构建与静态检查

在仓库当前状态下已执行：

```text
cd Legal_AI
python -m compileall api config services new_feature_qwen_kb law_spider scripts auth chat_store
```

**结果：通过**（exit code 0）。

```text
cd Legal_AI/frontend
npm run lint
npm run build
```

**结果：通过**（`eslint` 与 `next build --webpack` 均成功）。

---

## 汇总表

| 项目 | 内容 |
|------|------|
| 报告路径 | `Legal_AI/docs/kb-update-first-four-steps-acceptance-report.md` |
| 四步完成情况 | 第 1–4 步需求项：**已完成**（见各节表格） |
| 阻塞问题 | **无**（注意 admin 配置运维前提） |
| 是否可进入第 5 步 | **可以** |
| compileall / lint / build | **均已通过** |
