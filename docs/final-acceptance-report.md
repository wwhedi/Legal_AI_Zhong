# Legal_AI_Zhong 最终验收报告

**验收日期**：以仓库当前快照为准。  
**说明**：本报告依据代码阅读与构建命令结果整理；**未修改业务代码**。

---

## 1. 构建与静态检查

| 命令 | 目录 | 结果 |
|------|------|------|
| `python -m compileall .` | `Legal_AI_Zhong` | **通过**（exit 0） |
| `npm run lint` | `Legal_AI_Zhong/frontend` | **通过** |
| `npm run build` | `Legal_AI_Zhong/frontend` | **通过** |

---

## 2. 目标 1：`/new-rag/ask` 主流程是否满足

| 环节 | 结论 | 依据摘要 |
|------|------|----------|
| 用户问题 → 关键词 / query rewrite | **满足** | `new_feature_qwen_kb/service.py` 中 `ask` 先 `reasoning.generate` + `LEGAL_QUERY_REWRITE_*` + `parse_query_rewrite_result`，再用 `search_query`（失败或空则回退原问题）。 |
| 阿里云百炼检索 | **满足** | `await self.kb.retrieve(search_query)`。 |
| 解析法律切片 citations | **满足** | `AliyunKBService._node_to_citation` 结合 Metadata 与 `parse_law_chunk_text`。 |
| 只基于知识库切片生成回答 | **基本满足（依赖模型）** | 回答阶段 `LEGAL_RAG_*` 明确约束仅用检索结果与清单；`kb_context_for_prompt` / `ref_lines` 仅来自有效切片子集（见下条与「差距」）。 |
| 回答正文 `[n]` 引用 | **基本满足（依赖模型）** | Prompt「二、引用编号规则」与 user 模板「回答要求」强制句末编号；代码不校验模型输出是否含 `[n]`。 |
| 前端 `[n]` 悬浮法规详情与链接 | **满足** | `QwenKbAnswerCard` 中 `renderTextWithCitations` + `CitationPopover`；有 `source_url` 时「查看原文」`target="_blank"` `rel="noreferrer"`。 |

**总体**：主链路在**工程实现**上已贯通；**「只基于 KB」「[n] 一定出现」**仍受**大模型遵从度**约束，属运行时风险而非代码断链。

---

## 3. 目标 2：后端检查

### 3.1 `api/main.py` 挂载

- **结论**：仅 **`kb-update`** 与 **`new-rag`**。  
- **证据**：`app.include_router(kb_update_router)`、`app.include_router(new_rag_router)`；**无** `qa` / `review` 等路由。

### 3.2 `new_feature_qwen_kb/service.py`

- **结论**：包含 **query rewrite** 与 **回答生成** 两步（外加检索与有效切片过滤）。  
- **证据**：`ask` 内顺序为改写 → `retrieve` → `_filter_effective_citations` → 组装 `retrieval_query_info` / `kb_context` / `ref_lines` → 第二次 `reasoning.generate`。

### 3.3 `services/aliyun_kb_service.py`

| 检查项 | 结论 |
|--------|------|
| 解析 `law_name`、`law_type`、`effective_status`、`publish_date`、`effective_date`、`chapter`、`text`、`source_url` | **满足**（另含 `article` 条文号抽取、`doc_id` 调试字段） |
| 去掉 `status` 硬编码 `valid` | **满足** | `status` 由 `effective_status_to_status(effective_status)` 映射（`有效`→`valid`，否则 `unknown` / `non_valid`） |
| citations 是否含前端悬浮所需字段 | **满足** | 与前端 `QwenKbSource` / `normalizeSources` 对齐的字段均具备 |

### 3.4 与「仅有效法条」相关的检索层说明（见第六节差距）

---

## 4. 目标 3：Prompt 检查（`config/legal_prompts.py`）

| 检查项 | 结论 |
|--------|------|
| `LEGAL_QUERY_REWRITE_SYSTEM_PROMPT` | **存在** |
| `LEGAL_QUERY_REWRITE_USER_PROMPT_TEMPLATE` | **存在** |
| `LEGAL_RAG_ANSWER_SYSTEM_PROMPT` | **存在** |
| `LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE` | **存在**（含 `{retrieval_query_info}`、`{kb_context}`、`{ref_lines}`、`{question}`） |
| 回答 prompt 是否强制 `[n]` | **是**（系统规则二 + user「回答要求」第 1、3、4 条） |
| 是否禁止使用外部法律信息 | **是**（系统规则一 + user 中「不得使用外部法律信息」） |
| 是否要求只引用时效性=有效的法条 | **是**（系统规则四 + user 回答要求第 2 条） |

---

## 5. 目标 4：前端检查

| 检查项 | 结论 |
|--------|------|
| `new-feature-chat` 调用 `/new-rag/ask` | **是**（`fetch(..., '/new-rag/ask')`） |
| `QwenKbAnswerCard` 识别 `[1]`、`[2]` | **是**（`CITATION_SPLIT_RE` / `\[(\d+)\]`） |
| hover / click 显示引用卡片 | **是**（`hover` + `open`，`document` mousedown 点外关闭） |
| 卡片展示法规名称、类型、时效性、公布/生效日期、章节/条文、正文、链接 | **是**（`CitationPopover`） |
| `source_url` 新开页 | **是**（`target="_blank"` `rel="noreferrer"`） |
| 缺失字段「未提供」 | **是**（`normalizeSources` 中 `pickStr` 默认；链接无则 `null` / UI「链接：未提供」） |
| 保留「知识库来源」列表 | **是**（列表区增强字段展示） |

---

## 6. 目标 5：不应恢复的模块

**判定标准**：主应用 **FastAPI 挂载** 与 **Next 主要路由/侧栏** 未再启用下列能力；仓库内可能存在历史脚本或空目录不在此逐文件枚举。

| 模块/能力 | 结论 |
|-----------|------|
| `/qa` | **未恢复**：未发现 `qa_api.py`；`main.py` 未挂载。 |
| `/chat`（旧聊天页） | **未恢复**：`frontend/src/app` 下无 `chat` 路由；侧栏仅 `/new-feature-chat` 与 `/kb-update`。 |
| `/review` | **未恢复**：无 `app/review`；`main.py` 无 review 路由。 |
| `local-prompt` | **未恢复**：`new_feature_qwen_kb/router.py` 仅 `POST /new-rag/ask`。 |
| MCP / Farui / 本地 Qwen | **未接入主应用**：当前 `main` 与 `new-rag` 路径未引用；本快照下未检索到 `mcp_server`、`farui_service`、`local_qwen` 等旧文件名（若你本地仍有残留文件，以 `main.py` 是否 `include_router` 为准）。 |
| `db_postgres` / `db_neo4j` | **未接入主流程**：本快照下未找到对应 `config/db_*.py` 文件；`main` 未引用。 |

---

## 7. 是否「完全」满足目标

**结论：核心目标已满足，存在少量「设计/运行时」层面的未完全项，不构成构建错误。**

### 7.1 已完全满足的部分

- 主链路：改写 → 百炼检索 → citations 解析 → 仅有效切片参与回答 prompt → 返回 `answer` + `citations`。  
- Prompt 四套齐全，且回答侧对来源、`[n]`、时效性、结构有明确要求。  
- 前端：`/new-rag/ask`、内联 `[n]`、悬浮/点击卡片、链接新开、缺省「未提供」、来源列表保留。  
- 后端挂载范围与「不恢复旧模块」一致。  
- **compileall、lint、build 均通过。**

### 7.2 未完全满足或可改进的具体点（建议写入后续迭代，非本次验收阻塞）

1. **百炼 Retrieve 未使用 `search_filters`**  
   - `AliyunKBService.retrieve` 仍以 `search_filters=None` 调用 API。  
   - 改写 JSON 中的 `required_filters`（如 `effective_status: 有效`）**主要进入 `retrieval_query_info` 文本**，**未**转为检索 API 的硬过滤。  
   - 实际「仅有效」依赖：**召回后** `_filter_effective_citations` + prompt 约束；**检索池**仍可能混入非有效切片（占用 `rerank_top_n` 名额）。  

2. **「只基于知识库」「正文必有 `[n]`」依赖模型**  
   - 代码不对模型输出做结构化校验或自动补 `[n]`。  

3. **`normalizeAnswer` 与 `[n]` 的交互**  
   - 若模型将 `1) 结论` 与正文写在同一行且 `[1]` 紧贴编号，极少数情况下分段启发式可能不如理想；属边缘展示问题。  

---

## 8. 示例：回答中的 `[1]` 如何对应 `citations`

假设后端返回（节选）：

```json
{
  "answer": "劳动者可提前三十日书面通知解除合同[1]。\n\n1) 结论\n...\n2) 依据\n- [1] ...\n3) 建议\n...",
  "citations": [
    {
      "ref_id": "[1]",
      "law_name": "中华人民共和国劳动合同法",
      "law_type": "法律",
      "effective_status": "有效",
      "publish_date": "2007-06-29",
      "effective_date": "2008-01-01",
      "chapter": "第四章 … 第三十七条",
      "article": "第三十七条",
      "text": "劳动者提前三十日以书面形式通知用人单位，可以解除劳动合同。",
      "source_url": "https://example.com/law/123",
      "score": 0.92,
      "status": "valid"
    }
  ]
}
```

前端处理要点：

1. **`normalizeSources`**：根据 `ref_id` `"[1]"` → `id = 1`，映射为 `QwenKbSource`（`lawName`、`sourceUrl` 等）。  
2. **`renderTextWithCitations`**：正文中 `...解除[1]。` 被拆分为文本段 + `"[1]"`；用 `Map.get(1)` 找到对应 `source`，渲染为可交互引用按钮。  
3. **Hover / Click**：展示 `CitationPopover`，其中「查看原文」指向 `sourceUrl`；若 `source_url` 为 `null`，显示「链接：未提供」。  
4. **底部「知识库来源」**：同一条 `[1]` 的法规名称、时效性、日期、章节、摘要等与卡片一致，便于对照。

---

## 9. 验收签署摘要

| 维度 | 判定 |
|------|------|
| 功能链路 | **通过** |
| 后端与数据字段 | **通过**（检索 API 过滤见 7.2） |
| Prompt 完整性 | **通过** |
| 前端交互与展示 | **通过** |
| 旧模块未恢复 | **通过** |
| 构建 | **通过** |

**最终判定**：**验收通过（附 7.2 已知差距说明）**。

---

*报告路径：`Legal_AI_Zhong/docs/final-acceptance-report.md`*
