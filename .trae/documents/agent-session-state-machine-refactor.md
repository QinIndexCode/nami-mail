# 计划：候选3 — 抽出 AgentWorkspace 流式会话状态机（useAgentSession）

## 1. Summary（摘要）

`apps/web/src/AgentWorkspace.tsx`（约 2772 行、148 个 `useState/useRef/useEffect/useCallback/useMemo`）把「流式会话状态机」与「UI 派生状态」全部内联。本计划将其**自洽可抽离的状态机核心**抽为一个独立深模块 `useAgentSession`，让组件瘦身、状态机逻辑可独立复用与单测，摆脱对 1127 行重型 harness 的依赖。

**范围界定（本次）**：只抽「会话运行生命周期 + 流事件管道 + 后台缓冲/重放 + 轮询 fold-in + 流标志 + cancel/stop」，即与 composer/slash/mention/chips/selection 等 UI 域**不耦合**的部分。composer 域、会话列表增删、附件、引用 chips、上下文菜单等 **本次不动**。

**不做（后续批次）**：会话列表 `refreshConversations` 合并逻辑、selection mode、记忆建议 UI 编排、sideabr menu。避免一次改动过大导致回归爆炸。

## 2. Current State Analysis（当前状态）

关键证据（均来自 `apps/web/src/AgentWorkspace.tsx`）：

| 片段 | 行号 | 状态 |
|------|------|------|
| `SessionStream` 类型 | L143-155 | 内联，抽离核心数据结构 |
| 流标志 state | L206-216 `streaming/streamStatus/ghostConversationId` | 内联 |
| `sessionStreamsRef`、`syncBackgroundRuns`、`backgroundRunIds`、`abortRef`、`backgroundErrorRef` | L309-369 | 内联，后台运行生命周期 |
| 卸载清理（abort all streams） | L373-388 | 与会话生命周期绑定 |
| 轮询 fold-in effect | L1000-1090 | 内联，**依赖 `active?.messages` 折叠**，需回调暴露 |
| `replayBackgroundSession` | L1100-1187 | 后台缓冲重放 |
| 流事件管道 `pendingStreamPiecesRef`/`streamRafRef`/`flushPendingStreamPieces`/`enqueueStreamPiece`/pacing | L1424-1590 | **自洽核心**，内部 `setActive` 折叠消息行 |
| `stopStreaming` / `stopGhostRun` | L1894-1922 | 取消能力 |
| `sendMessage` | L1620-1892 | 打断旧run + 创建会话 + 乐观插消息 + 启动流，**UI 与状态机混杂** |

### 耦合点分析
- **`flushPendingStreamPieces` / `enqueueStreamPiece`** 依赖 `setActive`（折叠消息行）与 `streaming/streamStatus/sessionStreamsRef` —— 这些可整体纳入 hook。
- **轮询 fold-in effect（L1000-1090）** 依赖 `active?.messages` 判定折叠目标，且会调用 `setActive`、`setGhostConversationId`、`syncBackgroundRuns` —— 与 hook 内 `active` 强绑定，可一并抽入。
- **`sendMessage`** 需大幅瘦身：保留「打断现 run 的 UI、创建/复用对话、乐观插入 user/assistant 消息、清理 composer/chips」；把「创建 controller、注册 session、消费事件、CONFLICT 重试、finally 清流标志」下沉为 hook 的 `runStream`。

### 测试现状
`AgentWorkspace.integration.test.tsx`（约 1127 行）通过 `vi.mock("./api")` 从 **api 层**注入流事件（`streamAgentMessage` mock 的 onEvent 回调），再 `render` 真实组件 + DOM 交互（`setComposer`/`clickSend`/`flush`）驱动。**抽取 hook 不改变 api 边界** → 该 harness 仍适用，无需重写；本次计划补的是面向 hook 的纯单测。

## 3. Proposed Changes（具体改动）

### 新文件 `apps/web/src/agent/useAgentSession.ts`（深模块）

承载以下（从组件整段搬迁，语义不变）：

1. **类型**：`SessionStream`（从 L143-155 移入）+ 内部 ref 类型。
2. **状态**：`streaming`、`streamStatus`、`ghostConversationId`；以及 `active`（会话数据，hook 内 `useState` 持有，供全组件渲染读取）。
3. **引用**：`sessionStreamsRef`、`abortRef`、`backgroundErrorRef`、`streamPacingRef`、`pendingStreamPiecesRef`、`streamRafRef`。
4. **能力函数**：
   - `syncBackgroundRuns` → 暴露 `backgroundRunIds`
   - `flushPendingStreamPieces`、`enqueueStreamPiece`（**pacing 常量** L1435-1438 一并迁入）
   - `replayBackgroundSession`
   - `stopStreaming`、`stopGhostRun`、轮询 fold-in effect
   - `runStream(...)`：接收 `{ conversation, assistantMessage, streamPayload, selectedProvider, onStatus, onTitle, onSuggestion, onDone }` 与一组**组件回调**（composer 清理、会话列表刷新），内部复刻 L1749-1891 的 controller 创建、CONFLICT 重试、事件消费、finally 清理（`isCurrentRun` 判定保留）。
5. **暴露接口（返回值）**：
   ```ts
   return {
     active, setActive,
     streaming, streamStatus, ghostConversationId,
     backgroundRunIds,
     // 交给组件在发流前调用：
     prepareInterruptToSend(),        // sendMessage 头部：打断现run/ghost 的控制器侧逻辑
     runStream, stopStreaming, stopGhostRun,
     replayBackgroundSession, syncBackgroundRuns,
   };
   ```
   - `setActive` 需以稳定引用暴露（`useCallback`），避免触发组件不必要的重渲染。

> **设计约束**：`active` 由 hook 持有并暴露。组件通过 hook 返回的 `setActive` 完成 selectConversation、创建会话、折叠消息等既有写操作——这些写操作本就是状态机行为，纳入 hook 是抽离的语义边界而非新增行为。

### 改造 `apps/web/src/AgentWorkspace.tsx`

- 顶部 `import { useAgentSession } from "./agent/useAgentSession";`
- **删除**组件内已迁出的：`SessionStream` 定义、`streaming/streamStatus/ghostConversationId/active` 的 `useState`、`sessionStreamsRef/abortRef/backgroundErrorRef/pacing/pendingStreamPieces/streamRaf` 等 ref、`flushPendingStreamPieces`、`enqueueStreamPiece`、`replayBackgroundSession`、`stopStreaming`、`stopGhostRun`、轮询 fold-in effect、卸载 abort-all effect。
- **改 `sendMessage`**：
  - 头部调用 `prepareInterruptToSend()` 取代原打断/ghost 取消块。
  - 保留：provider 门禁、创建/复用 conversation、乐观插入 user/assistant 消息、`setComposer("")`、`setAttachedFiles([])`、`setQuoteContext(null)`、`setConfirmationErrors({})`、revoke 清理。
  - 尾部改为 `await runStream({...})`，把会话列表刷新、清 UI 通过回调传入。
- **所有读取点**：任何 `active`、`streaming`、`streamStatus`、`ghostConversationId`、`backgroundRunIds` 的引用改为从 hook 返回值取（`useMemo` 派生不变）。
- 组件内保留的 UI 域（composer/slash/mention/chips/pickers/selection/memory UI）**不加任何改动**。

### 测试

- **新增 `apps/web/src/agent/useAgentSession.test.tsx`**：用 `renderHook`/`act` 独立驱动 hook，覆盖：流事件折叠消息行、CONFLICT 重试、terminal 事件清 `streaming`、`stopStreaming`、后台会话缓冲与 `replayBackgroundSession`、轮询 fold-in 折叠。**mock api 层**，复用 harness 的 `vi.mock("./api")` 模式。
- **保留 `AgentWorkspace.integration.test.tsx`**：现 1127 行 harness 继续通过，作为抽取后的回归保障（api 边界未变，应全绿）。
- 如需，新增 1 条集成断言验证"正常渲染 + 发送"在抽取后仍通过 harness 的既有场景（合并进现有用例即可，不新建重型文件）。

## 4. Assumptions & Decisions（假设与决策）

- **`active` 归组件持有，采用「注入式 setActive」边界（已批准，取代初稿的「hook 持有 active」）**：冲洗/轮询/重放都写 `active` 的消息行，而该消息列表是组件的渲染状态。让 hook **注入式**接收 `active`/`setActive`/`activeIdRef`，把「回合生命周期 + 流管线 + 后台缓冲」收进深模块，渲染态仍归组件 → 改动面最小、回归风险最低。这是用户拍板的边界，本节旧文案「active 归 hook 持有」已作废。
- 相应接口：`useAgentSession` 接收 `UseAgentSessionParams`（`demoMode/active/setActive/activeIdRef/setConversations/refreshConversations/conversationSearch/setPendingMemorySuggestions/getT`），返回 `UseAgentSessionResult`（流标志 + `runStream/stopStreaming/stopGhostRun/prepareInterruptToSend` + 会话导航原语 `hasLiveRun/getSession/clearPendingFlush/takeBackgroundError/clearLiveRunIndicators/restoreLiveRunIndicators/terminateSession`）。`setConversations/setPendingMemorySuggestions` 也走注入，避免 hook 反向依赖组件分派函数。
- **`sendMessage` 采取"瘦身"而非"整体搬迁"**：composer/chips/附件/引用是 UI 域，留在组件；只把「run 生命周期」下沉为 `runStream`，通过回调返回"需要组件做的 UI 残留清理"。避免 hook 反向持有 composer、chips 等 UI 状态。
- **不做一次性大迁移**：composer 域、会话列表合并逻辑、selection mode 留作后续批次，降低单次回归面。本计划只交付可独立验证的状态机核心。
- **不引入新依赖**：沿用现有 React hooks 与 `AbortController`，符合候选2 `realtimeSync.ts` 的既有模块化风格。
- **行为零变化**：本计划是纯结构性抽取，不改变任何业务行为；验证标准是既有 integration harness 全绿 + typecheck 通过。

## 5. Verification（验证步骤）

1. `cd apps/web && npx tsc --noEmit`（或仓库约定的 typecheck 命令）→ 全绿。
2. `cd apps/web && npx vitest run`（或仓库约定脚本）→ 全部测试通过，包含：
   - 既有 `AgentWorkspace.integration.test.tsx` / `AgentWorkspace.test.tsx` / `AgentWorkspace.poll.test.tsx` 全绿（回归保障）；
   - 新增 `useAgentSession.test.tsx` 全绿。
3. 跑 repo 级校验（参考 ARCHITECTURE-ROADMAP 的既定流程：web/server/desktop/contracts 全量回归 + typecheck）。
4. 可选实机验证：`npm run package:win` 打安装包，人工回归 Agent 发消息/打断/切会话后返回重放的流式行为。
5. 完成后按路线图要求同步 `ARCHITECTURE-ROADMAP.md`（候选3 进度 + 交付记录）与项目记忆（feature-batch-progress），交付 push `origin backup/backgrounds-baseline`，绝不 push main。

## 6. 当前进度与剩余执行步骤（2026-08-31 续接基准）

### 已完成（2026-08-31 实测核验）
- `useAgentSession.ts` 已创建并迁移：流标志、`sessionStreamsRef/backgroundErrorRef/abandonedPickupRef/abortRef/pacing/pendingStreamPieces/streamRaf`、`flushPendingStreamPieces`/`enqueueStreamPiece`（含 pacing 常量）、后台轮询 fold-in effect、`replayBackgroundSession`、`stopStreaming`/`stopGhostRun`/`prepareInterruptToSend`、`runStream`（含 `isCurrentRun`/CONFLICT 重试/finally）、卸载 abort-all effect。
- 接口签名已定：注入式 `UseAgentSessionParams`（组件持有 active）→ `UseAgentSessionResult`。
- `useAgentSession` **`return useMemo` 已完整暴露全部 7 个会话导航原语**（`hasLiveRun/getSession/clearPendingFlush/takeBackgroundError/clearLiveRunIndicators/restoreLiveRunIndicators/terminateSession`）+ 6 个流原语 + 4 个 run 原语，见 L855-891。hook 自身 typecheck 自愈。
- **组件已接入 hook**：AgentWorkspace.tsx L410-437 `useAgentSession(params)`；`selectConversation`（L1027-1028 用 `getSession`/`replayBackgroundSession`）、`performDeleteConversations`（L1165 用 `terminateSession`）、`consumeAgentSuggestion`（L443 用 `getSession`）、后台错误/同步（L1029-1101）均改用原语。

### ⚠️ 已知缺口（实测 `npx tsc` 35 处红，必须补齐发送路径迁移）
`sendMessage`（composer→stream 的核心路径）**尚未迁移**，仍引用已归 hook 的旧标识符，与本地的旧 inline 收发管线并存：
- `TS2451` 重复声明：组件内本地 `stopStreaming`（L1657）、`stopGhostRun`（L1672）与 hook 解构同名冲突。
- `TS2304` 找不到名字：`abortRef`（L961/1513/1641）、`sessionStreamsRef`（L1282/1395/1519/1538/1557/1651/1652/1660）、`abandonedPickupRef`（L1682）。
- `TS2552` 找不到名字：`setStreaming`（L1410/1468/1643）、`setStreamStatus`（L1292/1308/1411/1469/1600/1644）、`setGhostConversationId`（L1419/1684）、`backgroundErrorRef`（L1351/1499）。

根因：组件仍保留旧 inline 收发管线（`SessionStream` 类型 L143-155、`pendingStreamPiecesRef/streamRafRef/streamPacingRef` L1196-1207、`flushPendingStreamPieces` L1207、`enqueueStreamPiece` L1281-1353），且 `sendMessage` 主体（L1460-1655）没改为调用 hook 的 `runStream`。

### 剩余步骤（按序，聚焦发送路径）
1. **`sendMessage` 接入 `runStream`**（最大消费点，唯一未迁移者）：
   - 头部保留 provider 门禁、创建/复用 conversation、乐观插入 user/assistant 消息、`setComposer("")/setAttachedFiles([])/setQuoteContext(null)/setConfirmationErrors({})`、revoke 清理；
   - 删除 L1390-1420 旧的「打断现 run + ghost 取消」内联块，改用已迁出的打断逻辑（与 `prepareInterruptToSend` 语义一致的组件侧 UI 归因）；
   - 用 `await runStream({ conversation, assistantMessage, streamPayload })` 取代 L1499-1655 内联的 controller 创建/注册 session/事件消费/CONFLICT 重试/finally 清标志；
   - finally 里 `setStreaming(false)/setStreamStatus(null)/sessionStreamsRef.delete/backgroundErrorRef` 等由 hook 内部完成，组件不再触碰。
2. **删除组件本地旧收发管线**：移除 `SessionStream` 类型（L143-155）、`flushPendingStreamPieces`（L1207-1280）、`enqueueStreamPiece`（L1281-1353）、`pendingStreamPiecesRef/streamRafRef/streamPacingRef`（L1196-1207）及其流相关常量；删除本地 `stopStreaming`（L1657）/`stopGhostRun`（L1665-1685），改用 hook 返回值（解构已就位，冲突即消）。
3. **修正残存引用**：将 `sendMessage`/卸载等剩余对 `setStreaming/setStreamStatus/setGhostConversationId/sessionStreamsRef/backgroundErrorRef/abortRef/abandonedPickupRef` 的引用，全部换成 hook 暴露的原语或删除（归属已迁入 hook）。
4. **web typecheck + vitest 全量**（`AgentWorkspace.integration.test.tsx` + `AgentWorkspace.poll.test.tsx` 回归须全绿）——验证「行为零变化」。
5. **新增 `useAgentSession.test.tsx`**（renderHook + mock api 覆盖折叠/CONFLICT/terminal/stop/重放/轮询）。
6. **同步 `ARCHITECTURE-ROADMAP.md` 候选3 进度**。