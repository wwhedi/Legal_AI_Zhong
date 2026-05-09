# sourceUrl 归一化与 [1]–[5] 一致性 — 代码审计

**审计日期：** 2026-05-09  
**范围：** Legal_AI 前端（未改代码、无运行时抓包）。  
**现象（用户描述）：** 同一次回答里 [1][2][3][4][5] 看起来都是同一《民法典》法规平台地址，但只有 [3] 点「查看法规页面」能打开，其余黑屏。本仓库 UI 文案为「查看原文」，逻辑上等价于「打开 `sourceUrl`」。

---

## 1. [1][2][3][4][5] 的 sourceUrl 是否「完全一致」

**仅凭静态代码无法断言「一定一致」或「一定不一致」。**

依据：

- 最终落在 `QwenKbAnswerCard` 的 `sources` 中，**每一条引用对应 citations 数组里的一条独立记录**；`sourceUrl` 来自该记录上的 `source_url` / `sourceUrl` 字段经 **`String(…).trim()`** 后的结果（见下文）。
- 前端 **没有** 把多条引用的 URL 合并、去重或强制同步为同一字符串；若后端对 [1]–[5] 返回了不同字符串（哪怕肉眼相似），前端会 **原样保留差异**。

因此：**是否完全一致取决于后端/流式事件载荷，而非前端展示层。** 若只有某一编号可打开，从代码路径看，**优先怀疑各条 `sourceUrl` 实际并不相同**（或流式阶段与终态数据源不一致），需在浏览器 DevTools Network / 日志中对每条 citation 的原始 JSON 做 **逐字符** 对比才能定论。

---

## 2. 若不一致，差异可能是什么（代码允许的形态）

在仅做 `trim` 的前提下，下列差异都会进入 `QwenKbSource.sourceUrl` 并影响 `href`（在通过 `isValidExternalUrl` 时）：

| 类型 | 是否可能被保留 |
|------|----------------|
| 首尾空格 | 否（`trim` 去掉） |
| **中间** 空格、换行、制表符 | **是** |
| 零宽字符等（如 U+200B）、其它不可见控制符（若不在 `trim` 去除范围内） | **可能在字符串中间保留** |
| `http` vs `https` | **是**（视为不同字符串；均为合法外链） |
| query、`#hash`、路径大小写、是否末尾 `/`、百分号编码形式（已编码 vs 未编码） | **是**（字符串级比较不一致即不一致） |
| 同站「看起来一样」但路径或参数不同 | **是** |

---

## 3. 是否存在空格、换行、不可见字符

- **首尾：** `pickUrl` 与 `kbSourcesFromRagEvents` 内对 URL 均使用 **`String(su).trim()`**，可去除常规首尾空白。
- **中间：** **无** 专门剔除换行、统一空白、剥离零宽字符的逻辑；**若 API 在 URL 中间插入换行或零宽字符，会原样进入 `sourceUrl`**（直至 `new URL()` 在 `isValidExternalUrl` 中解析失败则链接不展示）。

---

## 4. 前端引用数据：`QwenKbAnswerCard` 与每条 `source.sourceUrl`

- 卡片通过 **`sources: QwenKbSource[]`** 渲染；`sourceById` 以 **`s.id` 为键** 映射，`[n]` 与 `id === n` 的条目对应。
- 每条目的 `sourceUrl` **仅来自该条目对象**，不在卡片内与其它 id 合并。

**重要：同一轮回答存在两套构造 `QwenKbSource[]` 的路径（可能内容不一致）：**

| 阶段 | 数据来源 | 构造函数 | URL 字段逻辑 |
|------|----------|----------|----------------|
| **流式生成中**（`loading && !streamHasAnswer`，有草稿正文时） | `kb_retrieve_done` 事件里的 **`citations_summary`** | `kbSourcesFromRagEvents`（`page.tsx`） | `source_url ?? sourceUrl` → `String(…).trim()`，空则 `null` |
| **answer 事件落库后**（历史消息与生成结束后的气泡） | 最终 **`answer.citations`** | `normalizeSources` + **`pickUrl`** | 同上：`String(…).trim()`，空则 `null` |

因此：**用户若在流式过程中点 [n]，与生成结束后点 [n]，理论上可能读到不同 `sourceUrl`**（若 `citations_summary` 与最终 `citations` 各条字段不一致）。  
「只有 [3] 能打开」若在**终态消息**上复现，应重点对比 **终态 `citations` 数组里 ref_id=1,2,3,4,5 的 `source_url`/`sourceUrl` 原始值**。

---

## 5. URL 归一化逻辑：`normalizeSources` / `pickUrl`

**`pickUrl`（`new-feature-chat/page.tsx`）：**

- 读取 `obj.source_url ?? obj.sourceUrl`；
- `null` → `null`；
- 否则 **`String(v).trim()`**，若结果为空串 → `null`。

**`normalizeSources`：**

- 对每条 citation 调用 **`pickUrl(item)`**；
- **仅 trim**，无 `encodeURI`/`decodeURI`、无协议强制、无去零宽、无统一 host/path。

**`kbSourcesFromRagEvents`：**

- 与上相同的 **IIFE：`source_url ?? sourceUrl` + `String(s).trim()`**。

**结论：** 当前归一化 **等价于「选字段 + 首尾 trim」**；**不需要** 在审计报告里假装已实现 `normalizeExternalUrl`——**代码里尚未存在**该层；是否在业务上需要，见第 8 节建议。

**`isValidExternalUrl`（`lib/utils.ts`）：**

- 在 **`trim` 后** 用 `new URL(s)` 校验，**仅允许 `http:` / `https:`**；
- 用于控制「查看原文」是否渲染，**不改变** 存入状态的字符串内容。

---

## 6. 打开链接逻辑：三处是否同源、同字段

| 位置 | 字段 | 处理 |
|------|------|------|
| `CitationSidePanel` | `source?.sourceUrl` | `trim` + `isValidExternalUrl` → `<a href={safeUrl}>` |
| `CitationPopover` | `source.sourceUrl` | 同上 |
| `KnowledgeSourcesBlock` | `source.sourceUrl` | 同上 |

- **未** 发现某处改用其它字段名（如单独的 `source_url` 原始键）。
- **未** 发现某处绕过 `source` 对象使用未清理的全局 URL。

侧栏中的 `source` 来自 **`openCitationDetail(source, …)`**，即当前消息 **`sources` 数组中的同一个对象引用**（与正文 `[n]`、知识库来源行一致）。

---

## 7. 审计结论摘要（对应用户输出清单）

1. **[1]–[5] 的 sourceUrl 是否完全一致：** **代码不能保证一致**；需对单次回答的 JSON **按 ref_id 逐条比对** 才能回答「是/否」。
2. **若不一致，差异是什么：** 可能是 **中间空白/控制字符**、**编码/参数/hash**、**http/https** 等；或 **流式 `citations_summary` 与终态 `citations` 不一致**。
3. **空格/换行/不可见字符：** **仅去除首尾空白**；中间换行等 **不会** 被当前逻辑清除。
4. **是否需要增加 URL 规范化函数：** 若实锤存在「肉眼相同、字节不同」或脏字符，**值得** 增加集中式 **`normalizeExternalUrl`（或类似）**：例如去除零宽与中间空白、可选 https 升级、`URL` 规范化等——**本次审计不修改代码，仅作建议。**
5. **未修改代码**（本文件仅为报告）。

---

## 8. 建议的下一步（验证优先）

1. 在复现「只有 [3] 能打开」时，对 **终态** `answer.citations` 中 **id 1–5** 打印或复制 **`source_url` / `sourceUrl` 的原始 JSON 字符串**（建议十六进制或 `JSON.stringify` 全量对比）。
2. 若正在流式阶段复现，再对比 **`kb_retrieve_done.citations_summary`** 与同 ref_id 的终态 citation 是否相同。
3. 确认黑屏发生在 **新标签页** 还是应用内；当前前端为 **`target="_blank"` 的普通 `<a>`**，无 iframe。

---

## 9. Lint / Build

在 `Legal_AI/frontend` 执行（2026-05-09 审计时）：

- `npm run lint`：**通过**
- `npm run build`：**通过**

**报告路径：** `Legal_AI/docs/source-url-normalization-audit.md`
