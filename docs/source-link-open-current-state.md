# 「查看原文」链接打开方式 — 当前实现审计

**审计日期：** 2026-05-09  
**范围：** Legal_AI 前端；未修改任何业务代码。  
**背景问题：** 点击「查看原文」访问国家法律法规平台时出现黑屏；本文档仅记录当前代码如何打开 `source_url` / `sourceUrl`，供后续改动决策。

---

## 1. 「查看原文」入口数量

**共 3 处**（文案均为「查看原文」，`grep` 全仓仅命中以下文件）。

| # | 文件 | 组件 / 位置 |
|---|------|-------------|
| 1 | `Legal_AI/frontend/src/components/chat/CitationSidePanel.tsx` | `CitationSidePanel` — 「来源链接」`dd` 内 |
| 2 | `Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx` | `KnowledgeSourcesBlock` — 展开后每条来源行尾部 |
| 3 | `Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx` | `CitationPopover` — 「来源链接」`dd` 内 |

---

## 2. `CitationSidePanel.tsx` 细节

### 2.1 渲染位置

- 在「引用详情」侧栏中，`dl` → 「来源链接」→ `dd` 内。
- URL 取自：`const url = source?.sourceUrl?.trim();`（见约第 92、160 行）。

### 2.2 打开方式

- **`<a href={url}>`** 原生链接，**非** `window.open`、**非** `router.push`。

### 2.3 `target` / `rel`

- **`target="_blank"`**：是。
- **`rel="noreferrer"`**：是（**未**写完整字符串 `noopener noreferrer`；见下文章节 6）。

### 2.4 `stopPropagation`

- **未**在「查看原文」`<a>` 上调用 `stopPropagation`。
- 该链接不在「可点击整行打开侧栏」的容器内，侧栏内容由 `source` 直接渲染，**无**父级 `onClick` 需避让（与 `KnowledgeSourcesBlock` 不同）。

### 2.5 右侧引用栏 / 侧栏切换

- **无** `iframe`、**无**内嵌外部网页逻辑。
- 本组件只负责展示；打开链接为浏览器新开标签，**不应**因本链接直接触发「切换引用条目」（无关联点击处理）。

### 2.6 字段名

- 展示层统一使用 TypeScript 类型 `QwenKbSource.sourceUrl`（camelCase）。
- 后端/API 若返回 `source_url`，在装配为 `QwenKbSource` 时已做归一（见下文第 8 节）。

---

## 3. `QwenKbAnswerCard.tsx` 细节

### 3.1 `CitationPopover` 内的「查看原文」

- **有**：与侧栏类似，在「来源链接」小节。
- URL：`source.sourceUrl?.trim()`。
- 打开方式：**`<a href={url} target="_blank" rel="noreferrer">`**（与 `CitationSidePanel` **同类**：原生 `a` 标签）。
- **未**在 `<a>` 上写 `stopPropagation`。
- 注意：弹层根节点有 **`onMouseDown={(e) => e.preventDefault()}`**（约第 517 行），用于与外部点击关闭等交互配合；一般**不会**阻止 `<a>` 的 **click** 导航，但若遇极端浏览器差异，可作为后续排查点。

### 3.2 `KnowledgeSourcesBlock` 内的「查看原文」

- **有**：展开后每条来源一行，行尾「查看原文」或「未提供」。
- URL：`source.sourceUrl?.trim()`。
- 打开方式：同样是 **`<a href={url} target="_blank" rel="noreferrer">`**。
- **额外行为**：`<a>` 上同时有 **`onClick={(e) => e.stopPropagation()}`** 与 **`onMouseDown={(e) => e.stopPropagation()}`**（约第 481–482 行），避免点击链接时冒泡到外层 **`div` 的 `onClick` → `onSourceClick`**（否则会打开右侧引用详情并可能切换当前引用）。

### 3.3 实现是否统一

- **三处均为同一种核心机制**：带 `target="_blank"` 的 **`<a href>`**。
- **差异仅一处**：`KnowledgeSourcesBlock` 对链接做了 **冒泡阻断**；`CitationSidePanel` 与 `CitationPopover` 未加（当前结构下侧栏/弹层内通常也不需要）。

---

## 4. 全仓检索：其它相关用法

在 `Legal_AI/frontend/src` 内检索：

| 模式 | 结果（与法规原文链接相关） |
|------|---------------------------|
| `查看原文` | 仅上述 3 处 |
| `window.open` | **无**匹配 |
| `iframe` | **无**匹配 |
| `router.push` | 仅 `kb-update` 等流程页，**与** `source_url` **无关** |

`ProcessTimeline.tsx` 等仅负责把 API 的 `source_url` / `sourceUrl` 映射进 `QwenKbSource.sourceUrl`，**不包含**「查看原文」UI。

---

## 5. `iframe` / `router.push` / 当前页跳转

| 方式 | 用于打开法规 `sourceUrl`？ |
|------|---------------------------|
| `iframe` | **否**（源码中无） |
| `router.push` | **否** |
| 当前页 `location` 替换 | **否**；均为 **新标签** `target="_blank"` |

---

## 6. `target="_blank"` 与 `rel`

- **三处均已** `target="_blank"`。
- **三处均为** `rel="noreferrer"`（**不是**字面量 `rel="noopener noreferrer"`）。
- 说明：在现行 HTML 规范与常见浏览器中，`noreferrer` 对 `target="_blank"` 的导航通常会同时带来 **noopener** 类行为；若合规/审计要求字面量包含 `noopener`，可列为后续小改动。

---

## 7. 事件冒泡与右侧栏

| 入口 | 是否会因点击「查看原文」误触侧栏/引用切换？ |
|------|---------------------------------------------|
| `CitationSidePanel` | **风险低**：链接无包在「整行打开侧栏」的 `onClick` 里。 |
| `CitationPopover` | **风险低**：弹层在引用标记的 `span` 内；无整行 `onSourceClick`。 |
| `KnowledgeSourcesBlock` | **已防护**：链接 **`stopPropagation`**，避免触发外层 `onSourceClick`。 |

---

## 8. `source_url` 字段与兼容性

- **前端类型**（`Legal_AI/frontend/src/types/index.ts`）：`QwenKbSource.sourceUrl: string | null`。
- **API 蛇形命名**：在装配为 `QwenKbSource` 时多处使用 **`source_url ?? sourceUrl`**，例如：
  - `new-feature-chat/page.tsx`：`normalizeSources` 的 `pickUrl`、`citations` 映射（约 1103–1143 行）及流式/历史路径中的同类映射（约 145–150 行）；
  - `ProcessTimeline.tsx`：`sourcesFromCitationSummary`（约 68–73 行）。
- **结论**：只要后端返回 `source_url` 或 `sourceUrl` 之一，前端会归一为 **`sourceUrl`**；组件内**不**直接读 `source_url` 字符串键。

---

## 9. 建议的下一步（仅建议，本次未改代码）

1. **确认「黑屏」发生位置**：当前实现均为 **新标签打开** 目标 URL。若黑屏出现在**新标签**内，则更可能是目标站（如反爬、`X-Frame-Options`、脚本检测、需特定 Referer/User-Agent 等）而非本应用内嵌；本仓库**无** iframe 嵌入该站。
2. **若需与应用同窗口打开**：需产品决策；当前代码**未**使用 `router.push` 到外部法规 URL（也不建议把外部 URL 当站内路由）。
3. **若需与微信/内置浏览器兼容**：可评估 `window.open` + 降级为 `location.href` 等策略（属行为变更，需单独设计与测试）。
4. **一致性**：若希望三处链接行为完全一致，可考虑是否给 `CitationSidePanel` / `CitationPopover` 也加上与 `KnowledgeSourcesBlock` 相同的 `rel` 文案或冒泡处理（侧栏场景下收益有限）。
5. **抓包/实机**：对实际 `sourceUrl` 做一次网络与响应头检查（重定向链、CSP、`Content-Type`），与「黑屏」是否白屏/脚本错误对应。

---

## 10. 构建与 Lint

| 命令 | 工作目录 | 结果 |
|------|----------|------|
| `npm run lint` | `Legal_AI/frontend` | **通过** |
| `npm run build` | `Legal_AI/frontend` | **通过**（Next.js 16.2.1 webpack 生产构建成功） |

**报告路径：** `Legal_AI/docs/source-link-open-current-state.md`
