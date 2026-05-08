# new-feature-chat 生成与会话控制审计

**范围**：仅审计，未修改代码。  
**日期**：2026-05-08  
**涉及文件**：

- `Legal_AI/frontend/src/app/new-feature-chat/page.tsx`
- `Legal_AI/frontend/src/components/chat/ChatSessionSidebar.tsx`
- `Legal_AI/frontend/src/lib/chat-sessions.ts`（localStorage 持久化）

**构建检查**（在 `Legal_AI/frontend` 执行）：

- `npm run lint`：通过（exit code 0）
- `npm run build`：通过（Next.js 16.2.1，TypeScript 与静态生成均成功）

**报告路径**：`Legal_AI/docs/chat-generation-control-audit.md`

---

## 1. `page.tsx` 行为摘要

### 1.1 `send` 函数

- **入口条件**：`question` 非空、`loading` 为 false、`sessionReady` 为 true、且 `activeSessionIdRef.current` 存在；否则直接 return。
- **副作用顺序（概要）**：
  1. 构造用户消息并 `setMessages` 追加；在同一 updater 内用 `activeSessionIdRef.current` 调用 `updateChatSession`（必要时用 `generateSessionTitle` 更新标题）。
  2. `queueMicrotask(refreshSessionsList)` 刷新侧栏列表。
  3. `setLastQuestion`、`setLoading(true)`、`setStreamingEvents([])`。
  4. 本地数组 `streamed` 累积事件；`pushEvent` 内通过 `setStreamingEvents([...streamed])` 驱动 UI，并在 `type === "answer"` 时组装 `assistantMsg` 再次 `setMessages` + `updateChatSession`。
  5. `fetch` POST `${getApiBaseUrl()}/new-rag/ask-stream`，无 `signal`、无 `AbortController`。
  6. `finally` 中统一 `setLoading(false)` 与 `setStreamingEvents([])`。

相关代码：

```944:976:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
  const send = async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading || !sessionReady || !activeSessionIdRef.current) return;
    // ...
    setLastQuestion(question);
    setLoading(true);
    setStreamingEvents([]);
```

```1064:1141:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
    try {
      const resp = await fetch(`${getApiBaseUrl()}/new-rag/ask-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ question }),
      });
      // ... reader loop ...
    } catch (error) {
      // ... append fail assistant message ...
    } finally {
      setLoading(false);
      setStreamingEvents([]);
    }
  };
```

### 1.2 `fetch` 与 ReadableStream 读取循环

- **URL**：`/new-rag/ask-stream`（经 `getApiBaseUrl()` 拼接）。
- **循环**：`body.getReader()` + `TextDecoder`，按 `\n` 切行，`consumeNdjsonLine` 对每行 `JSON.parse` 为 `RagProcessEvent`。
- **错误行**：解析失败被吞掉；HTTP 非 ok 或不可读 body 会抛错进入 `catch`。
- **流结束且无 `answer` 事件**：追加一条「未收到完整回答」的 assistant 文本消息。

### 1.3 `loading` 状态

- **含义**：覆盖从发起 `fetch` 前到 `finally` 的整段流式生命周期（含连接、读流、收尾）。
- **用途**：禁用发送、`send` 重入、`handleNewSession` / `handleSelectSession` 提前 return；侧栏与部分移动端控件 `disabled={loading}`。

### 1.4 `streamingEvents`

- 每次 NDJSON 事件通过 `pushEvent` 追加到闭包数组 `streamed` 并 `setStreamingEvents([...streamed])`。
- **`answer` 落库时**会从 `streamed` 生成 `processSnapshot`，**过滤掉** `answer_delta`（减小存储）；`done` / `error` / `answer` 类型也被排除在快照外（见 `pushEvent` 内 filter）。

### 1.5 `streamingAnswerDraft`

- **`useMemo`**：遍历 `streamingEvents`，累加 `type === "answer_delta"` 或 `stage === "answer_delta"` 且 `data.delta` 的字符串。
- **仅用于 UI**：`StreamingAnswerDraft` 在 `answerGenerationLive` 为 true 时展示；**不会**在流式过程中写入 `messages` 或 `localStorage`。持久化仍以最终 `type === "answer"` 事件为准。

```926:941:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
  const streamingAnswerDraft = useMemo(() => {
    let acc = "";
    for (const e of streamingEvents) {
      if (e.type === "answer_delta" || e.stage === "answer_delta") {
        const d = e.data as Record<string, unknown> | undefined;
        if (d && d.delta != null) acc += String(d.delta);
      }
    }
    return acc;
  }, [streamingEvents]);
```

### 1.6 `handleNewSession` / `handleSelectSession`

- **`handleNewSession`**：`if (loading) return;`，然后 `createChatSession`、`saveChatSessions`、`persistActiveSessionId`、同步 `activeSessionIdRef`、清空 `messages` / `input` / `streamingEvents` / `lastMeta` / `lastQuestion`，刷新 `sessions`。
- **`handleSelectSession`**：同样在 **`if (loading) return;`** 后加载目标会话消息、清空 `streamingEvents` 与 `input`，重算 `lastQuestion` / `lastMeta`。

```879:910:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
  const handleNewSession = useCallback(() => {
    if (loading) return;
    // ...
  }, [loading]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (loading) return;
      // ...
    },
    [loading],
  );
```

### 1.7 `activeSessionIdRef`

- 与 `activeSessionId` state 通过 `useEffect` 保持同步。
- **`send` 内所有** `updateChatSession(sid, …)` 均使用 **当时的** `activeSessionIdRef.current`，而不是在 `send` 开始时捕获的 session id。

```844:847:Legal_AI/frontend/src/app/new-feature-chat/page.tsx
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
```

### 1.8 localStorage 会话保存逻辑

- **键名**：`CHAT_SESSIONS_KEY`（`legal-ai-chat-sessions-v1`）、`ACTIVE_SESSION_ID_KEY`（`legal-ai-active-session-id-v1`）。
- **写入时机**：用户消息追加、`answer` / `error` / 不完整流 / `catch` 等路径中调用 `updateChatSession`；新建会话时 `saveChatSessions`。
- **`updateChatSession`**：合并 patch、刷新 `updatedAt`、重新排序并截断最多 50 条会话后 `localStorage.setItem`。

---

## 2. `ChatSessionSidebar.tsx` 行为摘要

### 2.1 `loading` 时是否禁用「新对话」

- **是**：展开态主按钮 `disabled={loading}`；收起态图标按钮同样 `disabled={loading}`。

```65:73:Legal_AI/frontend/src/components/chat/ChatSessionSidebar.tsx
          <button
            type="button"
            disabled={loading}
            onClick={onNewSession}
```

```95:103:Legal_AI/frontend/src/components/chat/ChatSessionSidebar.tsx
        <button
          type="button"
          disabled={loading}
          onClick={onNewSession}
```

### 2.2 `loading` 时是否禁用历史会话点击

- **是**：每个会话条目 `disabled={loading}`，并在 loading 时附加 `cursor-not-allowed opacity-50` 样式。

```115:126:Legal_AI/frontend/src/components/chat/ChatSessionSidebar.tsx
                  <button
                    type="button"
                    disabled={loading}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelectSession(s.id)}
                    className={cn(
                      // ...
                      loading && "cursor-not-allowed opacity-50 hover:border-transparent hover:bg-white/80",
                    )}
```

### 2.3 是否已有「停止」按钮

- **否**：侧栏仅有「新对话」与会话列表（及折叠控制），无停止生成相关 UI。

---

## 3. 直接回答清单

### Q1：当前为什么生成中不能新建对话？

- **`handleNewSession` 首行** `if (loading) return;`，生成过程中 `loading === true`，逻辑直接拒绝。
- **侧栏与收起态**「新对话」按钮 **`disabled={loading}`**，无法触发回调。
- **移动端顶栏**「新对话」同样 **`disabled={loading || !sessionReady}`**。

结论：**业务上刻意在生成期间锁住新会话**，避免与进行中的流式写入交叉（见 Q4、Q7）。

### Q2：当前为什么生成中不能切换旧对话？

- **`handleSelectSession` 首行** `if (loading) return;`。
- **侧栏历史项** `disabled={loading}`。
- **移动端**：打开历史抽屉的按钮在 **`loading` 时 disabled**，用户甚至无法在生成中打开抽屉切换会话。

结论：**生成期间从 UI 到 handler 全链路禁止切换会话**。

### Q3：当前是否有 AbortController？

- 在 **`Legal_AI/frontend` 内 grep `AbortController`：无匹配**。
- `fetch` 未传入 `signal`，流读取未与任何取消机制绑定。

结论：**当前实现没有 AbortController（也没有等价的主动取消）**。

### Q4：如果用户切换会话，旧请求是否可能继续写入当前页面？

**正常 UI 下**：不能切换会话（Q2），因此不会通过点击触发该问题。

**若绕过限制**（例如将来去掉 `disabled` / `if (loading) return` 或从控制台调 handler）：

- **`send` 仍在运行时**，`activeSessionIdRef` 会随 `handleSelectSession` / `handleNewSession` 更新为**新会话 id**。
- 后续 `pushEvent` 与 `setMessages` 内的 `updateChatSession(sid, …)` 使用的是**更新后的** `activeSessionIdRef.current`，即可能把**仍在生成的** assistant 内容写到**新选中的会话**，造成串会话污染。
- **`setMessages` 的函数式更新**仍基于「当前 React 闭包中的 `prev`」与异步流交错时，还可能出现 UI 与 localStorage 不一致等更难排查的现象。

结论：**没有请求世代的“陈旧请求丢弃”防护**；当前主要靠 **禁止切换** 规避。一旦允许切换而不改架构，**旧请求继续写入错误会话的风险是真实存在的**。

### Q5：添加「停止生成」需要改哪些状态（概念层面）？

至少需覆盖：

1. **取消传输**：为 `fetch` 提供 `AbortController.signal`（或保存 `reader` 并在停止时 `cancel()`），使网络与读循环结束。
2. **`loading`**：在取消或自然结束路径上置为 `false`（可与现有 `finally` 协调，避免双重逻辑冲突）。
3. **`streamingEvents`**：停止后清空或保留最后快照（视产品是否展示「已中断」时间线）。
4. **（可选）进行中标志**：如 `isStreamingRef` 或与 **`send` 启动时绑定的 `sessionId` / `requestId`** 比对，防止取消后的迟滞 `setState` 污染 UI。
5. **UI**：发送区或顶栏增加「停止」按钮，并在 `loading` 时可用（与「新对话」禁用策略需一并产品设计）。

### Q6：停止后是否应保存已生成的草稿？

- **当前产品行为**：草稿级内容仅存在于 `streamingAnswerDraft`（由 `streamingEvents` 推导），**不落库**；只有完整 `answer` 事件才写入 `messages` + `updateChatSession`。
- **建议（产品 + 工程）**：
  - **若希望用户不丢已读内容**：停止时应将**已累积的可见文本**（或结构化卡片占位）写入 `messages` 并 `updateChatSession`，并明确标注「生成已中断」或「不完整回答」，避免与正常答案混淆。
  - **若希望磁盘只存可解析的完整 NDJSON 答案**：可不存 delta，仅存一条简短的 assistant 说明行；但 UX 通常弱于保存部分正文。

结论：**从体验与一致性出发，更稳妥的是保存已生成可见草稿（或摘要）并带中断标记**；需与后端是否仍能补全、以及卡片解析逻辑一并考虑。

### Q7：推荐最稳妥的实现方案（设计层面）

1. **`AbortController` + `fetch(..., { signal })`**：停止时 `abort()`，在 `catch` 中区分 `AbortError` 与用户错误，避免误报「调用失败」。
2. **在 `send` 开始时捕获 `const sessionIdAtStart = activeSessionIdRef.current`（或独立 ref）**：所有 `updateChatSession` 与「应追加到哪条会话」的判断**以该 id 为准**，或在每次写入前校验 `sessionIdAtStart === activeSessionIdRef.current` 且可选「用户未点停止」。这样**即使将来允许切换会话或并发**，也不会把 A 会话的流写入 B。
3. **请求世代号（monotonic `requestId`）**：每次 `send` 递增；流回调内若 `requestId !== currentRequestIdRef` 则忽略 UI 更新。与 Abort 配合可彻底防止陈旧 chunk。
4. **会话切换策略（二选一或组合）**：
   - **切换即中止上一请求**（Abort），再加载目标会话；或
   - **允许后台继续但仅更新原会话存储**（需后端与会话模型支持，前端仍应用 sessionId 绑定）。
5. **「停止」与「新对话 / 切换」**：若采用 Abort + session 绑定，可在停止未完成前仍限制切换，或允许切换但**自动 abort** 并保证写入目标会话正确。

---

## 4. 结论表

| 项目 | 现状 |
|------|------|
| 生成中新对话 | Handler + 多处 UI 因 `loading` 禁止 |
| 生成中切会话 | Handler + 侧栏 + 移动端历史入口均禁止 |
| AbortController | 无 |
| 切换会话与旧请求 | UI 禁止切换；无世代隔离，绕过则有串会话风险 |
| 停止按钮 | 无 |
| 草稿持久化 | 仅最终 `answer`；delta 不写入 localStorage |

---

## 5. 代码索引（便于跳转）

| 主题 | 位置 |
|------|------|
| `send` / fetch / reader | `page.tsx` 约 944–1141 行 |
| `handleNewSession` | `page.tsx` 约 879–893 行 |
| `handleSelectSession` | `page.tsx` 约 895–909 行 |
| `activeSessionIdRef` | `page.tsx` 约 844–847 行 |
| 侧栏 loading 禁用 | `ChatSessionSidebar.tsx` 约 65–73、95–103、115–126 行 |
| localStorage 读写 | `lib/chat-sessions.ts` 全文 |
