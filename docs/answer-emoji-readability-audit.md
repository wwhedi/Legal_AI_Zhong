# 回答卡片 Emoji / Icon 使用审计报告

**审计日期：** 2026-05-07  
**范围：** 只读 `QwenKbAnswerCard.tsx` 及关联子块（含 `ActionStepsTable` 展示路径）；**未修改任何代码**。  
**命令：** `cd Legal_AI/frontend` → `npm run lint`、`npm run build` → **均通过**。

---

## 1. `QwenKbAnswerCard.tsx` 各区块

| 区块 | Emoji | Icon（Lucide / SVG） | 其它视觉标记 |
|------|-------|----------------------|--------------|
| **结论** | 无 | 无 | 左侧色条 + 浅底（CSS） |
| **你现在最该做** | 无 | **有**：清单项在「项目符号」分支使用 **`Check`**（`lucide-react`）；编号项为 **圆圈内数字**（纯文本） | 圆角边框 + 浅色背景（CSS） |
| **风险提示** | 无 | 无 | 编号项：**圆圈内数字**；非编号：**小圆点**（`span` + `rounded-full`） |
| **可执行操作步骤** | 无 | 无（表格模式走 `ActionStepsTable`） | 列表模式：**小圆点**；表格为常规 `<table>` |
| **引用依据** | 无 | 无 | 文字按钮「引用依据 · 展开/收起」 |
| **知识库来源** | 无 | 无 | 文案中的 **间隔号 `·`**、字段间 **竖线 `｜`**（标点，非 emoji） |

**补充：`CitationPopover` / `InlineCitationMark`**  
- 无 emoji；引用号为 **可点击文字按钮** `[n]`，非图标。

**补充：`ActionStepsTable.tsx`（卡片内嵌）**  
- 表头/单元格均为 **纯文本**；无 lucide、无 emoji。

---

## 2. 项目依赖与图标体系

- **`package.json`** 已声明 **`lucide-react`**（如 `^1.7.0`）。  
- **`QwenKbAnswerCard.tsx`** 当前仅从 `lucide-react` 引入 **`Check`**。  
- 同仓库其它页面（如 `new-feature-chat/page.tsx`）也广泛使用 **lucide**（`Bot`、`Send`、`Loader2` 等），**图标语言已统一为 Lucide 系**。

---

## 3. Emoji vs Lucide：统一性结论

- **当前卡片几乎不使用 emoji**；结构化标记主要靠 **色块、圆点、圆圈数字、一个 `Check` 图标**。  
- **与全站一致**：继续用 **lucide**（或纯 CSS 几何形）比引入 **emoji** 更易控制 **字号、对齐、深色模式、无障碍**，且避免 **各系统 emoji 字形差异**（Windows / macOS / Android）。  
- **Emoji 适用场景**（若产品刻意要更轻松）：仅适合 **非法规正文** 的极少量装饰（例如节标题旁），需接受 **复制、读屏、法条严肃感** 的代价。

---

## 4. 不宜插入 Emoji 的位置（与当前实现一致）

以下区域应保持 **纯文本或可预测 UI**，**不建议**在渲染层额外插入 emoji：

1. **法规名称**（`source.lawName`、表格/来源行）  
2. **法规正文**（`source.text`、`CitationPopover` 内 ScrollArea）  
3. **引用编号 `[n]`**（`InlineCitationMark` 的 `label` 与可交互按钮文案）  
4. **`source_url` / 「查看原文」链接**（`href` 与锚文本应保持 URL 与可读链接语义）

**模型生成正文**（`conclusion` / `basis` / 清单字符串）中若自带 emoji，属于 **内容层**，与本次「卡片 UI 是否用 emoji」不同；前端未做过滤。

---

## 5. 对「复制回答」的影响

- **当前**：`复制` 按钮走父组件传入的 **`onCopy`**（`QwenKbAnswerCard` 内未实现具体剪贴板逻辑）。  
- **一般行为**：若实现为 **拼接纯文本**（从 `answer` 字段组装），则 **Lucide `Check`、CSS 圆点不会进入剪贴板**。  
- **若实现为 `innerText` / 选区复制 DOM**：可能带入 **极少 UI 字符**；`Check` 为 SVG，通常 **不会** 变成 emoji，但 **可能引入不可见或异常空白**。  
- **Emoji**：若将来加在节标题或按钮上，**纯文本复制**时可能被复制为 **Unicode 字符**，与「法规严肃 / 公文」风格冲突。

---

## 6. 建议方案对比

### 6.1 Emoji 方案

- **优点**：情绪亲和、实现快（字符串拼接）。  
- **缺点**：跨平台显示不一；与法律场景 **气质可能冲突**；复制与无障碍难控。

### 6.2 Lucide（+ 现有 CSS 标记）方案

- **优点**：与 **`package.json` 及全站** 一致；尺寸/颜色/暗色主题可控；**不污染法条与 `[n]`**。  
- **缺点**：需为各区块选图标并调间距（工作量略大于贴 emoji）。

### 6.3 最推荐

**推荐：以 Lucide + 轻量 CSS（圆点/左边线）为主，避免在卡片 UI 中引入 emoji。**  
若需强化「你现在最该做」与「风险提示」的差异，可 **替换/补充** 与语义匹配的 lucide（如 `ListChecks`、`AlertTriangle`、`ListOrdered`），仍放在 **列表左侧装饰列**，不进入 `renderTextWithCitations` 输出的正文流。

---

## 7. 报告路径与命令结果

- **报告路径：** `Legal_AI/docs/answer-emoji-readability-audit.md`  
- **当前是否已有图标：** **有**——仅 **`Check`（lucide）** 用于行动清单的 bullet 行；其余为 CSS 圆点/数字圈。  
- **推荐方案：** **Lucide + CSS（不推荐卡片 UI 使用 emoji）**  
- **`npm run lint`：** 通过  
- **`npm run build`：** 通过  
