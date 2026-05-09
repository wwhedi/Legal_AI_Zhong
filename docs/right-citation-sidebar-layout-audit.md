# new-feature-chat 布局审计：左侧会话栏与右侧引用栏目标

**审计日期**：2026-05-09  
**范围**：`Legal_AI/frontend/src/app/new-feature-chat/page.tsx`、`Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx`  
**约束**：本文件为只读审计结论，不包含对业务代码的修改。

---

## 执行结果（CI）

| 命令 | 目录 | 结果 |
|------|------|------|
| `npm run lint` | `Legal_AI/frontend` | 通过 |
| `npm run build` | `Legal_AI/frontend` | 通过 |

**报告路径**：`docs/right-citation-sidebar-layout-audit.md`（仓库根目录下 `docs/`）

---

## 1. `new-feature-chat/page.tsx` 布局要点

### 1.1 最外层是 flex 还是 grid？

- **flex（横向）**。根内容区为：

```1662:1663:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
      <div className="flex h-full min-h-0 min-w-0 w-full overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)]">
        <aside
```

- **未使用 CSS Grid** 作为主布局；中间列为 `flex-1 flex-col`。

### 1.2 左侧会话栏宽度如何控制？

- **桌面（`md:` 及以上）**：`<aside>` 为 `hidden md:flex`，宽度由 Tailwind 类在展开/收起间切换：
  - 展开：`w-[280px]`
  - 收起：`w-16`
- 使用 `shrink-0`、`transition-[width] duration-200`，避免侧栏被压缩，宽度动画平滑。
- **移动端**：侧栏不在主 flex 流中；通过 `mobileSessionsOpen` 使用 **`fixed inset-0` 全屏遮罩 + `absolute` 左侧抽屉**（`w-[min(280px,85vw)]`），与桌面逻辑分离。

### 1.3 左侧收起时正文区如何变化？

- 侧栏物理宽度从 `280px` 变为 `64px`，中间列因 **`flex-1 min-w-0`** 占据剩余空间，**可视区域变宽**。
- 页面用 **`sessionSidebarCollapsed`** 驱动一组 **max-width 与比例** 的切换（非仅依赖 flex 自动拉伸）：

```1617:1622:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
  const chatContentMaxClass = sessionSidebarCollapsed ? "max-w-[1200px]" : "max-w-6xl";
  const assistantColMaxClass = sessionSidebarCollapsed
    ? "max-w-[min(100%,72rem)]"
    : "max-w-[min(100%,52rem)]";
  const userBubbleMaxClass = sessionSidebarCollapsed ? "max-w-[min(76%,44rem)]" : "max-w-[70%]";
  const composerMaxClass = sessionSidebarCollapsed ? "max-w-[860px]" : "max-w-[760px]";
```

- **含义**：收起左侧后，中间内容区与输入框的 **上限宽度更大**（更“铺满”中间列），与“多出约 216px 水平空间”的体验一致。

### 1.4 中间聊天区 max-width / width / flex-1

| 区域 | 关键 class |
|------|------------|
| 中间列容器 | `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden` |
| 顶部状态条外层 | `mx-auto … w-full …` + `chatContentMaxClass`（`max-w-6xl` 或 `max-w-[1200px]`） |
| 消息滚动区 | `min-h-0 flex-1 overflow-x-hidden overflow-y-auto` |
| 消息区内层 | `mx-auto w-full …` + 同上 `chatContentMaxClass` |
| 助手消息列 | `assistantColMaxClass`（见上表） |
| 用户气泡 | `userBubbleMaxClass` |

- 中间列 **`flex-1`** 吃满侧栏以外的宽度；**`min-w-0`** 防止 flex 子项溢出导致布局撑破。
- 正文“可读宽度”主要由 **`chatContentMaxClass` + `assistantColMaxClass`** 叠加控制（`mx-auto` 居中）。

### 1.5 输入框宽度如何跟随中间聊天区？

- 输入区外层：`shrink-0 bg-transparent px-3 … md:px-4`。
- 输入框容器：`mx-auto flex w-full min-w-0 …` + **`composerMaxClass`**（`max-w-[760px]` / `max-w-[860px]`），与 **`sessionSidebarCollapsed`** 同步变化。
- **结论**：输入框与消息区 **共用同一套“随左侧收起而放宽上限”的策略**，但并非与某单一 DOM 父节点强制同宽，而是通过 **相同的 collapse 状态 + 各自的 max-width token** 对齐视觉。

### 1.6 是否已有 `sidebarCollapsed` / `chatSidebarOpen` 等？

- **`sessionSidebarCollapsed`**（`useState(false)`）：桌面左侧会话栏展开/收起。
- **`mobileSessionsOpen`**：移动端历史抽屉开关。
- **无** `chatSidebarOpen` 命名；右侧引用无对应状态。

### 1.7 是否适合新增 `rightCitationSidebarOpen`？

- **适合**。页面已存在 **模式相同的布尔状态**（`sessionSidebarCollapsed`、`mobileSessionsOpen`），且中间区宽度已通过 **派生 class 变量** 集中管理；新增右侧栏时，可同样用布尔状态驱动：
  - 第三栏 `aside` 的宽度（`0` / `w-…`）或 `hidden`；
  - 以及可选的 **`chatContentMaxClass` / `assistantColMaxClass` / `composerMaxClass`** 三元组合（避免三栏同时存在时正文仍按“仅左栏折叠”的旧表取值过宽）。

### 1.8 是否适合改成三栏 flex：左会话 + 中聊天 + 右引用？

- **适合作为推荐方向**，理由：
  1. 与现有 **顶层横向 `flex`** 一致，右侧栏可与左侧 **`aside` 对称**（同为 `shrink-0` + 定宽或动画宽度），中间保持 **`flex-1 min-w-0`**，打开右栏时正文 **自然缩窄**，**无需**依赖 `fixed` 浮层占视口。
  2. 与产品目标一致：“右侧栏打开时中间聊天正文区域随之缩窄，而不是被浮层遮挡。”
- **注意**：移动端可能需要与左侧类似的 **抽屉 / 全屏** 策略，或窄屏下右栏改为 **bottom sheet / 全屏详情**，避免三栏在极小宽度下挤压到不可用（当前页已在移动端对左侧采用 `fixed` 抽屉）。

---

## 2. `QwenKbAnswerCard.tsx`：引用 `[n]` 与浮层

### 2.1 当前 `[n]` 点击逻辑在哪里？

- 在 **`InlineCitationMark`** 内：`<button onClick={toggle}>`，`toggle` 切换本地 **`open`**；另有 **`hover`** 与 `visible = open || hover`。
- 正文各处通过 **`renderTextWithCitations`** 将 `[数字]` 拆分为 `InlineCitationMark`。

### 2.2 是否可通过 `onCitationClick` 通知 `page.tsx`？

- **当前组件未暴露** `onCitationClick`（或类似）prop；`QwenKbAnswerCardProps` 仅有 `onRegenerate` / `onCopy` / `onFeedback`。
- **技术上可行**：在 `InlineCitationMark` 或 `renderTextWithCitations` 链路增加可选回调（如 `onCitationClick?: (source: QwenKbSource) => void`），点击时 `stopPropagation` 后调用，即可在 `page.tsx` 打开右侧栏并传入选中引用。**本次审计不修改代码**，仅作实现建议。

### 2.3 `CitationPopover` 是否会遮挡正文？

- **会，属于叠层 UI，而非推开布局**。
- `CitationPopover` 使用 **`absolute left-1/2 top-full … z-50`**，相对于 **`relative inline`** 的包裹 `span` 定位；卡片宽度 `w-[min(22rem,calc(100vw-2rem))]`。
- **影响**：Popover 在流式布局中 **覆盖下方内容**，不占用文档流高度；靠近视口底部时也可能被裁剪或压到滚动区域外（取决于父级 `overflow`）。消息滚动容器为 **`overflow-y-auto`**，popover 在滚动子树内时一般随内容滚动，但仍 **遮挡** 其下方的文字而非“撑开”正文。

---

## 3. `CitationSidePanel` 组件

- **仓库内未发现** 名为 `CitationSidePanel` 或 `CitationSide*` 的组件（前端目录检索无匹配）。
- **若新建**，建议：
  - **桌面**：作为 **`page.tsx` 顶层 flex 的第三个 `aside`**（或主 flex 内与中间列并列的兄弟节点），`shrink-0`、`min-h-0`、`overflow-y-auto`，宽度固定或 `transition-[width]`，与左侧会话栏实现方式对齐。
  - **避免** 用 `fixed`/`absolute` 铺满右侧作为唯一实现（除非单独处理移动端），否则易回到“遮挡中间正文”的问题。
  - 内容可复用 `CitationPopover` 内的信息结构（法规字段 + 条文 ScrollArea），抽成共享展示组件以减少重复。

---

## 4. 汇总回答（用户要求的短清单）

1. **当前左侧侧栏如何实现伸缩**：桌面 `aside` **`w-[280px]` ↔ `w-16`** + `transition-[width]`；`ChatSessionSidebar` 接收 **`collapsed`** 切换窄条图标与完整列表；移动为 **`fixed` 抽屉**。
2. **当前中间正文区宽度由哪些 class 控制**：中间列 **`flex-1 min-w-0`**；内容区 **`mx-auto` + `chatContentMaxClass` + `assistantColMaxClass`**（均依赖 **`sessionSidebarCollapsed`**）。
3. **右侧引用栏应放在布局哪一层**：**与左侧 `aside` 同级**，置于 `page.tsx` 中 **最外层横向 `flex` 容器**内，作为第三子项（左 | 中 | 右），保证中间列 `flex-1` 随右栏占位缩窄。
4. **是否应采用三栏 flex**：**推荐**（桌面）；与现有架构一致且满足“缩窄不遮挡”；移动端另策。
5. **推荐后续修改文件**（实现时，非本次执行）：
   - `Legal_AI/frontend/src/app/new-feature-chat/page.tsx`（三栏结构、状态、`composer`/`chatContent` 派生 class）
   - `Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx`（可选 `onCitationClick`；可选弱化或保留 Popover 作为 hover 补充）
   - 新建如 `Legal_AI/frontend/src/components/chat/CitationDetailSidebar.tsx`（或用户命名的 `CitationSidePanel`）
   - 若需共享展示：`CitationPopover` 内字段可抽到小组件供侧栏复用

---

## 5. 代码定位索引（便于跳转）

| 主题 | 文件 | 说明 |
|------|------|------|
| 顶层 flex + 左侧 aside | `page.tsx` ~1662–1678 | `sessionSidebarCollapsed` 控制宽度 |
| 中间列 + 消息区 + composer | `page.tsx` ~1680–1867 | `flex-1`、`chatContentMaxClass`、`composerMaxClass` |
| 派生 max-width | `page.tsx` ~1617–1622 | 随左侧收起切换 |
| `[n]` 与 Popover | `QwenKbAnswerCard.tsx` ~463–608 | `InlineCitationMark`、`CitationPopover` |

---

*本审计基于上述路径源文件当前版本；未改动应用代码。*
