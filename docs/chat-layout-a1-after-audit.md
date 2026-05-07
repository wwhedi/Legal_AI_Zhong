# A-1 实施后 new-feature-chat 布局审计报告

**审计日期：** 2026-05-07  
**范围：** 仅阅读当前代码，未做任何修改。  
**依据：** 用户反馈「收起会话栏后回答区未真正变宽」「输入框仍像底部栏」。

---

## 执行摘要

| 问题 | 结论 |
|------|------|
| 收起后 **Chat main（flex 列）是否变宽？** | **是。** `aside` 从 `w-[280px]` 变为 `w-16`，右侧列 `flex-1` 会多占约 **216px** 水平空间。 |
| 为何 **视觉上内容几乎不变宽？** | 主内容被 **`max-w-6xl` + `mx-auto`** 夹在中间；助手消息列另有 **`max-w-[min(100%,48rem)]`**（≈768px）。多出的宽度主要变成 **列两侧的空白**，整体像「整块略右移/居中」，而非正文拉宽。 |
| **QwenKbAnswerCard** 是否限制宽度？ | 组件根节点 **无 `max-w`**，随父级宽度 **`w-full`**；真正卡死阅读宽度的是 **`page.tsx` 中外层气泡/列上的 `48rem`**。 |
| 输入框是 **底部栏** 还是 **浮动 composer**？ | 当前是 **全宽底部栏**：外层 `border-t` + 整行背景；内层才 `max-w-5xl mx-auto`。 |

---

## 1. `new-feature-chat/page.tsx`

### 1.1 Chat main 的 `flex-1` 是否生效？

右侧主列为：

```1106:1106:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
```

在横向 `flex` 父容器中（```1089:1104:Legal_AI/frontend/src/app/new-feature-chat/page.tsx```），该列 **`flex-1 min-w-0`** 会吃掉 `aside` 之外的剩余宽度。`aside` 宽度随收起状态在 **`w-[280px]`** 与 **`w-16`** 间切换（```1090:1093:Legal_AI/frontend/src/app/new-feature-chat/page.tsx```），因此 **主列物理宽度会随收起变宽**。

### 1.2 消息与标题上的 `max-w` / `mx-auto`

| 区域 | 关键 class | 作用 |
|------|------------|------|
| 页头 | `mx-auto … w-full max-w-6xl` | 内容最大约 **72rem（1152px）**，且在主列内 **水平居中**。 |
| 消息区外包 | `mx-auto w-full max-w-6xl` | 同上，**与页头同一上限**。 |
| 输入区内层 | `mx-auto … max-w-5xl` | 输入组合最大约 **64rem（1024px）**，仍居中。 |

收起侧栏后，主列变宽，但 **`max-w-6xl` 不变**，多出来的宽度变成 **左右对称的 margin**（`mx-auto`），用户容易感觉 **「只有位置动了，正文没宽」**。

### 1.3 回答气泡 / 卡片外层是否固定宽度？

助手带卡片时，包裹 `QwenKbAnswerCard` 的列使用：

```1167:1168:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
                            : assistantWithCard
                              ? "min-w-0 w-full max-w-[min(100%,48rem)] flex-1 space-y-3 text-[var(--app-text)]"
```

即助手列 **最大宽度被限制为 48rem（768px）**，即使外层 `max-w-6xl` 区域更宽，**回答主体会停在 768px**。这是比 `max-w-6xl` **更紧**的一道箍。

无卡片时的助手气泡同样使用 **`max-w-[min(100%,48rem)]`**（```1169:1169:Legal_AI/frontend/src/app/new-feature-chat/page.tsx```）。

### 1.4 输入框：外层 full-width bar + 内层 max-width

结构为：

```1221:1222:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
          <div className="shrink-0 border-t border-[var(--app-border)] bg-white/90 px-4 py-3 shadow-[var(--app-shadow-sm)] backdrop-blur-sm dark:bg-[var(--app-surface)]/90">
            <div className="mx-auto flex max-w-5xl min-w-0 items-end gap-3">
```

- **外层**：横向占满 **整个 Chat main**，带 **顶边线 + 背景 + 阴影**，语义上是 **通栏底部工具条（bottom bar）**。  
- **内层**：`max-w-5xl mx-auto`，textarea 与按钮只在这一宽度内；**外层条仍铺满**，故不像 ChatGPT 那种 **窄于列、带大圆角、像一块浮在内容上的 composer**。

---

## 2. `ChatSessionSidebar.tsx`

### 2.1 `collapsed` 时宽度

宽度由 **`page.tsx` 中外层 `aside`** 控制，而非组件内写死：

- 展开：`w-[280px]`
- 收起：`w-16`（**64px**）

组件在收起时根节点为 `w-full`，填满该 **64px** 轨道（```55:55:Legal_AI/frontend/src/components/chat/ChatSessionSidebar.tsx```）。

### 2.2 是否真正释放布局宽度？

**是。** `aside` 使用 `shrink-0` 与显式 `w-*`，收起时占位从 280px 减到 64px，**flex 剩余空间归主列**。未发现 aside「占位过宽」的额外 class；占位宽度与上述 `w-*` 一致。

---

## 3. `QwenKbAnswerCard.tsx`

根容器为：

```492:493:Legal_AI/frontend/src/components/chat/QwenKbAnswerCard.tsx
    <div className="rounded-[20px] border border-[var(--app-border)] bg-white p-4 shadow-[var(--app-shadow-sm)]">
      <div className="rounded-[16px] border border-[var(--app-primary)]/22 bg-gradient-to-b from-[var(--app-primary-softer)] via-[var(--app-primary-soft)] to-[var(--app-primary-softer)]/80 p-5 shadow-[var(--app-shadow-sm)]">
```

**无 `max-w-*`。** 卡片宽度 = 父级（即 `page.tsx` 中助手列）的可用宽度。  
文件内其它 `max-w`（如引用条 `max-w-[40%]`、popover `w-[min(22rem,…)]`）仅影响局部 UI，**不决定主回答列总宽**。

**结论：** **未阻止**主内容区变宽；阻止阅读宽度的是 **`page.tsx` 的 `48rem` 与 `max-w-6xl` 层级**。

---

## 4. 直接回答清单（对应需求）

### 4.1 收起会话栏后主聊天 flex 区域是否实际变宽？

**是**（约多 **216px**，取决于从 280px 到 64px 的差值）。

### 4.2 若变宽了，为什么内容没变宽？

1. **`max-w-6xl` + `mx-auto`**（标题区与消息外包层）把可读内容限制在约 **1152px** 并 **居中**；侧栏释放的空间主要落在 **两侧空白**。  
2. 助手消息列 **`max-w-[min(100%,48rem)]`** 进一步把回答主体限制在 **768px**，在宽屏上几乎 **不随侧栏收起而变宽**。

### 4.3 哪些 class 限制了回答卡片？

**主要（按影响力度）：**

1. **`max-w-[min(100%,48rem)]`** — 助手气泡/卡片列（`page.tsx`）。  
2. **`max-w-6xl`** + **`mx-auto`** — 标题与消息滚动区外包（`page.tsx`）。  

**次要：**

- **`max-w-5xl`** — 仅输入区内层，不直接限制回答卡片。

**`QwenKbAnswerCard` 根节点：** 无 `max-w`。

### 4.4 输入框当前是底部栏还是浮动 composer？

**底部栏（full-width strip）**：外层通栏 `border-t` + 背景；内层才是受限宽度的表单行。

### 4.5 若要接近 ChatGPT 输入框，需动哪些容器？（建议方向，非实施）

以下为 **设计层面** 的调整点，供后续改 UI 时参考：

1. **去掉或弱化通栏**：避免整块 `border-t` + 全宽背景；改为 **单块圆角容器**（或仅阴影）浮在内容区底部。  
2. **composer 宽度策略**：与 **消息 `max-w` 对齐**（例如与 `max-w-6xl` 或统一阅读宽度），或略小于列宽并 **`mx-auto`**，使 **视觉上是「一块」而非「一条」**。  
3. **与消息区的关系**：可用 **`sticky bottom-0`** 或 **消息区 `padding-bottom`** + 非通栏背景，让输入块 **叠在聊天背景上** 而非「整条底栏」。  
4. **若希望收起侧栏后正文明显变宽**：需 **放宽或删除 `max-w-[min(100%,48rem)]`**，并视产品决定是否 **仍保留 `max-w-6xl`** 或改为 **`w-full` + 更大 max**。

---

## 5. 工具命令结果

在 `Legal_AI/frontend` 执行：`npm run lint`、`npm run build`。

| 命令 | 结果 |
|------|------|
| `npm run lint` | **通过** |
| `npm run build` | **通过**（Next.js 16.2.1 webpack，`exit_code: 0`） |

---

## 6. 报告路径

- **`Legal_AI/docs/chat-layout-a1-after-audit.md`**（本文件）

---

## 7. 一句话归纳（给排期用）

**限制回答区「看起来变宽」的主要 class：** **`max-w-6xl` + `mx-auto`（居中留白）** 与 **`max-w-[min(100%,48rem)]`（助手列硬顶 768px）**。  

**输入框结构问题：** **外层全宽 bottom bar**，内层 `max-w-5xl` 仅约束控件行，**整体仍像应用底栏而非 ChatGPT 式浮动 composer**。
