# 新版可行动回答结构 — 验收审计报告

**性质**：基于当前仓库代码与配置的只读验收审计（未改代码）。  
**审计日期**：以仓库当前状态为准。

---

## 1. Prompt 是否要求输出五段结构

**结论：是。**

依据 `config/legal_prompts.py` 中 **`LEGAL_RAG_ANSWER_SYSTEM_PROMPT`** 第五节与 **`LEGAL_RAG_ANSWER_USER_PROMPT_TEMPLATE`** 第 11 条清单，模型被要求按顺序输出（且标题与下列一致）：

| 序号 | 要求的小节标题 |
|------|----------------|
| 1 | `1) 一句话结论` |
| 2 | `2) 你现在最该做` |
| 3 | `3) 风险提示` |
| 4 | `4) 可执行操作步骤`（含 Markdown 表格说明，且为可选） |
| 5 | `5) 法律依据` |

系统提示中写明：第 1、2、3、5 节强制；第 4 节仅在适合时输出。

---

## 2. Prompt 对「可执行操作步骤」与时限的约束

**结论：已写明，与用户验收目标一致。**

- **不是每题都输出**：系统提示第 37 行明确第 4 节仅在「适合流程化处理」时输出；用户模板第 9 条再次强调「仅在适合流程化处理时输出」。
- **适用场景**：系统提示第 48～49 行列举流程办理、申请程序、维权步骤、材料准备、法条/检索中有程序与期限节点等典型情形；不适合时举例「纯概念解释、单一要件判断、无法从知识库得到任何程序或时限信息」。
- **不适合时整节省略**：第 50 行要求「必须完全省略本节，不要输出表格、不要写无」。
- **禁止占位**：第 37 行禁止「无」「不适用」「本节略」等占位；用户模板第 9 条禁止写「无」。
- **不得编造法律时限**：第 55 行要求无明确时限时写「未提供明确时限」，并禁止编造具体天数（除非切片或用户事实中明确出现）；用户模板第 9 条要求时限列写「未提供明确时限」、不得编造具体天数。

---

## 3. 前端 `normalizeAnswer` 与新旧结构兼容

**结论：兼容。**

`frontend/src/app/new-feature-chat/page.tsx` 中通过 **`SECTION_HEADER_RULES`** 将多种行首标题映射到内部桶（`conclusion` / `basis` / `risks` / `actionAdvice` / `actionSteps`），包括：

- **旧结构**：`结论`、`依据`、`风险点`/`风险`、`建议`（及编号形式）。
- **新结构**：`一句话结论`、`你现在最该做`、`风险提示`、`法律依据`/`法律依据` 等同义词、`可执行操作步骤` 及各类步骤别名等。

解析结果写入 **`QwenAnswer`** 的 `conclusion`、`basis`、`risks`、`actionAdvice`、`actionStepsRaw`，并始终回填 **`details` 三项**；旧会话仅含 `conclusion` + `details` 时，卡片侧仍可读 `details` 回落字段。

**说明**：若模型完全偏离标题格式且落入启发式 `fallbackFourPart`，仍按「段落顺序」猜测四块；此为兜底路径，正式环境应主要靠 Prompt 固定标题。

---

## 4. `QwenKbAnswerCard` 展示顺序

**结论：符合要求的顺序。**

在 `frontend/src/components/chat/QwenKbAnswerCard.tsx` 中，主流程区块自上而下为：

1. **一句话结论**（渐变主色卡片）
2. **你现在最该做**
3. **风险提示**
4. **可执行操作步骤**（仅当 `actionStepsRaw` 非空时渲染）
5. **法律依据**
6. **知识库来源**（`KnowledgeSourcesBlock`）
7. 底部按钮栏（重新生成 / 复制 / 反馈）

---

## 5. 「你现在最该做」是否为行动清单

**结论：是。**

正文经 **`splitActionLines`** 拆分后，由 **`ActionChecklistBlock`** 逐条展示：左侧圆标（项目符号为对勾图标，编号为序号圆章等），右侧 **`renderTextWithCitations`**；占位文案存在时 **`muted`** 弱化。

---

## 6. 「风险提示」是否逐条展示

**结论：是。**

经 **`splitActionLines`** 后由 **`RiskBulletListBlock`** 逐条展示（圆点或序号圆章 + 正文引用）。

---

## 7. 「法律依据」是否弱化并置后

**结论：是。**

该区位于步骤（若有）之后、`KnowledgeSourcesBlock` 之前；样式为 **`text-xs` 标题**、**浅灰背景**、正文 **`text-muted`**，视觉弱于结论与行动区。

---

## 8. `ActionStepsTable` / `parseActionStepsTable`

**结论：与设计要点一致。**

实现位于 `frontend/src/components/chat/ActionStepsTable.tsx`。

| 验收项 | 结论 |
|--------|------|
| 标准 Markdown 表格（`| ... |` + `| --- |`） | 支持：识别表头、`splitTableRow` 处理首尾竖线 |
| 无首尾竖线的管道行 | 支持：`splitTableRow` 对不含外侧 `\|` 的行仍按 `\|` 分列 |
| 解析失败回退 | `parseActionStepsTable` 返回 `null` 时，卡片走 **`prewrap`**（含 `\|` ）或 **`splitActionLines` 列表**，不丢原文 |
| 移动端横向滚动 | 表格外层 **`overflow-x-auto`**，`table` 设 **`min-w-[280px]` / `md:min-w-[480px]`** |
| `[n]` 不丢失 | 「操作内容」「时间/时限」列通过 **`renderCell` → `renderTextWithCitations`** |

表头需同时包含「步骤」、（「操作内容」或列名为「操作」）、（「时间」「时限」或「法律时限」）；不满足则解析失败并回退（属预期契约）。

---

## 9. `[n]` 引用悬浮

**结论：仍可用。**

全局仍使用 **`renderTextWithCitations`** + **`InlineCitationMark`** + **`CitationPopover`**；表格单元格内同样走该路径。

---

## 10. 知识库来源默认折叠

**结论：仍默认折叠。**

`KnowledgeSourcesBlock` 使用 **`useState(false)`** 作为 **`expanded`** 初始值；展开后才渲染条目列表，默认高度以一行为主。

---

## 11. 会话历史保存

**结论：不受影响（结构上向后兼容）。**

`ChatItem.answerCard` 存 **`QwenAnswer`**；扩展字段为可选。`localStorage` 使用 **`JSON.stringify`** 保存会话列表（见 `frontend/src/lib/chat-sessions.ts`），旧数据缺少 `actionAdvice`/`actionStepsRaw` 等字段时，前端仍可通过 **`details` 与回落字段** 展示。

---

## 12. `/new-rag/ask-stream` 可用性

**结论：从本仓库可见实现侧保持流式回答链路，事件形态未因本次审计改动。**

- 前端 `new-feature-chat` 仍请求 **`/new-rag/ask-stream`**（NDJSON）。
- `new_feature_qwen_kb/service.py` 中 **`ask_events`** 仍组装 **`LEGAL_RAG_ANSWER_*`** 并 **`generate_stream`** 推送 **`answer_delta`** 与最终 **`answer`**。

**说明**：本工作区快照中 FastAPI 路由注册文件可能未完整检出；上线实测仍需后端进程挂载该路由、环境变量与密钥就绪。

---

## 验证命令结果

| 命令 | 结果 |
|------|------|
| `cd Legal_AI && python -m compileall api config services new_feature_qwen_kb` | **通过**（exit code 0） |
| `cd Legal_AI/frontend && npm run lint` | **通过** |
| `cd Legal_AI/frontend && npm run build` | **通过** |

---

## 报告路径与上线建议

- **报告路径**：`Legal_AI/docs/actionable-answer-format-report.md`
- **compileall / lint / build**：均已通过（见上表）。
- **是否可以进入正式环境实测**：**可以**，建议在具备完整后端部署、`/new-rag/ask-stream` 与健康检索链路的环境下做小流量实测；关注模型是否稳定遵守五段标题与可选第 4 节表格。
- **残余风险**：模型偶发偏离标题或表格格式时，依赖 `normalizeAnswer` 兜底与步骤表解析回退；可通过抽样质检 Prompt 遵守率。

---

## 建议测试问题（5 个）与「可执行操作步骤」预期

| # | 测试问题（示例） | 预期是否出现「可执行操作步骤」（表格或小节） |
|---|------------------|---------------------------------------------|
| 1 | 劳动合同试用期最长可以约定多久？ | **多半不出现**（概念/数值结论为主，非流程办理） |
| 2 | 我想申请劳动仲裁，具体流程是什么？需要先做哪些步骤？ | **宜出现**（明确程序导向） |
| 3 | 经济补偿中的「N」在法律上一般指什么？ | **多半不出现**（概念解释） |
| 4 | 公司拖欠工资，我第一步该做什么？要固定哪些证据？ | **可能出现**（行动清单必有；若模型输出 Markdown 三步表且检索中有程序/时限支撑则更可能出现完整表格） |
| 5 | 向法院起诉用人单位拖欠工资，要怎么立案？准备哪些材料？ | **宜出现**（诉讼/材料/程序类） |

说明：第 4 节是否输出最终由 **模型按 Prompt 判断**；前端仅在 **`actionStepsRaw`** 非空时展示该区；若模型仅在「你现在最该做」中用清单而未单独输出第 4 节表格，则界面仍可无「可执行操作步骤」区块，属预期差异。
