# 阿里云百炼（正式环境）引用卡片 `law_name` 显示异常审计报告

**审计日期**：2026-05-06  
**范围**：只读代码审计，**未修改**业务代码、未修改 `.env`、未输出任何密钥或环境变量值。  
**现象**：正式环境 `RAG_BACKEND=bailian`、`MODEL_BACKEND=dashscope` 下，引用卡片与「知识库来源」列表中法规名称显示为类似 **`【`**，列表形如 **`[1] 【`**。

---

## 执行记录（用户要求的检查命令）

> 说明：仓库中**不存在**路径 `Legal_AI_Zhong`，本次在 **`Legal_AI`** 下执行等价命令。

| 命令 | 结果 |
|------|------|
| `Set-Location Legal_AI; python -m compileall api config services new_feature_qwen_kb` | **通过**（exit 0） |
| `Set-Location Legal_AI/frontend; npm run lint` | **通过**（exit 0） |
| `Set-Location Legal_AI/frontend; npm run build` | **通过**（exit 0） |

**报告路径**：`docs/bailian-citation-law-name-audit.md`（本文件）

---

## 1. `citations` 字段来源链路（正式百炼模式）

### 1.1 后端：百炼检索 → 引用对象

1. **`AliyunKBService.retrieve`**（`services/aliyun_kb_service.py`）  
   - 调用百炼 Retrieve API，将响应 `body` 交给 **`_extract_nodes`**。  
   - 仅从 **`body["Data"]["Nodes"]`** 读取节点列表（期望元素为 **dict**）。

2. **节点 → `citations[]`**：`retrieve` → **`_format_context`** → 对每个 node 调用 **`_node_to_citation`**。  
   - 读取 **`node["Text"]`** 作为切片全文（字符串）。  
   - 读取 **`node["Metadata"]`**（若为 dict）作为 **meta**。  
   - 调用 **`parse_law_chunk_text(node_text)`**（`services/law_chunk_parse.py`）得到 **`parsed`**。  
   - **`law_name`** 赋值逻辑（关键）：  
     **`law_name = _meta_pick(meta, "law_name", "regulation_name", "title", "hier_title", "doc_name") or parsed["law_name"]`**  
   - 写入 citation 对象：`"law_name": law_name if law_name else MISSING`（`MISSING` 为 **`"未提供"`**）。

3. **`law_name` / `lawName` 命名**：后端输出始终为 **`law_name`**（snake_case）。**未见**向 camelCase 的转换。

### 1.2 后端：`QwenKBRagService` 过滤与重编号

**文件**：`new_feature_qwen_kb/service.py`。

1. **`kb_payload = await self.kb.retrieve(search_query)`** 得到原始 **`citations`**。  
2. **时效性过滤**：**`_filter_effective_citations`** — 仅保留 **`effective_status` 经 `_display_field` 后等于 `"有效"`** 的条目（与 `law_name` 无直接关系）。  
3. **重编号**：**`_renumber_citations`** — **`deepcopy`** 每条 citation，将 **`ref_id`** 改为 **`[1]`、`[2]`…**（按过滤后顺序）。  
4. **流式接口**：最终 **`type: "answer"`** 的 **`data.citations`** 为上述 **renumbered** 列表（字段仍为 **`law_name`**）。

### 1.3 前端：`normalizeSources` → `QwenKbAnswerCard`

**文件**：`frontend/src/app/new-feature-chat/page.tsx`。

1. 收到 **`answer.data.citations`** 后调用 **`normalizeSources(citations)`**。  
2. **`pickStr(item, "law_name", "lawName")`** → 映射为展示用 **`lawName`**（仅 **`law_name` / `lawName`** 两个键，**未**读取 `title`、`document_name` 等）。  
3. **`QwenKbAnswerCard`** / **`KnowledgeSourcesBlock`** / **`CitationPopover`** 均直接展示 **`source.lawName`**。

**结论（链路）**：`law_name` 在百炼路径上由 **`AliyunKBService._node_to_citation`** 决定 → 经 RAG 服务过滤/重编号 → 前端 **`pickStr`** 转为 **`lawName`** 展示；**前端不参与解析法规名**，只做字段选择与默认值 **`未提供`**（见第 6 节）。

---

## 2. 当前后端解析法规名称的逻辑与优先级

### 2.1 入口位置

- **`parse_law_chunk_text`**：`services/law_chunk_parse.py`  
- **与 meta 合并**：`services/aliyun_kb_service.py` 的 **`_node_to_citation`**

### 2.2 `law_name` 最终优先级（百炼节点）

1. **Metadata（按顺序取第一个非空字符串）**  
   **`_meta_pick(meta, "law_name", "regulation_name", "title", "hier_title", "doc_name")`**  
   - 任一键有非空字符串即采用，**不再**看解析结果。

2. **否则：纯文本解析**  
   **`parsed["law_name"]`**（来自 **`parse_law_chunk_text`**）。

3. **若仍为空**  
   citation 中写入 **`"未提供"`**（常量 **`MISSING`**）。

### 2.3 `parse_law_chunk_text` 如何得到 `law_name`

1. 优先用正则截取 **`【来源信息】` 与后续 `【章节】` 或 `【法规正文】` 之间** 的片段，对该片段按 **`|`** 分段，再对每段匹配：  
   **`^(法规名|类型|时效性|公布日期|生效日期|链接)\s*[:：]\s*(.*)$`**  
   - 键名必须为上述之一；**`法规名称`**、**`document_name`** 等 **不在**匹配列表中。

2. 若正文含 **`【来源信息】`** 但第一步未匹配到分段（例如结构异常），则 **`tail = raw.split("【来源信息】", 1)[-1]`**，再对 **tail** 做同样的 **`|`** 与键值解析。

3. 初始 **`law_name`** 为 **`未提供`**；仅当匹配到 **`法规名：`** 且值非空时覆盖。

### 2.4 与 `config/legal_prompts.py` 的关系

提示词中描述的切片格式（**`【来源信息】法规名：… | 类型：…`**）与解析器预期 **基本一致**；差异在于：**解析器实现细节**（见第 4 节）与 **百炼 Metadata 优先**（见第 2.2 节）可能导致正式数据与「文档约定」不一致时的实际行为与直觉不符。

---

## 3. 正式百炼返回 vs 本地 `dev_law_chunks.json`

### 3.1 本地 JSON（`data/dev_law_chunks.json`）

根结构为 **数组**；每条为 **扁平字段**，例如：`law_name`、`law_type`、`effective_status`、`publish_date`、`effective_date`、`chapter`、`article`、`text`、`source_url`、`score`、`ref_id`。

**路径**：仅当 **`RAG_BACKEND=local`** 时由 **`LocalKBService`** 读取；**不是**百炼 API 的原始形态。

### 3.2 `LocalKBService` 如何模拟「节点」

**`_chunk_to_node`** 返回：

- **`Text`** ← `chunk["text"]`  
- **`Metadata`** ← 将 `law_name`、`law_type` 等放入 meta  
- **`Score`** ← 规范化后的 score  

因此本地模式下 **meta 中已有 `law_name`**，与正式百炼「meta 可能不全或键名不同」的情况 **不一致**。

### 3.3 `AliyunKBService` 实际使用的节点字段

代码显式读取：

- **`Text`**（切片正文）  
- **`Metadata`**（dict）  
- **`Score`**

**未在 `_node_to_citation` 中读取**：`title`、`doc_name`、`document_name` 等 **顶层**节点字段（若百炼把它们放在 node 顶层而非 `Metadata`，当前逻辑 **不会**用到，除非后续扩展）。

### 3.4 正式环境下法规名可能出现的位置（推断）

| 位置 | 当前是否参与 `law_name` |
|------|-------------------------|
| **`Metadata.law_name` 等**（与 `_meta_pick` 列表一致） | **是**，且 **优先于**正文解析 |
| **`Metadata.title` / `doc_name` 等** | **是**（在 `_meta_pick` 列表中） |
| **`Metadata` 中其他键名**（如 `document_name`、`file_name`） | **否**（未被 `_meta_pick` 覆盖） |
| **`Text` 内 `【来源信息】` + `法规名：`** | **是**（当 meta 未提供有效 `law_name` 等时） |
| **节点顶层 `title` / `document_name`** | **否**（当前未读） |

---

## 4. 切片文本格式与解析器能力（对照用户给定样例）

用户预期格式示例（摘要）：

```text
【来源信息】法规名：…… | 类型：…… | 时效性：…… | 公布日期：…… | 生效日期：…… | 链接：……
【章节】……
【法规正文】……
```

对 **`parse_law_chunk_text`**（`services/law_chunk_parse.py`）的对照结论：

| 字段 | 能否解析 | 说明 |
|------|----------|------|
| **`法规名：`** | **能**（键名须为 **`法规名`**） | 若写成 **`法规名称：`**，当前正则不匹配，`law_name` 保持 **`未提供`**（除非 meta 补齐）。 |
| **`类型：`** | **能** | 键名 **`类型`**。 |
| **`时效性：`** | **能** | 键名 **`时效性`**。 |
| **`公布日期：`** | **能** | |
| **`生效日期：`** | **能** | |
| **`链接：`** | **能** | 解析入 **`source_url`**。 |
| **`【章节】`** | **能** | 需存在 **`【法规正文】`** 时，章节截取采用 **`(?=【法规正文】|$)`**；仅有章节无法单独依赖第一节点的 lookahead（见下）。 |
| **`【法规正文】`** | **能** | |

**第一节「来源信息」截取正则**：  
`【来源信息】\s*(.*?)(?=【(?:章节|法规正文)】)`  

- 若文本 **缺少** **`【章节】`** 与 **`【法规正文】`**，该 **search 可能匹配失败**；随后仍可走 **`split("【来源信息】")`** 分支解析来源行（见 **`law_chunk_parse.py`** 第 70–72 行）。  
- 若 **`【来源信息】`** 与 **`【章节】`** 之间存在 **异常字符/嵌套标题**，可能影响截取边界，需结合实际召回文本排查。

**与用户示例的一致性**：在键名为 **`法规名`**、分隔符为 **`|`**、且含 **`【章节】`/`【法规正文】`** 的前提下，**该样例可被当前解析器正确拆解**；问题更可能出在 **正式返回的 Text/Meta 与假设不一致**（见第 5、9 节）。

---

## 5. 为什么 `law_name` 会变成 **`【`**（代码推断）

仓库内 **未发现** 诸如 **`text.split("】")[0]`**、**`text[:1]`** 这类明显截取逻辑用于 `law_name`。

结合现有逻辑，**较合理的推断**如下（按可能性排序）：

### 5.1 Metadata 优先，且某字段值为畸形短字符串（**高概率**）

**`_meta_pick` 会优先采用 meta 中的 **`title` / `doc_name` 等`**。若百炼侧写入的 **`title`（或列表中靠前的键）** 恰为 **单字符 `【`** 或 **以 `【` 开头的错误片段**，则 **`law_name`** 会直接为该值，**覆盖**正文解析得到的正确名称。

这与现象 **`[1] 【`**（`ref_lines` 使用 **`citation["law_name"]`** 拼接）一致。

### 5.2 正文键名与解析器不一致（**中概率**）

若正式切片使用 **`法规名称：`** 而非 **`法规名：`**，解析器 **不会**写入 `law_name`，此时仍依赖 meta；meta 若再有上述畸形 **`title`**，会表现为 **异常短名**。

### 5.3 正文 `法规名：` 的值异常（**中低概率**）

`_parse_source_kv` 在匹配到 **`法规名`** 时，**`val`** 为 **`(.*)$`** Capture；若线上文本出现 **`法规名：【`** 且后续内容缺失、或编辑错误导致值仅为 **`【`**，则会得到 **`law_name == "【"`**。需在日志中对 **脱敏后的 `Text` 前 300 字** 做核对。

### 5.4 前端 **`pickStr`**（**低概率作为根因**）

**`pickStr`** 仅在值为 **null/undefined/空串** 时回退 **`未提供`**；**`"【"` 非空**，会 **原样展示**。因此前端更像 **暴露** 后端字段，而非 **生成** `【`。

---

## 6. 前端是否需要兜底（现状）

**文件**：`page.tsx` 中 **`pickStr`**、**`QwenKbAnswerCard.tsx`** 展示 **`source.lawName`**。

| 场景 | 行为 |
|------|------|
| `law_name` 为空 / null / undefined | **`pickStr`** → **`未提供`** |
| `law_name` 为 **`【`** | **原样显示**（非空） |
| 是否优先 `lawName` / `law_name` / `title` | 仅 **`law_name`、`lawName`**；**无** `title`、`document_name` |
| 角色 | **被动展示**后端 citation；无异常值过滤 |

---

## 7. 建议修复方案（仅建议，**本次未改代码**）

**P0**：后端 **`law_name` 生成策略** — 校验 **`_meta_pick`** 候选值（长度、括号占位符），或与 **`parse_law_chunk_text`** 结果做 **一致性仲裁**；必要时 **降低** 畸形 **`title`** 的优先级。  
**P1**：**兼容百炼 Metadata 字段名**（如 **`document_name`、`file_name`**）及正文 **`法规名称：`**。  
**P2**：前端对 **明显占位**（如仅 **`【`/`】`**、**`来源信息`**）做展示兜底（用户亦可在后续迭代考虑）。  
**P3**：开发模式附加 **`raw_meta` / `parse_debug`**（注意脱敏）。  
**P4**：为 **`parse_law_chunk_text`** 补充单元测试或脚本样例（见第 8 节）。

---

## 8. 建议测试样例（解析器）

### 样例 1：标准格式（含链接）

```text
【来源信息】法规名：中华人民共和国民法典 | 类型：法律 | 时效性：有效 | 公布日期：2020-05-28 | 生效日期：2021-01-01 | 链接：https://example.com/law/civil-code
【章节】第十四章 租赁合同 第七百二十二条
【法规正文】承租人无正当理由未支付或者迟延支付租金的，出租人可以请求承租人在合理期限内支付；承租人逾期不支付的，出租人可以解除合同。
```

### 样例 2：缺少链接字段

```text
【来源信息】法规名：中华人民共和国劳动合同法 | 类型：法律 | 时效性：有效 | 公布日期：2007-06-29 | 生效日期：2008-01-01
【章节】第二章 劳动合同的订立 第十条
【法规正文】建立劳动关系，应当订立书面劳动合同。
```

### 样例 3：metadata 含 title，正文无法规名行

```text
【章节】示例章节 第一条
【法规正文】示例正文内容。
```

（预期：**正文解析器可能无法得到 `法规名`**；若仅依赖 meta，请在测试中模拟 **`Metadata.title`**。）

---

## 9. 当前最可能原因（结论）

| 项目 | 结论 |
|------|------|
| **更可能错在后端还是前端** | **后端（meta 与/或正文解析与正式返回不一致）**；前端缺少过滤会 **放大** 展示问题 |
| **最可能出错的函数/区域** | **`AliyunKBService._node_to_citation`** 中的 **`_meta_pick` + `parse_law_chunk_text`** 组合；其次核对 **`parse_law_chunk_text` 对正式 `Text` 的适配** |
| **是否建议先修后端解析** | **是**：优先保证 citation **`law_name`** 可信 |
| **是否建议同时加前端兜底** | **可选**：作为防御性展示层 |

---

## 10. 检查命令输出汇总

- **报告路径**：`docs/bailian-citation-law-name-audit.md`  
- **`compileall`**：**通过**  
- **`npm run lint`**：**通过**  
- **`npm run build`**：**通过**  
- **当前最可能原因**：**百炼 `Metadata` 中优先字段（尤其 `title`/`doc_name`）值为畸形字符串 `【`，覆盖正文解析**；或 **正文使用 `法规名称` 等非匹配键名** 导致解析失败 + meta 畸形。  
- **建议第一步**：在后端 **打印脱敏后的单条 `Metadata` 键值与 `Text` 前 300 字**（仅调试环境），确认 **`law_name` 究竟来自 meta 还是解析；若为 meta，核对百炼索引字段映射与切片模板。

---

## 附录：关键代码引用（便于跳转）

**Metadata 优先于解析结果**（`services/aliyun_kb_service.py`）：

```146:154:e:\cousor\Legal_AI\services\aliyun_kb_service.py
    def _node_to_citation(self, node: Dict[str, Any], ref_id: str) -> Dict[str, Any]:
        meta = node.get("Metadata") if isinstance(node.get("Metadata"), dict) else {}
        node_text = str(node.get("Text") or "").strip()
        parsed = parse_law_chunk_text(node_text)

        law_name = _meta_pick(meta, "law_name", "regulation_name", "title", "hier_title", "doc_name") or parsed[
            "law_name"
        ]
```

**来源信息解析键名列表**（`services/law_chunk_parse.py`）：

```48:55:e:\cousor\Legal_AI\services\law_chunk_parse.py
            m = re.match(r"^(法规名|类型|时效性|公布日期|生效日期|链接)\s*[:：]\s*(.*)$", p, re.DOTALL)
            if not m:
                continue
            key, val = m.group(1), m.group(2).strip()
            if not val:
                continue
            if key == "法规名":
                base["law_name"] = val
```

**前端 `lawName` 来源**（`frontend/src/app/new-feature-chat/page.tsx`）：

```392:417:e:\cousor\Legal_AI\frontend\src\app\new-feature-chat\page.tsx
function pickStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "未提供";
}
// ...
    const lawName = pickStr(item, "law_name", "lawName");
```

---

**声明**：本报告依据仓库当前静态代码得出；正式百炼 API 实际 JSON 结构以线上脱敏采样为准。
