# 大文件拆分计划

[English](REFACTORING-PLAN.en.md)

> ## ⚠️ 失效声明（2026-10-07 复核）
>
> **本文不再是可执行计划，也不得作为拆分依据。** 它记录的是 **2026-09-11 接缝测绘当时**的快照，此后四个目标文件中有三个已被大幅重构，原文所有行号指针与规模数字均已越界或过时。
>
> 保留本文的价值在于**拆分方法论与耦合判断**（哪些块能独立搬、哪些必须同批），这部分不随行数变化而失效。
>
> 已完成：
> - **第 1 步 托盘 —— 已完成**，已抽出至 `apps/desktop/src/tray.mts` 的 `createTrayController`。
> - `agent-service.ts` 的 `AgentServiceError` → `agent/agent-shared.ts`；`AgentProviderStore` 及 provider 配置域 → `agent/provider-service.ts`；`streamMessage` 主体 → `agent/run-engine.ts`。
> - `styles.css` 已由单文件 16906 行拆为 `styles/` 下 30 个 CSS 模块，根文件仅剩 `@import` 索引（30 行）。
>
> 尚未执行：下文第 2/3/4 步（Agent 配对 / 窗口外壳 / 关闭流程）与 §二 剩余提取项。
>
> **行号指针约定**：下文已把会漂移的行号统一替换为「函数名 + 文件路径」。重新测绘行号时请用 `(Get-Content <path>).Count` 与符号检索，不要沿用历史行号。

本文是 `main.mts`、`agent-service.ts`、`App.tsx`、`styles.css` 四个大文件的拆分计划：接缝已经测绘完毕（耦合、状态），按「易 → 难」排序，每一步都独立可验证、可单独提交。

拆分的目的不是行数好看，而是让「改一个行为只碰一个文件」。每完成一步都要跑完文末的门禁。

## 现状（2026-10-07 实测）

行数用 `(Get-Content <path>).Count` 实测。

| 文件 | 行数 | max-lines 棘轮 | 已有可参照的拆分 |
|---|---|---|---|
| `apps/desktop/src/main.mts` | 2110 | 2112 | `desktop-diagnostics` / `desktop-external-open` / `desktop-notification-sound` / `server-bridge` / `server-host` / `server-process` / `update-pending-install` |
| `apps/server/src/agent-service.ts` | 1304 | 1315 | 已分出 `agent/` 下 50 个模块（run-engine / provider-service / confirmations / tools / memory / mcp …） |
| `apps/web/src/App.tsx` | 3031 | 4380 | `mailListState` / `sendingStatus` / `contextMenu` / `dialogRouting` / `scrollAnchor` / `perfTelemetry` |
| `apps/web/src/AgentWorkspace.tsx` | 2502 | 2516 | `agent/useAgentSession` |
| `apps/web/src/styles.css` | 30（纯 `@import` 索引） | 见 `styles-size.test.ts` | 实际样式在 `styles/` 下 30 个模块（base 6 / components 4 / features 16 / overlays 3 / tokens 1），聚合 17670 行，由 `styles-size.test.ts` 的 `FROZEN_AGGREGATED_MAX_LINES = 17682` 棘轮锁定 |

> 棘轮数字的**唯一权威来源是 `eslint.config.mjs` 的 `max-lines` 数据表**（以及 `styles-size.test.ts` 对聚合 CSS 的棘轮）。本表只作快照参考，不要以本文为准去改阈值。

## 一、main.mts：按四块推进

### 第 1 步 · 托盘 —— ✅ 已完成

**托盘已抽出至 `apps/desktop/src/tray.mts` 的 `createTrayController`**（配套策略函数 `applyTrayBadge` 位于 `apps/desktop/src/desktop-behaviors.mts`）。`main.mts` 现有 `const trayController = createTrayController({ … })` 一行接线，smoke 桥通过 `trayController.ensure()` / `.focusWindow()` / `.destroy()` 暴露给宿主。

本步的原始测绘（形态、状态归属、接线点）已随实现落地，无需再执行。下文第 2/3/4 步的行号指针同样已按「函数名 + 文件路径」重写。

### 第 2 步 · Agent 配对（约 −110 行）—— 已搁置，列入 futurePlan

> **搁置说明（2026-09-12）**：这一块暂不实施，测绘结果保留在下面，便于以后直接开工。当前执行顺序为：托盘（已完成）→ 窗口外壳 → 关闭流程。

- 代码（均在 `apps/desktop/src/main.mts`，按函数名定位）：`recordPairingFailure` / `processAgentPairingRequest` / `scheduleAgentPairingRequests` / `warnExternalPairingScopeDrift`（配对请求处理链，`second-instance` 与 open-url 路径调用）。
- 自有状态只有 `pairingRequestTail` 与 `pairingScopeDriftNotified`（`main.mts` 模块级 `let`）。
- 形态：工厂 + 回调（`ensureMainWindowForAgentPairing`、`showNativeNotification`、`focusMainWindow`、`getBroker` / `getServer`）。
- 需改接线：boot 阶段的 `scheduleAgentPairingRequests(initialPairingRequestIds)` 与 `warnExternalPairingScopeDrift()` 调用，以及 second-instance / open-url 路径的 `ensureMainWindowForAgentPairing().then(() => scheduleAgentPairingRequests(...))`。

### 第 3 步 · 窗口外壳（约 −240 行）

- 代码（均在 `apps/desktop/src/main.mts`，按函数名定位）：`resolveSplashPresented` / `waitForSplashPresentation` / `nativeSplashUrl` / `createMainWindowShell` / `loadMainWindowApp` / `createMainWindow` / `ensureMainWindowForAgentPairing` / `observeSplashDismissal`。
- 先做纯函数：`nativeSplashUrl`（无状态依赖）。其余因 `mainWindow` 被约 30 处读取，只能工厂化 + 注入 getter/setter，并回调 `handleMainWindowClose`、以及托盘控制器的 `applyBadge`。

### 第 4 步 · 关闭流程（最难，最后做）

- 代码（均在 `apps/desktop/src/main.mts`，按函数名定位）：`handleMainWindowClose` / `showClosePrompt` / `quitFromClosePrompt` / `stopLocalServerProcess` / `closeLocalServerForExit` / `prepareLocalServerForUpdateInstall` / `recoverAfterUpdateInstallFailure`。横跨模块级 `isQuitting` / `shutdownPromise` / `closePromptPending` / `localServer` / `desktopAgentBrokerRecoveryGate` / `serverProcess`，并被 shutdown handler、`prepareForInstall` / `recoverAfterInstallFailure` 回调以及多处退出路径反向调用。
- 建议只把**纯函数**抽走：`stopLocalServerProcess`、`showClosePrompt`、`quitFromClosePrompt`；编排（`closeLocalServerForExit`、`prepareLocalServerForUpdateInstall`、`recoverAfterUpdateInstallFailure`）留主模块。

## 二、agent-service.ts：先断开类型纠缠

> **本节完成状态（2026-10-07 复核）**：`agent-service.ts` 已从 3226 行降至 1304 行，下述第 1、2 项**已完成**，「不要动」清单中的 `streamMessage` / `providerMessages` 也已移出本文件。第 3、4 项部分完成，剩余部分见下。

**不要动**（已移出本文件，改为按新位置标注）：`streamMessage`（主体在 `apps/server/src/agent/run-engine.ts`，`agent-service.ts` 仅保留委托）、`invokeExternalTool`（仍在 `agent-service.ts`）、`providerMessages`（在 `agent/run-engine.ts` 为 `RunEngine` 私有方法；`agent/openai-compatible-provider.ts` 另有一个同名模块级函数负责 wire 格式，二者不是同一个东西）、确认链路（→ `agent/confirmation-lifecycle.ts`）。

1. ~~**先独立 `AgentServiceError`**~~ → **✅ 已完成**：落在 `apps/server/src/agent/agent-shared.ts`（与 `now` / `requiredText` 等共享工具同文件，文件名不是原文设想的 `agent-error.ts`），由 `agent-service.ts` 再导出，`routes/agent.ts` / `routes/translation.ts` 无需改动。
2. ~~**provider 配置域**~~ → **✅ 已完成**：常量、`isLoopbackHost` / `normalizeEndpoint` / `providerSummary` / `parseProviderConfiguration` / `providerConnectionFingerprint` / `validateTimeout`、内部类型 `ProviderRow` / `ProviderConfiguration` / `DefaultProviderConfiguration`，以及 `AgentProviderStore` 均已落在 `apps/server/src/agent/provider-service.ts`。
   - 补充实测：回环判定在原计划后又进一步拆出 `apps/server/src/endpoint-guard.ts` 的 `isLoopbackHostname`，`provider-service.ts` / `provider-common.ts` / `translation.ts` 共用（**与 `config.ts` 的 bind 校验语义不同，不得合并**）。
3. **一次性 LLM 任务**：`translateWithProvider` 与 `evaluateAutoReply` **仍在 `agent-service.ts`**；`generateConversationTitle` 已变为私有方法，其调用点经构造注入交给 `agent/run-engine.ts`（见 `RunEngine` 的 `generateConversationTitle` 依赖）。三者仍同构，若要继续提取，**先补测试再动**。
4. **会话作用域与租约**：`agent-service.ts` 现仅剩一个会话工具方法，会话域主体已在 `agent/conversations.ts` / `agent/lifecycle.ts`。原测绘的四个区间已不可定位，本项按「已完成」处理。

## 三、App.tsx 与 styles.css

- `App.tsx`：**已完成大幅瘦身**（3764 → 3031 行；棘轮 4380 尚有余量）。原文「尚未做接缝测绘」的判断已过时——现已抽出的模块（含 `AgentWorkspace` 侧的 `agent/useAgentSession`）已证明路径可行。若继续提取，仍应先测绘再动手。
- `styles.css`：**原计划已完成**。16906 行的单文件已拆为 `styles/` 下 30 个模块（按 `tokens` / `base` / `components` / `overlays` / `features` 五层），根 `styles.css` 只剩 30 行 `@import` 索引，由 `styles-size.test.ts` 断言「根文件只含 `@import` 与空行」且聚合行数不超过 `FROZEN_AGGREGATED_MAX_LINES`。若继续瘦身，CSS 拆分的最大风险仍是**层叠顺序**而非语法：按「完全独立的选择器族」逐块外移，每移一块跑一次 e2e 几何与视觉基线，`designTokens.test.ts` / `themeContrast.test.ts` 继续守住不回退。

## 四、每一步的门禁

1. `npm run typecheck`（四 workspace）
2. 对应 workspace 全量单测。**测试文件数实测（2026-10-07，`*.test.ts(x)` 文件数口径，非用例数）**：desktop 33 / server 132 / web 119。用例数会随批次变化，请以 `npm test` 实际输出为准，不要沿用本文数字。
3. `npm run test:e2e`（默认跑 smoke / interactions / update-footer / geometry 4 个 spec；`e2e/` 下共 8 个 spec，其中 `ui-stress.spec.ts` 是需种子数据 + 长超时的独立压测通道，`capture-*` / `shots` 是无入口的手动工具）
4. 涉及 main.mts 的步骤额外跑 `npm run smoke:desktop`，涉及打包行为时跑 `npm run smoke:package`
5. 每步一个提交，提交信息写清「搬了什么、为什么这样切、怎么验证的」
