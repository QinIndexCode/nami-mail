# Large-file refactoring plan

[简体中文](REFACTORING-PLAN.zh-CN.md)

An executable plan for splitting `main.mts`, `agent-service.ts`, `App.tsx` and `styles.css`. The seams are already mapped (line ranges, coupling, shared state), ordered easy → hard, and every step is independently verifiable and committable.

The goal is not a smaller line count but "changing one behaviour touches one file". Run the gates at the end of this document after every step.

## Current state (measured 2026-09-11)

| File | Lines | Existing extractions to copy the pattern from |
|---|---|---|
| `apps/desktop/src/main.mts` | 2069 | `desktop-diagnostics` / `desktop-external-open` / `desktop-notification-sound` / `server-bridge` / `server-host` / `server-process` / `update-pending-install` |
| `apps/server/src/agent-service.ts` | 3226 | 20+ modules already under `agent/` (tools / memory / mcp / confirmations …) |
| `apps/web/src/App.tsx` | 3764 | `mailListState` / `sendingStatus` / `contextMenu` / `dialogRouting` / `scrollAnchor` / `perfTelemetry` |
| `apps/web/src/styles.css` | 16906 | `designTokens.test.ts` / `themeContrast.test.ts` act as a debt ratchet |

## 1. main.mts — four blocks

### Step 1 · Tray (easiest, about −110 lines)

- Code: `applyTrayBadge` 564-572, `setTrayIcon` 574-577, `trayBadgeIcon` 579, `loadTrayBadgeIcon` 581-595, `trayIconApi` 597-600, `focusMainWindow` 640-648, `loadDesktopIcon` 650-657, `destroyTray` 659-662, `refreshTrayMenu` 676-696, `runTrayAction` 698-720, `ensureTray` 722-734, `hideMainWindowToTray` 736-751.
- Its own state — `tray` (188), `appIcon` (189), `mainWindowVisible` (194), `trayBadgeIcon` (579) — moves with it.
- Shape: factory `createTrayController({ getMainWindow, getAppIcon, copy, showError, quit })` returning `{ ensure, destroy, focusWindow, hideWindowToTray, applyBadge, getTray, isWindowVisible, setWindowVisible }`.
- Rewiring: smoke bridge 418-434 (`getTray/getAppIcon/ensureTray/destroyTray/focusMainWindow`), close flow 874 and 927 (`destroyTray`), 1080 and 1302 (`applyTrayBadge`), 802 and 826 (`hideMainWindowToTray`), window shell 1216 (`appIcon`), 1248 (`mainWindowVisible`).
- Caveat: tray code is interleaved with non-tray code (`applyLaunchAtStartup`, `applyGlobalShortcut`, `nativeCopy` sit between the tray functions), so move function by function rather than deleting a line range.

### Step 2 · Agent pairing (about −110 lines)

- Code: 1371-1473 (`recordPairingFailure` / `processAgentPairingRequest`), 1472-1478 `scheduleAgentPairingRequests`, 1480 `pairingScopeDriftNotified`, 1487-1512 `warnExternalPairingScopeDrift`.
- Owns only `pairingRequestTail` (223) and `pairingScopeDriftNotified` (1480).
- Shape: factory plus callbacks (`ensureMainWindowForAgentPairing`, `showNativeNotification`, `focusMainWindow`, `getBroker` / `getServer`).
- Rewiring: boot 1711/1712, second-instance 2137.

### Step 3 · Window shell (about −240 lines)

- Code: 1131-1153 (`resolveSplashPresented` / `waitForSplashPresentation`), 1159-1184 `nativeSplashUrl`, 1190-1304 `createMainWindowShell`, 1310-1351 `loadMainWindowApp`, 1355-1359 `createMainWindow`, 1361-1369 `ensureMainWindowForAgentPairing`, 1518-1534 `observeSplashDismissal`.
- Start with the pure function `nativeSplashUrl`. The rest can only be factory-ised with injected getters/setters because `mainWindow` is read in about 30 places, and it must call back into `handleMainWindowClose` and `applyTrayBadge`.

### Step 4 · Close flow (hardest, do last)

- Code: 753-959. Spans `isQuitting` (195), `shutdownPromise` (196), `closePromptPending` (197), `localServer`, `desktopAgentBrokerRecoveryGate` (225) and `serverProcess` (147), and is called back from 348, 396-398, 2164 and 2181-2183.
- Extract only the pure functions: `stopLocalServerProcess` (841-845), `showClosePrompt` (759-771), `quitFromClosePrompt` (773-780). Keep the orchestration (`closeLocalServerForExit`, `prepareLocalServerForUpdateInstall`, `recoverAfterUpdateInstallFailure`) in the main module.

## 2. agent-service.ts — untangle the types first

**Do not touch**: `streamMessage` (1871-2509, spans every state and is pinned by three test suites), `invokeExternalTool` (1292-1556, permission engine + two contracts + confirmation), `providerMessages` (2999-3168, prompt assembly coupled to RAG/memory/tools/i18n), the confirmation path (1729-1869).

1. **Extract `AgentServiceError` (468-479) first** into `agent/agent-error.ts`, re-exported from `agent-service.ts` so `routes/agent.ts` and `routes/translation.ts` need no change. This is a prerequisite for every later extraction — otherwise a new module importing it creates a cycle.
2. **Provider configuration domain**: constants 85-88; `isLoopbackHost` / `normalizeEndpoint` / `providerConfigRecordId` / `providerSummary` / `parseProviderConfiguration` / `providerConnectionFingerprint` / `validateTimeout` (502-606); `AgentProviderStore` (762-919). `AgentProviderStore` has zero external references and is a closed loop.
   - Prerequisite: the internal types `ProviderRow` / `ProviderConfiguration` / `DefaultProviderConfiguration` live at 318-466 and must move with it.
3. **One-shot LLM tasks**: `translateWithProvider` (2533-2609), `generateConversationTitle` (2611-2650), `evaluateAutoReply` (2656-2720) — all shaped the same (resolve provider → build prompt → streamChat → parse). **Add tests before moving them.**
4. **Conversation scope and leases**: 2732-2738, 2773-2840, 2884-2905.

## 3. App.tsx and styles.css

- `App.tsx` has not been seam-mapped yet. The modules already extracted prove the approach works; map it the same way (which effects/handlers depend on only a few pieces of state) before deciding an order. **Do not start without that map.**
- `styles.css`: 16906 lines. The risk in splitting CSS is **cascade order**, not syntax. Move fully independent selector families one block at a time (`.agent-*`, `settings-*`), running the e2e geometry and visual baselines after each; keep `designTokens.test.ts` / `themeContrast.test.ts` as ratchets.

## 4. Gates for every step

1. `npm run typecheck` (all four workspaces)
2. Full unit tests for the touched workspace: desktop `npm test` (193) / server `npm test` (795, including 2 pre-existing settings failures) / web `npm test` (699)
3. `npx playwright test e2e/*.spec.ts` (17)
4. Steps touching `main.mts` also run `npm run smoke:desktop`; when packaging behaviour is involved, run the packaged smoke against `release-artifacts/<ver>/win-unpacked/Nami Mail.exe` (asar `utilityProcess.fork` must work)
5. One commit per step, stating what moved, why the seam was cut there, and how it was verified
