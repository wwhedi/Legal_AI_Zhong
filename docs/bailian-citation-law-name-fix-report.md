# law_name 修复后验收审计报告

**审计日期**：2026-05-06  
**性质**：只读代码与命令验收，**未修改**业务代码。  
**说明**：仓库内无 `Legal_AI_Zhong` 目录；命令均在 **`Legal_AI`** 下执行。

**报告路径**：`Legal_AI/docs/bailian-citation-law-name-fix-report.md`（本文件）

---

## 1. 后端 `AliyunKBService._node_to_citation` 的 `law_name` 取值优先级

**结论：已调整。**

`law_name` 由 **`_resolve_law_name(meta, parsed)`** 生成，优先级（见 `services/aliyun_kb_service.py` 内文档与实现）为：

1. **强 Metadata**（逐项 `_clean_law_name`，取首个非空）：`law_name`、`lawName`、`regulation_name`、`regulationName`  
2. **正文解析**：`parse_law_chunk_text` 得到的 `parsed["law_name"]`，且 **不等于** `MISSING`（「未提供」），再经 `_clean_law_name`  
3. **弱 Metadata**：`document_name`、`documentName`、`doc_name`、`docName`、`title`、`hier_title`、`file_name`、`fileName`  
4. **兜底**：`MISSING`（「未提供」）

与修复前「`title`/`doc_name` 等优先覆盖正文解析」相比，**正文解析已优先于弱 meta**，且全程经 **`_clean_law_name`**。

---

## 2. 是否过滤异常值（后端 `_clean_law_name`）

**结论：对上述占位类字符串会过滤（返回空串，从而进入下一优先级或兜底）。**

`_LAW_NAME_INVALID_EXACT` 与后续规则显式覆盖验收清单中的项，包括但不限于：

| 验收项 | 是否覆盖 |
|--------|----------|
| `【` | 是（精确集合 + 首尾剥离 `【】` 后可能为空） |
| `】` | 是（同上） |
| `【来源信息】` | 是 |
| `来源信息` | 是 |
| `法规名` | 是 |
| `法规名称` | 是 |

另：`none`/`null`（大小写）、以 `【章节】`/`【法规正文】` 开头、过短且无字母数字/CJK 等亦会判无效。

---

## 3. `parse_law_chunk_text` 支持的来源信息 key（对照验收清单）

**结论：验收表所列标签均在 `_LABEL_TO_FIELD` 中有映射；另含扩展项（如 `名称`、`文件类型`、`时效状态`、`实施日期`），不改变对外字段名。**

| 验收项 | 支持情况（映射至内部字段） |
|--------|----------------------------|
| 法规名 | 是 → `law_name` |
| 法规名称 | 是 → `law_name` |
| 类型 | 是 → `law_type` |
| 法规类型 | 是 → `law_type` |
| 时效性 | 是 → `effective_status` |
| 效力状态 | 是 → `effective_status` |
| 公布日期 | 是 → `publish_date` |
| 发布日期 | 是 → `publish_date` |
| 生效日期 | 是 → `effective_date` |
| 施行日期 | 是 → `effective_date` |
| 链接 | 是 → `source_url` |
| 来源链接 | 是 → `source_url` |
| URL / url | 是 → `source_url` |

---

## 4. 分隔符 `|` 与 `｜`

**结论：已支持。**

`services/law_chunk_parse.py` 中 **`_SOURCE_PART_SPLIT_RE = re.compile(r"\s*[\|｜]\s*")`**，来源信息段按 **半角 `|`（U+007C）** 与 **全角 `｜`（U+FF5C）** 分段解析。

---

## 5. 前端 `normalizeSources` 是否对 `lawName` 做异常值兜底

**结论（以当前仓库为准）：未发现第 3 步所述兜底实现。**

`frontend/src/app/new-feature-chat/page.tsx` 中 **`normalizeSources`** 当前为：

- `const lawName = pickStr(item, "law_name", "lawName");`

仓库内 **无** `cleanDisplayName` / `pickLawDisplayName` 等符号；**`pickStr` 仍会把非空字符串（含单个 `【`）原样作为 `lawName`**。

**验收含义**：若仅依赖当前前端，**后端若仍返回畸形 `law_name`（或绕过清洗的极端值），UI 仍可能原样展示**；与「前端兜底」目标相比，**存在缺口**。

---

## 6. `CitationPopover` 展示项

**结论：仍包含所列信息结构。**

`QwenKbAnswerCard.tsx` 中 `CitationPopover` 仍渲染：

- 法规名称（`source.lawName`）  
- 类型、时效性、公布日期、生效日期  
- 章节/条文（`chapterArticleLine`）  
- 法规正文  
- 来源链接：`sourceUrl` 存在时 **「查看原文」** 链接，否则「链接：未提供」  

引用编号 **`[{source.id}]`** 与悬浮/点击逻辑未在本次审计范围内改动。

---

## 7. `KnowledgeSourcesBlock` 是否不再显示 `[1] 【`

**结论：在后端清洗与解析生效的前提下，应不再出现「仅法规名为 `【`」的列表行；当前前端无额外过滤。**

- **后端**：`_clean_law_name` + `_resolve_law_name` 应避免将 `law_name` 定为 `【`；且 **`parse_law_chunk_text` 对用户给定全角 `｜` 样例可正确解析法规名称**（见下文样例测试），有利于 `law_name` 来自正文。  
- **前端**：仍直接展示 `source.lawName`；**若未合并前端兜底代码，对未预料的畸形字符串仍有残余展示风险**。

---

## 8. `citations` 返回结构

**结论：未破坏。**

`AliyunKBService._node_to_citation` 返回字典键仍为：`ref_id`、`law_name`、`law_type`、`effective_status`、`publish_date`、`effective_date`、`chapter`、`article`、`text`、`source_url`、`score`、`status`、`status_display`、`verified`、`verify_source`、`doc_id` 等；**仅 `law_name` 的取值策略变化**，未增删对外契约字段。

---

## 9. `/new-rag/ask-stream` 是否仍可用

**结论：路由与流式响应形态仍在。**

`new_feature_qwen_kb/router.py` 仍注册 **`POST /new-rag/ask-stream`**，返回 **`StreamingResponse`**（`application/x-ndjson`）。本次审计未改动该文件；**运行时可用性仍依赖服务启动、模型与百炼配置**，静态代码层面无结构性破坏。

---

## 10. lint / build / compileall

**执行目录**：`e:\cousor\Legal_AI`（替代不存在的 `Legal_AI_Zhong`）

| 命令 | 结果 |
|------|------|
| `python -m compileall api config services new_feature_qwen_kb` | **通过**（exit 0） |
| `cd frontend && npm run lint` | **通过** |
| `cd frontend && npm run build` | **通过** |

---

## 样例：`parse_law_chunk_text` 实测（用户给定文本）

**输入摘要**（全角 `｜`，含法规名称/法规类型/效力状态/来源链接 + 章节 + 正文）：

```text
【来源信息】法规名称：中华人民共和国民法典｜法规类型：法律｜效力状态：有效｜公布日期：2020-05-28｜生效日期：2021-01-01｜来源链接：https://example.com
【章节】第十四章 租赁合同 第七百二十二条
【法规正文】承租人无正当理由未支付或者迟延支付租金的，出租人可以请求承租人在合理期限内支付。
```

**实测 `law_name`**：**`中华人民共和国民法典`**（与预期一致）。

---

## 汇总输出（用户要求）

| 项目 | 结论 |
|------|------|
| **报告路径** | `Legal_AI/docs/bailian-citation-law-name-fix-report.md` |
| **compileall** | 通过 |
| **lint / build** | 通过 |
| **样例 `law_name`** | 可解析为 **中华人民共和国民法典** |
| **「【」异常显示风险** | **后端**：对清单内占位及短串有较强过滤，风险显著降低。**前端（当前仓库）**：`normalizeSources` 仍用 `pickStr`，**未**对 `lawName` 做异常兜底，**若出现未覆盖的畸形字符串，仍有原样展示风险**；建议合并或恢复第 3 步前端清洗后与后端形成双保险。 |

---

*本报告依据当前仓库静态代码与上述命令输出整理。*
