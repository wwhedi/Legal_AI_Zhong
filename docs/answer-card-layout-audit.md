# QwenKbAnswerCard 回答展示结构审计报告

**审计日期：** 2026-05-07  
**范围：** 只读代码与 prompt，**未修改任何文件**。  
**涉及文件：**

- `Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx`
- `Legal_AI/frontend/src/app/new-feature-chat/page.tsx`（`normalizeAnswer` / `SECTION_HEADER_RULES` / `stripSectionHeaderLine`）
- `Legal_AI/config/legal_prompts.py`

**命令：** `cd Legal_AI/frontend` → `npm run lint`、`npm run build` → **均通过**（`exit_code: 0`）。

---

## 1. 当前回答卡片布局（DOM / React 结构）

### 1.1 外层主卡片

`QwenKbAnswerCard` 根节点为 **单层主容器**：

```491:493:Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx
  return (
    <div className="rounded-[20px] border border-[var(--app-border)] bg-white p-4 shadow-[var(--app-shadow-sm)]">
      <div className="rounded-[16px] border border-[var(--app-primary)]/22 bg-gradient-to-b from-[var(--app-primary-softer)] via-[var(--app-primary-soft)] to-[var(--app-primary-softer)]/80 p-5 shadow-[var(--app-shadow-sm)]">
```

- **外层**：白底、`rounded-[20px]`、`border`、`shadow-sm`。  
- **内层（结论区）**：独立 **渐变 + 边框 + shadow-sm** 的「嵌套卡片」，视觉上已是 **卡片套卡片**。

### 1.2 一句话结论区

- 固定文案标题：**「一句话结论」**（`text-lg font-semibold`），与模型输出无关。  
- 正文：`answer.conclusion` 经 `renderTextWithCitations` 渲染。  
- 元信息：问题 + 模型名（小号灰字）在结论区顶部。

### 1.3 「你现在最该做」「风险提示」「可执行操作步骤」「法律依据」

均在主卡片内、结论嵌套卡片 **之下**，`mt-4 space-y-3` 中 **各自为一块**：

| 区块 | 视觉 | 主要 class 语义 |
|------|------|----------------|
| 你现在最该做 | 独立浅绿底卡片 | `rounded-[14px] border border-emerald-200/70 bg-emerald-50/55` |
| 风险提示 | 独立浅黄底卡片 | `rounded-[14px] border border-amber-200/85 bg-amber-50/90` |
| 可执行操作步骤（条件） | 独立浅蓝底卡片 | `rounded-[14px] border border-sky-200/65 bg-sky-50/45` |
| 法律依据 | 独立灰调卡片 | `rounded-[14px] border … bg-[var(--app-surface-muted)]/40` |

因此：**每个 section 都是带 border + 背景色的「子卡片」**，与外层白卡片 + 结论区渐变卡叠加，**割裂感强**。

### 1.4 知识库来源区

`KnowledgeSourcesBlock`：**默认折叠**，头部一条；展开后每条来源再 **小卡片**（`rounded-lg border`），内部还可含摘要与 `line-clamp-2`。

### 1.5 CitationPopover / renderTextWithCitations

- **`renderTextWithCitations`**：按 `(\[\d+\])` 切分，引用号渲染为 **`InlineCitationMark`** 可点/可悬停按钮。  
- **`CitationPopover`**：`absolute` 浮层，`rounded-[14px] border shadow-md ring`，展示法规元数据 + `ScrollArea` 正文。

### 1.6 splitActionLines / ActionChecklistBlock / RiskBulletListBlock

- **`splitActionLines`**：按行首列表模式（`-`、数字编号、`1)` 等）拆块；含 `|` 的表格行则整段保留。  
- **`ActionChecklistBlock`**：每项左侧 **圆形序号/勾选** + 正文（`peelFirstLineListPrefix` 剥编号后 `renderTextWithCitations`）。  
- **`RiskBulletListBlock`**：琥珀色圆点或数字圆标 + 正文。

### 1.7 ActionStepsTable 接入

当 `answer.actionStepsRaw` 非空且 **`parseActionStepsTable`** 解析为表格时：

```530:534:Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx
            {stepsDisplayMode === "table" && parsedStepsTable ? (
              <ActionStepsTable
                rows={parsedStepsTable.rows}
                renderCell={(t) => renderTextWithCitations(t, sourceById)}
              />
```

否则为 pre-wrap 或简单 `ul` 列表；单元格/文本仍走 **`renderTextWithCitations`**。

### 1.8 割裂感主要来自哪里

1. **结论区**：外层白卡片 + **内层渐变边框卡**（双层）。  
2. **四个主题色子区块**（绿/黄/蓝/灰）**各成独立圆角卡片**，竖向 `space-y-3` 堆叠。  
3. **底部操作栏**：`border-t` + 多个按钮。  
4. **知识库来源**：再一块灰底容器 + 展开后多条嵌套 border。  

整体读感接近 **「法规/任务看板」**，而非单段对话流。

---

## 2. 重复标题根因（「一句话结论」与「1) 一句话结论」）

### 2.1 Prompt 是否要求「1) 一句话结论」

**是。** `legal_prompts.py` 明确要求按顺序输出，且第一节标题须为 **`1) 一句话结论`**（与 `2) 你现在最该做` 等同形）：

```36:41:Legal_AI/config/legal_prompts.py
五、回答结构（必须按顺序输出；小节标题须与下列完全一致，以便前端解析）
你必须按以下顺序输出。第 1、2、3、5 节为强制输出；第 4 节「可执行操作步骤」仅在“适合流程化处理”时输出，不适合时必须整节省略（不要写“无”“不适用”“本节略”等占位）。

1) 一句话结论
用 1～3 句生活化、口语自然的中文，直接回答用户最关心的问题。
```

用户模板再次列出 **`1) 一句话结论`** 等标题（第 102–107 行）。

### 2.2 前端是否又显示「一句话结论」

**是。** `QwenKbAnswerCard` **写死**二级标题「一句话结论」，与模型小节标题语义重复：

```498:500:Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx
        <div className="mb-2.5 text-lg font-semibold tracking-tight text-[var(--app-text)]">一句话结论</div>
        <div className="text-[16px] font-medium leading-[1.65] text-[var(--app-text)]">
          {answer.conclusion ? renderTextWithCitations(answer.conclusion, sourceById) : "未获取到回答。"}
```

若 **`answer.conclusion` 仍含** `1) 一句话结论` 或整行标题未剥干净，用户会看到 **UI 标题 + 正文中再次出现标题**，即类似 **「一句话结论」+「1) 一句话结论 …」**。

### 2.3 normalizeAnswer / stripSectionHeaderLine 覆盖情况

`SECTION_HEADER_RULES` 中「一句话结论」相关规则（节选）：

```119:132:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)一句话结论\b/,
    strips: [
      /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)一句话结论(\s*[：:]\s*|\s+)(.*)$/s,
      /^\s*(?:(?:[1１]\s*[)）、.]|[一]\s*[、,，.]|1\s*\.)\s*)一句话结论\s*$/s,
    ],
  },
  {
    kind: "conclusion",
    friendly: true,
    match: /^\s*一句话结论(?:\s*[：:]|\s+$|\s+)/,
    strips: [/^\s*一句话结论(\s*[：:]\s*|\s+)(.*)$/s, /^\s*一句话结论\s*$/s],
  },
```

| 形式 | 是否易匹配 | 说明 |
|------|------------|------|
| `1) 一句话结论` 单独成行 | 通常 **可** | 第二条 strip 可整行吃掉标题 |
| `1) 一句话结论：` / `：` / 空格后正文 | **可** | 第一条 strip 取 `rest` |
| `1）一句话结论` | **可** | `[)）、.]` 含全角 `）` |
| `一、一句话结论` | **可** | `[一]\s*[、,，.]` |
| `1. 一句话结论` | **可** | `1\s*\.` |
| `一句话结论：` / 空格开头正文 | **可** | friendly 规则 |
| **`1、一句话结论`**（顿号） | **易漏** | 数字节只认 `[)）、.]` 等，**不含 `、`**；可能整行落入 conclusion 正文 |
| **标题与正文同一行且中间无空格/标点** | **易漏** | `一句话结论\b` 在 JS 默认正则中对中日文边界敏感；**紧随汉字继续写**时，`\b` 可能不匹配，导致 **整行不被识别为标题** |
| `match` 成功但 **strip 全部不命中** | **会原样写入正文** | 见下 |

当 **`matchSectionHeader` 为真而 `stripSectionHeaderLine` 未命中任何 `strips`** 时，逻辑会把 **整行原样 `push` 进当前 bucket**（等价于未剥离）：

```577:588:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
    if (rule) {
      const { rest, stripped } = stripSectionHeaderLine(line, rule);
      if (!stripped) {
        buckets[mode].push(line);
        continue;
      }
```

### 2.4 标题独立成行 vs 与正文同一行

- **独立成行**：与 prompt 一致时，多数 **`1) …` / `一句话结论：`** 形式可被剥离。  
- **同一行**：依赖 `strips` 能否从该行剥出 `rest`；** peelFollowingSection** 只对 **`basis` / `risks` / `actionAdvice` / `actionSteps`** 在后文做「从一段里拆尾部小节」，**不对 `conclusion` 做「一行内去掉 1) 一句话结论」的专门处理**。若标题与长句粘在同一行且格式略偏，**更容易残留**。

### 2.5 answer.conclusion 是否仍可能含标题

**可能。** 原因包括但不限于：

1. 模型使用 **未在规则中的编号形式**（如 `1、一句话结论`）。  
2. **`\b` + 中文紧贴**导致 **match 失败**，整行进入 conclusion。  
3. **strip 失败** 的边界行被原样写入。  
4. **旧会话**：`answerCard` 在本地已持久化；若当时解析不同或模型输出不同，**历史消息**仍可能展示带标题的正文（**raw `content` 字段**若在某处展示也会与卡片不一致，但当前卡片主路径用 **`answerCard.answer`**）。

### 2.6 根因归纳（重复标题）

- **产品层**：Prompt **强制**输出 `1) 一句话结论`，UI **又固定渲染**「一句话结论」——**天然重复风险**。  
- **解析层**：`normalizeAnswer` **多数情况**能剥标题，但 **编号变体、strip 失败、`\b` 与中文边界、单行粘连** 会导致 **`conclusion` 残留标题行**。  
- **数据层**：**旧 localStorage 会话** 可能长期携带未完美剥离的 `answer` 结构。

---

## 3. 法律依据模块是否可以弱化

### 3.1 当前展示

- **`basisBody`** 来自 `answer.basis` / `details[0]`，空则用 **`PLACEHOLDER_BASIS`**。  
- 在 UI 中为 **独立一块**「法律依据」灰底圆角卡片（见 1.3），**始终占位**，视觉面积与绿/黄块同级。

### 3.2 与知识库来源的关系

- **法律依据**：模型生成的 **短文字摘要** + `[n]`，偏「论证说明」。  
- **知识库来源**：结构化 **法规名、章节、时效、链接、正文摘要**，与 `[n]` 一一对应。  

二者 **信息部分重叠**（都在谈「依据哪条法」），用户容易感觉 **法律依据块偏大、偏「报告」**。

### 3.3 弱化方向（分析结论，非实现）

- 适合改为 **「引用依据」折叠** 或 **默认仅一行摘要**，详细条文仍在 **知识库来源** + **CitationPopover**。  
- 保留 **`[n]`** 与 `renderTextWithCitations` 即可维持可追溯，无需删数据字段。

---

## 4. 推荐改法（稳妥方向，供 B-1）

### 4.1 减少卡片割裂

- **合并视觉层级**：结论区减少「白卡 + 渐变内卡」双层；下方区块改为 **轻分隔**（`divide-y` / 细线 / 弱背景）而非四张重彩卡片。  
- **统一圆角与阴影**：仅最外层保留强 shadow，内部用 **spacing + typography** 区分章节。

### 4.2 修复重复标题

- **解析**：扩展 `SECTION_HEADER_RULES`（如 **`1、一句话结论`**、全角标点）；评估 **`一句话结论\b`** 在中文场景下的可靠性，必要时改为 **显式后缀判断** 或 **剥头正则** 不依赖 `\b`。  
- **展示**：结论区 **不再写死「一句话结论」**，改为 **更口语的引导**（如「结论」）或 **仅展示正文**；或在 normalize 成功后 **保证** `conclusion` 不含重复标题。  
- **Prompt 与前端对齐**：长期可讨论是否改为友好标题-only，减少 `1)` 与 UI 双轨。

### 4.3 弱化法律依据、保留可追溯

- UI：**折叠 / 小号 / 默认收起**；正文区仍保留 **`[n]`** 悬浮。  
- 数据：**仍存 `basis` / details**，兼容历史。

### 4.4 保留 [n] 引用悬浮与知识库来源折叠

- **勿改** `CITATION_SPLIT_RE`、`InlineCitationMark`、`CitationPopover` 行为，仅调整外层布局。  
- `KnowledgeSourcesBlock` 已 **默认折叠**，可保持。

### 4.5 兼容历史会话

- 仅改 **渲染层** 时：旧 `QwenAnswer` 仍可显示。  
- 若改 **normalizeAnswer**：新消息变好；**旧 answerCard** 除非重跑或迁移，仍可能带残留标题——可在渲染前加 **轻量 sanitize**（仅去已知标题前缀）且 **不破坏正文中的合法枚举**。

---

## 5. 风险点（修改时避免）

1. **`[1]` 引用**：勿在全局 `replace` 中误伤 `renderTextWithCitations` 依赖的 **`[n]`** 格式。  
2. **正文中的合法编号**：列表解析（`splitActionLines` / `peelFirstLineListPrefix`）与法律依据剥离规则需 **区分「小节标题」与「正文编号」**。  
3. **ActionStepsTable**：勿改 `parseActionStepsTable` 与表格列约定；单元格仍应走 **`renderTextWithCitations`**。  
4. **CitationPopover**：勿改定位与 `sourceById` 映射逻辑，避免破坏悬浮详情。  
5. **localStorage**：勿改会话 JSON 结构；若做 normalize 升级，需 **向后兼容** 缺字段与旧 `details` 形态。

---

## 6. 直接回答清单

### 当前重复标题根因

**Prompt 要求 `1) 一句话结论` + 卡片固定标题「一句话结论」** 叠加；**`normalizeAnswer` 在部分编号/行格式下未剥离干净**（含 **`1、`、strip 失败、`\b` 与中文、标题粘连同一行** 等），导致 **`answer.conclusion` 残留标题**。

### 当前割裂感主要来自哪些区块

**结论区双层卡片** + **绿/黄/蓝/灰四个独立子卡片** + **底部按钮栏** + **来源区嵌套**。

### 推荐的 B-1 修改范围（建议）

| 区域 | 建议涉及 |
|------|----------|
| **视觉** | `QwenKbAnswerCard.tsx` 布局与 class（不动卡片内部业务子组件逻辑时可只改容器） |
| **重复标题** | `page.tsx` 中 `SECTION_HEADER_RULES` / `stripSectionHeaderLine` + 或卡片标题文案 |
| **风格与结构约束** | `legal_prompts.py`（若要与解析/UI 长期一致） |

---

## 7. 报告路径与命令结果

- **报告路径：** `Legal_AI/docs/answer-card-layout-audit.md`  
- **`npm run lint`：** 通过  
- **`npm run build`：** 通过  
