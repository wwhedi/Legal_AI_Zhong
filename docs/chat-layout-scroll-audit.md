# new-feature-chat 布局与滚动审计报告

**审计日期：** 2026-05-07  
**范围：** 仅阅读代码与样式结论；未修改任何源码。  
**涉及文件：**

- `Legal_AI/frontend/src/app/layout.tsx`
- `Legal_AI/frontend/src/app/new-feature-chat/page.tsx`
- `Legal_AI/frontend/src/components/chat/ChatSessionSidebar.tsx`
- `Legal_AI/frontend/src/components/layout/AppSidebar.tsx`
- `Legal_AI/frontend/src/app/globals.css`（`--app-sidebar-width`）

---

## 1. 当前页面布局层级树

以下为运行时 DOM/React 结构的简化层级（含主要 Tailwind 类语义）。

```
html.h-full
└── body.h-screen.overflow-hidden
    └── QueryProvider
        └── div.flex.h-full.min-h-0                    ← 全局横向分区容器（占满视口高度）
            ├── AppSidebar                             ← 应用主导航（左侧窄栏）
            │   └── aside.w-[var(--app-sidebar-width)].shrink-0   （globals: 56px）
            │
            └── main.min-h-0.flex-1.overflow-y-auto    ← ⚠️ 全局纵向滚动容器（见第 2 节）
                └── NewFeatureChatPage 根节点
                    └── div.flex.min-h-full.flex-col.overflow-x-hidden
                        ├── div.flex.flex-1.md:flex-row   ← 会话栏 + 聊天列
                        │   ├── aside.hidden.md:flex.w-[280px].shrink-0   ← 会话栏外包层
                        │   │   └── ChatSessionSidebar（内部再分区，见第 2 节）
                        │   │
                        │   └── div.flex.flex-1.flex-col   ← 右侧：标题 + 消息区
                        │       ├── （md 以下）顶栏「对话 / 新对话」
                        │       ├── div.mx-auto.max-w-6xl   ← 页面标题 + meta
                        │       └── div.mx-auto.flex-1.max-w-6xl.pb-44  ← 消息区外包（底部留白给 fixed 输入条）
                        │           └── div.rounded-2xl.overflow-hidden.flex-1   ← 卡片壳
                        │               └── div.overflow-y-auto.flex-1 ...      ← 意图：消息列表滚动
                        │                   └── messages / loading UI
                        │
                        └── div.fixed.bottom-0.left-14.right-0.z-10 ...  ← 输入区（视口固定）
                            └── div.mx-auto.max-w-6xl ... textarea + 发送
```

**AppSidebar 与 ChatSessionSidebar 的关系**

- **AppSidebar** 在根 `layout.tsx` 中与 `main` 并列，占用固定宽度 `--app-sidebar-width`（56px），**不参与** `new-feature-chat/page.tsx` 内部布局。
- **ChatSessionSidebar** 仅在 `/new-feature-chat` 页面内、`<main>` 内部，与右侧聊天列组成 `md:flex-row` 行布局；**与小屏时隐藏会话栏**（`aside` 使用 `hidden md:flex`）。

---

## 2. 当前哪些元素在滚动

| 滚动区域 | 触发条件 / 实际表现 |
|----------|---------------------|
| **`main`（根布局）** | `layout.tsx` 中 `main` 使用 **`overflow-y-auto`**。当 `<main>` 内文档总高度超过视口时，**整块内容（含左侧会话栏 + 标题 + 消息卡片）一起在 `main` 内纵向滚动**。 |
| **消息列表容器**（`page.tsx` 内带 `overflow-y-auto` 的 div） | **设计上**希望只有此处滚动；但因外层多为 **`min-h-full` / `flex-1` / `h-auto`**，整页高度往往随内容增高，`flex` 子项未被限制在「视口剩余高度」内时，`overflow-y-auto` **不一定成为唯一滚动源**，常与 `main` 的滚动**叠加或退化为由 `main` 主导**。 |
| **ChatSessionSidebar 内列表区** | 组件内 `div.min-h-0.flex-1.overflow-y-auto`：**仅在会话栏外包层高度被上限约束时**才会独立滚动；当前外包 `aside` 为 **`h-auto`**，高度随行内最高列（通常为右侧聊天内容）拉伸，列表往往随 **`main` 整体滚动**，侧边栏内部滚动条不一定出现。 |

**是否存在 body 级滚动与内部滚动冲突？**

- **`body` 为 `overflow-hidden`**，通常 **没有 body 级纵向滚动**。
- **冲突主要体现在：`main` 级滚动** 与 **消息区 `overflow-y-auto`**：两层都可能滚动；在长内容下用户滚动时更容易感知到 **`main` 在动**，左侧会话列表随之移动。

---

## 3. 输入框当前定位方式

- 使用 **`position: fixed`**（Tailwind：`fixed`）。
- **`bottom-0`**：贴在视口底部（浏览器窗口底部）。
- **水平范围：** `left-14 right-0`，即左侧留出 **3.5rem（56px）**，与 `globals.css` 中 **`--app-sidebar-width: 56px`** 及 **AppSidebar** 宽度一致，避免输入条压在主导航上。
- **视觉：** `pt-10`、渐变背景、`backdrop-blur`、`shadow`，形成 **较厚的底部「停靠条」**，因此容易感知为 **固定在浏览器底部的一大块**。
- **主内容避让：** 消息区域外包层使用 **`pb-44`**，卡片内滚动区还有 **`pb-36` / `scroll-pb-32`**，为底部 fixed 区域预留空间。

**未使用：** `sticky` / `absolute`（输入条本身；页面其它区域未在本次逐项枚举）。

---

## 4. 会话栏是否能收起

- **`ChatSessionSidebar` 组件：** 无 **`collapsed` / 收起** 相关 props、状态或窄宽度模式；宽度由页面 **`aside.w-[280px]`** 固定。
- **页面级：** `new-feature-chat/page.tsx` **未实现**会话栏折叠；仅 **小屏（`< md`）隐藏整列 aside**，改由顶栏「新对话」操作。
- **结论：** 桌面宽度下 **不支持收起**； middle 区域 **不会因「会话栏收起」而变宽**（无该行为）。

---

## 5. 根因与现象对应（审计问题清单）

### 5.1 为什么滚动回答区域时左侧对话列表也会滚动？

- 左侧会话栏与右侧内容 **同属 `main` 的子树**。`main` 带 **`overflow-y-auto`**，长内容下 **`main` 整体滚动**，会话栏 **没有**从该滚动链中剥离（例如未使用「仅中间列滚动 + 侧栏 `sticky`/固定高度」等结构），因此 **视觉上左侧列表随页面一起移动**。
- 会话列表虽有 **`overflow-y-auto`**，但 **`aside` 为 `h-auto`**，高度跟内容列对齐，**未必形成独立的受限高度滚动视口**。

### 5.2 输入框为什么像固定在浏览器底部的大块？

- **`fixed bottom-0`** 相对视口钉死；加上 **`left-14`** 与 **`pt-10`、渐变与阴影**，占位与视觉重量都较大，呈现 **全局底部 Dock** 形态。

### 5.3 中间回答区为什么没有随会话栏收起而扩大？

- **无收起逻辑**； aside **固定 280px**（`md` 及以上）。中间区域宽度受 **`max-w-6xl` + `mx-auto`** 限制，与会话栏是否折叠 **无联动**。

### 5.4 `h-screen` / `min-h-screen` / `overflow-y-auto` 是否不当？

| 位置 | 类 / 行为 | 备注 |
|------|-----------|------|
| `body` | `h-screen` + `overflow-hidden` | 常见「应用壳」写法；抑制 body 滚动。 |
| `page` 根 | **`min-h-full`**（非 `h-screen`） | 保证至少铺满父级；与 **`main` 可滚动** 组合时，易导致 **整页增高后由 `main` 滚动**。 |
| `main` | **`overflow-y-auto`** | **核心：** 使 **`main` 成为纵向滚动容器**，与页面内消息区 `overflow-y-auto` **叠套**。 |
| 消息区 | `overflow-y-auto`、`flex-1`、`min-h-0` | **`min-h-0` 链路若在到达视口高度前断裂**，内部滚动无法单独承担长列表。 |

未见页面直接使用 **`min-h-screen`**；高度语义主要来自 **`body` `h-screen`** 与 **`min-h-full`**。

---

## 6. 推荐修改方案（仅建议，本次未改代码）

以下按优先级简述，实施时需任选一条主轴，避免保留「`main` + 内部」双滚动。

1. **单一滚动源（推荐）**  
   - 将 **`layout` 中 `main` 改为 `overflow-hidden`（或 `min-h-0 flex flex-col`）**，由 **`new-feature-chat` 根节点使用 `h-full min-h-0 flex flex-col`**，把 **唯一 `overflow-y-auto`** 放在 **消息列表**（或中间列）上，并保证链路上每层 **`min-h-0`** 贯通到视口高度。  
   - 左侧 **`aside`** 使用 **`shrink-0` + 固定或 `max` 高度等于中间列可视高度**（例如 `h-full`/`sticky top-0 self-start max-h-[100dvh]` 等按设计取舍），使 **`ChatSessionSidebar` 内 `overflow-y-auto`** 真正生效。

2. **保留 `main` 滚动时的折中**  
   - 若坚持 **`main` 滚动**：需接受侧栏与内容同滚，或通过 **`sticky`** 让会话栏头部/列表在视口内钉住（复杂度与移动端行为需单独设计）。

3. **输入区**  
   - 若不希望「浏览器底部大块」：可改为 **`sticky bottom-0`** 置于中间列底部（配合单列滚动），或保留 **`fixed`** 但减小 **`pt-10`/阴影**，并与 **`pb-*`** 对齐。

4. **会话栏收起与中间变宽**  
   - 增加页面级 **`collapsed` state**，收起时 **`aside` 宽度过渡为图标宽度或 0**，右侧 **`flex-1`** 占满；可与 **`max-w-6xl`** 是否随收起放宽一并产品设计。

5. **`AppSidebar` 与输入条**  
   - 若未来 **`--app-sidebar-width` 可变**，`left-14` 应改为 **`left-[var(--app-sidebar-width)]`**，避免错位。

---

## 7. 工具命令结果

在项目目录执行：

```text
cd Legal_AI/frontend
npm run lint
npm run build
```

| 命令 | 结果 |
|------|------|
| `npm run lint` | **通过**（eslint 无报错退出码 0） |
| `npm run build` | **通过**（Next.js 16.2.1 webpack，`/new-feature-chat` 等为静态或按需路由，构建成功） |

---

## 8. 报告路径

- **`Legal_AI/docs/chat-layout-scroll-audit.md`**（本文件）
