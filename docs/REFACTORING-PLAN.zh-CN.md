# 大文件拆分计划

[English](REFACTORING-PLAN.en.md)

本文是 `main.mts`、`agent-service.ts`、`App.tsx`、`styles.css` 四个大文件的**可执行拆分计划**：接缝已经测绘完毕（行号、耦合、状态），按「易 → 难」排序，每一步都独立可验证、可单独提交。

拆分的目的不是行数好看，而是让「改一个行为只碰一个文件」。每完成一步都要跑完文末的门禁。

## 现状（2026-09-11 实测）

| 文件 | 行数 | 已有可参照的拆分 |
|---|---|---|
| `apps/desktop/src/main.mts` | 2069 | `desktop-diagnostics` / `desktop-external-open` / `desktop-notification-sound` / `server-bridge` / `server-host` / `server-process` / `update-pending-install` |
| `apps/server/src/agent-service.ts` | 3226 | 已分出 `agent/` 下 20+ 模块（tools / memory / mcp / confirmations …） |
| `apps/web/src/App.tsx` | 3764 | `mailListState` / `sendingStatus` / `contextMenu` / `dialogRouting` / `scrollAnchor` / `perfTelemetry` |
| `apps/web/src/styles.css` | 16906 | 有 `designTokens.test.ts` / `themeContrast.test.ts` 作为债务棘轮 |

## 一、main.mts：按四块推进

### 第 1 步 · 托盘（最易，约 −110 行）

- 代码：`applyTrayBadge` 564-572、`setTrayIcon` 574-577、`trayBadgeIcon` 579、`loadTrayBadgeIcon` 581-595、`trayIconApi` 597-600、`focusMainWindow` 640-648、`loadDesktopIcon` 650-657、`destroyTray` 659-662、`refreshTrayMenu` 676-696、`runTrayAction` 698-720、`ensureTray` 722-734、`hideMainWindowToTray` 736-751。
- 自有状态：`tray`(188)、`appIcon`(189)、`mainWindowVisible`(194)、`trayBadgeIcon`(579) 可整体随行。
- 形态：工厂 `createTrayController({ getMainWindow, getAppIcon, copy, showError, quit })`，返回 `{ ensure, destroy, focusWindow, hideWindowToTray, applyBadge, getTray, isWindowVisible, setWindowVisible }`。
- 需改接线：smoke 桥 418-434（`getTray/getAppIcon/ensureTray/destroyTray/focusMainWindow`）、关闭流程 874 与 927（`destroyTray`）、1080 与 1302（`applyTrayBadge`）、802 与 826（`hideMainWindowToTray`）、窗口外壳 1216（`appIcon`）、1248（`mainWindowVisible`）。
- 注意：托盘块与非托盘代码交错（`applyLaunchAtStartup` / `applyGlobalShortcut` / `nativeCopy` 夹在中间），不是连续区间，按函数搬而不是按行删。

### 第 2 步 · Agent 配对（约 −110 行）

- 代码：1371-1473（`recordPairingFailure` / `processAgentPairingRequest`）、1472-1478 `scheduleAgentPairingRequests`、1480 `pairingScopeDriftNotified`、1487-1512 `warnExternalPairingScopeDrift`。
- 自有状态只有 `pairingRequestTail`(223) 与 `pairingScopeDriftNotified`(1480)。
- 形态：工厂 + 回调（`ensureMainWindowForAgentPairing`、`showNativeNotification`、`focusMainWindow`、`getBroker` / `getServer`）。
- 需改接线：boot 1711/1712、second-instance 2137。

### 第 3 步 · 窗口外壳（约 −240 行）

- 代码：1131-1153（`resolveSplashPresented` / `waitForSplashPresentation`）、1159-1184 `nativeSplashUrl`、1190-1304 `createMainWindowShell`、1310-1351 `loadMainWindowApp`、1355-1359 `createMainWindow`、1361-1369 `ensureMainWindowForAgentPairing`、1518-1534 `observeSplashDismissal`。
- 先做纯函数：`nativeSplashUrl`（无状态依赖）。其余因 `mainWindow` 被约 30 处读取，只能工厂化 + 注入 getter/setter，并回调 `handleMainWindowClose`、`applyTrayBadge`。

### 第 4 步 · 关闭流程（最难，最后做）

- 代码：753-959。横跨 `isQuitting`(195)、`shutdownPromise`(196)、`closePromptPending`(197)、`localServer`、`desktopAgentBrokerRecoveryGate`(225)、`serverProcess`(147)，且被 348、396-398、2164、2181-2183 反向调用。
- 建议只把**纯函数**抽走：`stopLocalServerProcess`(841-845)、`showClosePrompt`(759-771)、`quitFromClosePrompt`(773-780)；编排（`closeLocalServerForExit`、`prepareLocalServerForUpdateInstall`、`recoverAfterUpdateInstallFailure`）留主模块。

## 二、agent-service.ts：先断开类型纠缠

**不要动**：`streamMessage`(1871-2509，贯穿全部状态且被三组测试锁定)、`invokeExternalTool`(1292-1556，权限引擎 + 双契约 + 确认交织)、`providerMessages`(2999-3168，提示词装配耦合 RAG/记忆/工具/i18n)、确认链路(1729-1869)。

1. **先独立 `AgentServiceError`**(468-479) → `agent/agent-error.ts`，`agent-service.ts` 再导出（`routes/agent.ts`、`routes/translation.ts` 无需改动）。这是后面所有提取的前置——否则新模块 import 它会形成循环。
2. **provider 配置域**：常量 85-88，`isLoopbackHost` / `normalizeEndpoint` / `providerConfigRecordId` / `providerSummary` / `parseProviderConfiguration` / `providerConnectionFingerprint` / `validateTimeout`(502-606)，`AgentProviderStore`(762-919)。`AgentProviderStore` 外部零引用，闭环完整。
   - 前置：内部类型 `ProviderRow` / `ProviderConfiguration` / `DefaultProviderConfiguration` 在 318-466，需一并搬移并导出。
3. **一次性 LLM 任务**：`translateWithProvider`(2533-2609)、`generateConversationTitle`(2611-2650)、`evaluateAutoReply`(2656-2720) —— 同构（取 provider → 组 prompt → streamChat → 解析），**先补测试再动**。
4. **会话作用域与租约**：2732-2738、2773-2840、2884-2905。

## 三、App.tsx 与 styles.css

- `App.tsx`：尚未做接缝测绘。已抽出的模块证明这条路可行，下一步应先用同样方式测绘（哪些 effect / handler 只依赖少数 state），再定提取顺序。**不要**在没有测绘前动手。
- `styles.css`：16906 行。CSS 拆分的最大风险是**层叠顺序**，不是语法。建议按「完全独立的选择器族」逐块外移（如 `.agent-*`、`settings-*`），每移一块跑一次 e2e 几何与视觉基线；`designTokens.test.ts` / `themeContrast.test.ts` 作为棘轮继续守住不回退。

## 四、每一步的门禁

1. `npm run typecheck`（四 workspace）
2. 对应 workspace 全量单测：desktop `npm test`（193）/ server `npm test`（795，含 2 条既有 settings 预存失败）/ web `npm test`（699）
3. `npx playwright test e2e/*.spec.ts`（17 条）
4. 涉及 main.mts 的步骤额外跑 `npm run smoke:desktop`，涉及打包行为时对 `release-artifacts/<ver>/win-unpacked/Nami Mail.exe` 跑打包版冒烟（asar 内 `utilityProcess.fork` 必须可用）
5. 每步一个提交，提交信息写清「搬了什么、为什么这样切、怎么验证的」
