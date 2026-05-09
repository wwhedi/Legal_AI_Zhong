# 知识库定时更新 / 清洗 / 上传 / 覆盖 / 条文准确性 / 切片格式 — 代码状态审计

**审计日期：** 2026-05-09  
**范围：** `law_spider/`、`api/kb_update_api.py`、`services/`（检索与解析相关）、`config/` 与环境变量约定、`data/kb_update.db` 结构；**未修改任何代码**。  
**说明：** 百炼控制台行为（同名文件、Index 内去重策略）以阿里云产品为准；下文以本仓库**已实现**逻辑为准。

---

## 一、定时执行状态

### 1.1 代码检查结果

| 项 | 状态 |
|----|------|
| 是否已有定时任务代码 | **否。** 全仓检索未发现 Python 侧 `APScheduler`、`celery`、`crontab` 等与 KB 更新绑定的调度实现；前端 `package-lock.json` 中的 `scheduler` 为 React 运行时依赖，与爬虫无关。 |
| 触发方式 | **手动：** 运行 `law_spider` 各脚本（交互式 `input`）；或通过 HTTP **`POST /kb-update/jobs`** 创建任务再 **`POST .../start`** 拉起子进程。 |
| `/kb-update` 是否仅任务编排 | **是。** 在内存中维护 `JOB_STORE` / `TASK_STORE` / `PROCESS_STORE`，按步骤 `asyncio.create_subprocess_exec` 执行脚本，并把状态与日志写入 SQLite。 |
| 是否支持每日自动执行 | **否（代码内）。** 需操作系统 **cron**（Linux/macOS）、**任务计划程序**（Windows）或外部编排调用上述 API/脚本。 |

### 1.2 `/kb-update` 与步骤、恢复、重试

- **按步骤执行：** 创建任务时可传 `steps: StepId[]`，`_run_job` 仅执行 `job.steps` 中包含的步骤；未选步骤在 `step_progress` 中为 `skipped`。  
- **`run_mode`（`full_run` / `step_run`）：** 字段写入 `kb_jobs.run_mode` 并持久化，但 **`_run_job` 内未读取该字段**，行为完全由 `steps` 列表决定；**`step_run` 与 `full_run` 当前无逻辑差异**。  
- **任务恢复：** `start_job` 对状态为 `SUCCESS` / `FAILED` / `CANCELLED` 的任务返回 **400**（不可再次启动）；**不支持**从失败步骤自动续跑同一 `job_id`。进程中断后可通过 `get_job` 从 DB 加载快照到 `JOB_STORE`，但**不能**用同一 job 继续执行未完成步骤。  
- **失败重试：** 单步脚本非零退出码会抛错，整 job 标记 `FAILED`；**无** API 层自动重试同一子步骤。子进程内部分脚本自有重试（见后文）。  
- **`data/kb_update.db`：** 表 `kb_jobs`（任务元数据）、`kb_job_steps`（每步状态与时间）、`kb_job_logs`（文本日志）；**无**定时配置表。

### 1.3 输出：能力 / 缺失 / 推荐

- **已有能力：** 手动多步骤编排、步骤状态与日志落库、列表/查询任务、取消时 `kill` 子进程。  
- **缺失能力：** 内置定时器、失败步骤级重试与续跑、`run_mode` 实际分支。  
- **推荐：** 若部署在单台常驻服务上且需内嵌调度，可用 **APScheduler** 调 `POST .../start` 或封装函数；若部署简单、多实例无关，**cron / 系统任务** 调用同一套脚本或 API 更清晰，避免与进程内事件循环、多 worker 重复触发冲突。

---

## 二、爬取与下载状态

### 2.1 法规索引如何建立

- **`法规爬虫1`：** 调法规库接口分页拉取 `rows`，追加写入 `{date}-最新规范.txt`（含 No.、名称、机关、日期、性质、**时效性**、网址等）；同时维护 `{date}-浏览索引.txt`（名称 + 链接，`bbbs` 来自 `detail?id=`）。

### 2.2 如何判断「新增法规」

- 若存在**历史**「最新规范」文件（取目录中除当日文件外的**最新文件名**对应文件），用正则抽出旧列表中的 `名称：…` 等；当前页某 **标题不在旧列表** → 视为新制定，写入浏览索引并计数。

### 2.3 如何判断法规状态变化

- **部分覆盖：** 若标题已在旧列表，比较**公布日期**字符串：新公布日期 **大于** 旧公布日期 → 视为修改，写入浏览索引；旧记录缺公布日期也会写入复核。  
- **风险：** 时效性字段（`sxx` → 已失效/现行有效等）会写入**当日**「最新规范」全文，但**未**作为与旧索引 diff 的独立条件；**废止而未换标题、公布日期未按预期变化** 时，可能**不会**进入浏览索引 diff 逻辑（依赖标题 + 公布日期启发式）。

### 2.4 下载断点续传与重试

- **`法规爬虫3`：** 扫描库目录已有 `序号.` 前缀文件，`begin_num` 取最大序号；支持交互选择从最大序号继续、指定序号、或更新模式下结合**旧下载索引**调整起点（`x` / `x-编号`）；循环从 `begin_num` 起下载。  
- **HTTP：** `request_with_retry` 等对网络错误有重试；单条 `download_record` 亦有尝试次数参数。Selenium 下载有轮询重试与格式回退。  
- **失败：** 部分路径 `sys.exit()` 直接退出，需人工重新跑。

### 2.5 唯一 ID 与效力区分

- **唯一 ID：** 索引与 URL 中广泛使用 **`bbbs`**（`law_list[i]['bbbs']`）；`法规爬虫4` 中 `doc_id = f"law_{row.bbbs}"`，`master` 行含 `bbbs`、`detail_url`。  
- **效力：** `法规爬虫1` 将接口状态码映射为「已失效 / 现行有效 / 即将生效」等；`法规爬虫4` 用 `normalize_status_text` 归一到 **尚未生效 / 有效 / 已修改 / 已废止**（与导出一致）。

### 2.6 输出：字段 / 风险 / 增量适合性

- **当前字段：** 标题、机关、公布/生效日期、法律性质、**时效性文本**、详情 URL、`bbbs`、下载格式等。  
- **风险：** 增量依赖**本地历史索引文件**与**标题+公布日期**比对，非严谨版本向量；下载编号与「下载索引」行号绑定，库目录与索引不一致时易错位。  
- **是否适合增量更新：** **部分适合**（浏览索引 + 续传）；要稳定增量需配合**结构化库 + hash**（当前见第六节、七节）。

---

## 三、清洗与切片状态（`法规爬虫4`）

### 3.1 DOCX 如何抽取

- **`extract_docx_text`：** 标准库 `zipfile` + `xml.etree` 解析 `word/document.xml`，按 `w:p` / `w:t` 拼接段落，**无** python-docx 依赖。

### 3.2 章、节、条识别

- **`format_for_regex_chunking`：** 合并断开的「第…」「条」、行内锚点前切分、按「章/节/条」缓冲合并，目标是一条一行便于换行切分。  
- **`render_kb_lines`：** `chapter_re` 识别「第…章/节」更新上下文；`article_re` 识别「第…条」；序言单独合并。

### 3.3【来源信息】【章节】【法规正文】

- **`build_source_info_line`：** 单行 `法规名 | 类型 | 时效性 | 公布日期 | 生效日期 | 链接：detail_url`。  
- **每行切片：** `【来源信息】{source}  【章节】{section}  【法规正文】{body}`（章节可能为「章+条」拼接或仅条/序言）。

### 3.4 结构化字段（条号、路径、hash）

| 项 | 状态 |
|----|------|
| 条号单独字段化 | **否。** 条号在【章节】字符串中（如「第一章 第一条」）。 |
| `article_no` | **否**（导出层无独立列；RAG 侧由 `extract_article_number` 从文本抽）。 |
| `chapter_path` | **否**（仅有当前 `chapter_ctx` 字符串）。 |
| `source_url_clean` | **否**。 |
| `text_hash` / `article_hash` | **否（条文级）。** `law_master.jsonl` 有整部正文 **`content_sha256`**。 |
| 条号重复 / 正文为空 / 章节错位 | **无自动检测。** 仅有「抽取失败/正文为空/缺文件/缺 meta」汇总进 `clean_report.txt`。 |

### 3.5 当前切片格式是否适合继续用

**优点：**

- 与 **`法规爬虫5`** 默认 `chunk_separator = (?=【来源信息】)` 强一致，一行一片时配合 **`chunk_size=6000`** 尽量不再被截断。  
- 与 **`parse_law_chunk_text`**、`AliyunKBService._node_to_citation` 的标签约定一致，RAG 引用链现成。

**问题：**

- 单行承载信息密度高，**人工 diff/审计**困难；**条号、章节路径**不独立，后续「按条更新」难。  
- 来源信息用 `|` 分隔，若标题等字段内含 `|` 或异常换行，可能干扰解析（概率低但存在）。

**是否建议升级为多标签块（【切片ID】【法规ID】…）：**

- **长期建议「是」**（或：**结构化库 + 生成 Markdown 时仍保留【来源信息】锚点** 以兼容现有百炼 regex）。  
- 若直接改标签名而不同步 **`law_chunk_parse.py`**、**`aliyun_kb_service.py`**、**爬虫5 的 separator**，检索侧解析会**断裂**。较稳妥路径：**先结构化落库，再由模板生成现有三标签行**（见第九节）。

---

## 四、上传阿里云状态（`法规爬虫5`）

### 4.1 流程摘要

1. 从 **`law_master.jsonl`** 读取 `upload_file_path` 列表（**禁止**目录扫描回退，避免误传）。  
2. **`apply_upload_lease`** → 预签名上传 → **`add_file_by_lease`** 得 **`file_id`**。  
3. 轮询 **`describe_file`** 直至 `PARSE_SUCCESS` / 失败 / 超时；上传与解析均有 **`max_retry_per_file`**（环境变量 `BAILIAN_RETRY_TIMES` 等）。  
4. 若配置 **`BAILIAN_INDEX_ID`**：对本次 **`uploaded_file_ids`** 调用 **`submit_index_add_documents_job`**（`chunk_mode`、`separator`、`chunk_size`、`overlap`）；索引任务带 **`BAILIAN_INDEX_JOB_RETRY`** 等重试。

### 4.2 记录与查询 / 删除

| 项 | 状态 |
|----|------|
| 记录 `file_id` | **是。** 内存 `summary["uploaded_file_ids"]` 与每条 `details`；**未**写入 `kb_update.db`。 |
| `document_id` / `job_id`（索引任务） | **部分。** `submit_index_add_documents_job` 响应写入 `summary["submit_index_add_documents_job"]` 等（控制台打印）；**无**本地持久化表。 |
| 上传成功记录 | **运行期 JSON 风格 summary + 打印**；**无**专用上传历史表。 |
| 查询 Index 已有文档 | **本脚本未实现** List/Describe Index Documents 用于去重。 |
| 删除旧文档 | **未实现** DeleteFile / 从 Index 移除文档等调用。 |
| 同名覆盖 | **未定义。** 每次上传生成**新** `file_id`；是否视为重复由**百炼数据中心 + Index** 策略决定，**应用层无「覆盖同名」逻辑**。 |
| `law_id + version_hash` 跳过 | **未实现。** |

### 4.3 明确回答（重复 / 覆盖 / 删除 / 表）

- **重复上传会发生什么：** 会再次 **AddFile** 得到**新** `file_id`，并可能再次 **SubmitIndexAddDocumentsJob** → **极有可能在知识库中形成重复或可检索重复片段**（取决于云端是否按内容去重）。  
- **是否会覆盖旧文档：** **代码层面不会**主动删除或替换旧 `file_id`。  
- **能否删除旧版本：** **本仓库脚本未提供**；需控制台或补 OpenAPI。  
- **是否有上传记录表：** **否。**

---

## 五、法规更新与覆盖状态

### 5.1 如何判断「一部法规更新了」

- **爬虫1：** 见第二节（标题 + 公布日期对比 → 浏览索引）。  
- **爬虫4：** `law_master.jsonl` 含 **`content_sha256`**（整份清洗后正文），可用于**人工或后续脚本**对比同一 `bbbs` 是否变化；**无自动与百炼侧同步**。

### 5.2 条级 / 整部 / 仅变更上传

| 能力 | 状态 |
|------|------|
| `version_hash`（法规级） | **无**独立字段名；有 **`content_sha256`**。 |
| 条级更新判定 | **无。** |
| 整部未变跳过上传 | **无。** |
| 只上传变更法规 | **无**（每次 master 列多少文件传多少）。 |
| 按法规为单位重新上传 | **可操作**（重新跑 4→5），但**不**删除旧索引条目。 |
| inactive / archived | **无。** |
| 删旧后上新 | **无自动化。** |

### 5.3 推荐策略（代码现状下）

- **当前更适合**「**按法规文件（每部一个 .md）整体重传**」的流程设想，但必须配套 **百炼侧清理重复** 或 **新 Index 切换**，否则重复累积。  
- **条级覆盖** 需 **条文 ID + 版本** 与 Index 文档粒度对齐，**当前数据结构不支持**。

---

## 六、条文准确性校验状态

### 6.1 上传前校验（现状）

- **`法规爬虫4`：** 校验 **DOCX 是否存在**、**索引 meta 是否匹配 `bbbs`**、**抽取是否异常**、**清洗后是否空**；输出 **`clean_report.txt`** 与 **`law_master.jsonl`**。  
- **无：** 每条是否含法规名/时效/链接/章节/条号/正文的 **逐行 schema 校验**；条号重复、正文混入来源信息、URL 脏字符、日期格式、废止误入「有效库」等 **专项规则**。

### 6.2 RAG 侧（检索后）

- **`AliyunKBService`：** `law_name` 清洗、与 `parse_law_chunk_text` 组合；**不是**上传前校验。  
- **回答链路：** `_filter_effective_citations` 要求 **`effective_status == "有效"`**（字符串精确），**已废止**条目若在召回中会被剔除，但**不能代替**入库前质量门禁。

### 6.3 建议

- **建议新增** `scripts/validate_kb_export.py`（或等价）：对 `law_master.jsonl` + 生成的 `.md` 做行级校验、条号统计、URL 规范化检测；与 **第九节第 1 步** 一致。

---

## 七、结构化库状态

### 7.1 表与字段清单

| 项 | 是否存在 |
|----|----------|
| `law_documents` / `law_articles` / `kb_chunks` / `kb_upload_records` | **否**（`kb_update.db` 仅任务三表）。 |
| `law_id` / `article_id` / `article_no` / `source_url_clean` / `text_hash` / `version_hash` | **否**（库表层面）；**master 行**有 `doc_id`、`bbbs`、`content_sha256`。 |
| `bailian_file_id` / `bailian_document_id` / `upload_status` | **否**（无持久化）。 |

### 7.2 判断

- **上传产物：** 生产路径主产物为 **Markdown（及 `law_master.jsonl` 追溯）**；本地 RAG 测试用 **JSON 数组**（`LocalKBService`）。  
- **是否新增 `data/legal_kb_structured.db`：** **建议**（与 `kb_update.db` **分开**：前者管法规/条文/上传状态，后者只管编排任务）。  
- **SQLite 是否足够：** 对单机/中小规模 **足够**；大规模可考虑迁移，但非当前代码缺口的主矛盾。

---

## 八、当前 RAG 检索与知识库字段关系

### 8.1 百炼返回后解析路径

- **`AliyunKBService._node_to_citation`：** `node["Text"]` 经 **`parse_law_chunk_text`**；`Metadata` 键 **`law_name` / `source_url` / `chapter` 等** 优先；`article` 由 **`extract_article_number`** 从章节+正文抽。

### 8.2 是否依赖标签反解析

- **是。** 正文块依赖 **`【来源信息】` / `【章节】` / `【法规正文】`**（见 `law_chunk_parse.py` 正则）。

### 8.3 切片格式升级时的同步点

- **`services/law_chunk_parse.py`**：`_LABEL_TO_FIELD`、分段正则。  
- **`services/aliyun_kb_service.py`**：`_resolve_law_name`、`_meta_pick`、`_node_to_citation`。  
- **`法规爬虫4`**：`render_kb_lines` / `build_source_info_line`。  
- **`法规爬虫5`**：`BAILIAN_CHUNK_SEPARATOR` 与锚点一致。  
- **`services/local_kb_service.py`**：若本地 JSON 字段与展示不一致需对齐。

### 8.4 前端 `QwenKbAnswerCard` / `CitationSidePanel` / `[n]`

- 前端主要消费 API 返回的 **`citations`**（`law_name`、`chapter`、`article`、`source_url`、`text` 等）。  
- **若后端仍能产出相同 JSON 语义**，前端可不改；**若解析失败导致字段大量「未提供」或 URL 异常**，卡片与侧栏展示会同步恶化。  
- **`[n]`** 由 **`ref_id`** 与列表顺序驱动；重编号逻辑在 `new_feature_qwen_kb/service.py` 的 `_renumber_citations`，与切片标签格式**间接**相关（引用条数变化）。

---

## 九、推荐下一步修改顺序

| 步 | 内容 | 主要涉及文件/位置 | 风险 | 对现有问答影响 |
|----|------|-------------------|------|----------------|
| **第 1 步** | 只做上传前校验 | 新增 `scripts/validate_kb_export.py`；可选对接 `law_master.jsonl` / 清洗目录 | **低** | **无**（未改 RAG） |
| **第 2 步** | 建立结构化法规库 | 新增 `data/legal_kb_structured.db`（或等价）+ 迁移脚本 | **低** | **无** |
| **第 3 步** | 爬虫4 结果先入结构化库 | `法规爬虫4-清洗与知识库导出.py` 或后置 ETL | **中** | **无**（若仍生成相同 .md） |
| **第 4 步** | 从结构化库生成 Markdown | 新模块或扩展爬虫4 | **中** | **有**若标签/字段变化且未同步解析 |
| **第 5 步** | `kb_upload_records` 避免重复上传 | 新表 + `法规爬虫5` 读写 | **中** | **无**（仅上传侧） |
| **第 6 步** | `law_id + version_hash` 跳过或覆盖 | 结构化库 + 爬虫5 + 可选百炼 Delete API | **高** | **有**（Index 内容变） |
| **第 7 步** | 定时任务 | cron 或 APScheduler 调 API/脚本 | **中**（运维） | 取决于第 6 步 |

---

## 执行摘要（对应你的输出要求）

1. **报告路径：** `Legal_AI/docs/kb-update-workflow-code-state.md`  
2. **当前定时更新能力：** **无内置定时**；仅手动脚本或 `/kb-update` 编排；每日自动需外部 cron/计划任务。  
3. **当前重复上传/覆盖能力：** **无去重、无删除旧文档、无上传历史表**；重复跑上传会新增 `file_id` 并再次入 Index 任务，**高度可能产生重复检索内容**；**无应用层覆盖**。  
4. **当前条文准确性校验能力：** **仅有**导出阶段文件/meta/抽取级检查；**无**条级、URL、重复条号等专项校验；RAG 侧仅有 **`effective_status == "有效"`** 的后验过滤。  
5. **当前切片格式问题：** 条与章节未字段化、单行难维护；与百炼 regex 锚点绑定紧；**适合短期延续**，长期建议 **结构化 + 模板化生成** 保留锚点兼容。  
6. **推荐优先：** **第 1 步（上传前校验）** — 成本最低、不破坏线上问答，且为后续结构化与去重打基础。  
7. **`compileall`：** 已在 `Legal_AI` 下执行  
   `python -m compileall api config services new_feature_qwen_kb law_spider scripts`  
   **退出码 0，通过。**
