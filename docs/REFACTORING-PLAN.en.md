# Large-file refactoring plan

[简体中文](REFACTORING-PLAN.zh-CN.md)

> ## ⚠️ Status: superseded (reviewed 2026-10-07)
>
> **This document is no longer an executable plan and must not be used as the basis for further splitting.** It records the seam mapping as of **2026-09-11**; three of the four target files have since been heavily refactored, so every line-number pointer and size figure below is now out of range or stale.
>
> What survives is the **methodology and the coupling judgements** (which blocks can move independently, which must move together) — those do not expire as line counts change.
>
> Completed since:
> - **Step 1, tray — done.** Extracted to `createTrayController` in `apps/desktop/src/tray.mts`.
> - `AgentServiceError` → `agent/agent-shared.ts`; `AgentProviderStore` and the provider-configuration domain → `agent/provider-service.ts`; the body of `streamMessage` → `agent/run-engine.ts`.
> - `styles.css` went from a single 16,906-line file to 30 CSS modules under `styles/`, with the root reduced to a 30-line `@import` index.
>
> Still outstanding: steps 2/3/4 below (agent pairing / window shell / close flow) and the remaining §2 extraction items.
>
> **On line numbers**: the drifting pointers below have been rewritten as *function name + file path*. Re-measure with `(Get-Content <path>).Count` and symbol search; do not reuse the historical line numbers.

This is a splitting plan for the four large files `main.mts`, `agent-service.ts`, `App.tsx` and `styles.css`. The seams are already mapped (coupling, shared state), ordered easy → hard, and every step is independently verifiable and committable.

The goal is not a smaller line count but "changing one behaviour touches one file". Run the gates at the end of this document after every step.

## Current state (measured 2026-10-07)

Line counts measured with `(Get-Content <path>).Count`.

| File | Lines | max-lines ratchet | Existing extractions to copy the pattern from |
|---|---|---|---|
| `apps/desktop/src/main.mts` | 2110 | 2112 | `desktop-diagnostics` / `desktop-external-open` / `desktop-notification-sound` / `server-bridge` / `server-host` / `server-process` / `update-pending-install` |
| `apps/server/src/agent-service.ts` | 1304 | 1315 | 50 modules already under `agent/` (run-engine / provider-service / confirmations / tools / memory / mcp …) |
| `apps/web/src/App.tsx` | 3031 | 4380 | `mailListState` / `sendingStatus` / `contextMenu` / `dialogRouting` / `scrollAnchor` / `perfTelemetry` |
| `apps/web/src/AgentWorkspace.tsx` | 2502 | 2516 | `agent/useAgentSession` |
| `apps/web/src/styles.css` | 30 (pure `@import` index) | see `styles-size.test.ts` | the real styles live in 30 modules under `styles/` (base 6 / components 4 / features 16 / overlays 3 / tokens 1), 17,670 lines aggregated, locked by `FROZEN_AGGREGATED_MAX_LINES = 17682` in `styles-size.test.ts` |

> The **authoritative source for every ratchet number is the `max-lines` data table in `eslint.config.mjs`** (plus the aggregated-CSS ratchet in `styles-size.test.ts`). This table is a snapshot only — do not change thresholds based on it.

## 1. main.mts — four blocks

### Step 1 · Tray — ✅ done

**The tray has been extracted to `createTrayController` in `apps/desktop/src/tray.mts`** (its policy function `applyTrayBadge` lives in `apps/desktop/src/desktop-behaviors.mts`). `main.mts` now has a single wiring call, `const trayController = createTrayController({ … })`, and the smoke bridge exposes `trayController.ensure()` / `.focusWindow()` / `.destroy()` to the host.

The original mapping for this step (shape, state ownership, wiring points) landed with the implementation; nothing is left to execute. The line-number pointers in steps 2–4 below have likewise been rewritten as *function name + file path*.

### Step 2 · Agent pairing (about −110 lines) — deferred to the future plan

> **Deferred (2026-09-12)**: this block is not being done now. The mapping stays below so it can start straight away later. Current order: tray (done) → window shell → close flow.

- Code (all in `apps/desktop/src/main.mts`, locate by function name): `recordPairingFailure` / `processAgentPairingRequest` / `scheduleAgentPairingRequests` / `warnExternalPairingScopeDrift` (the pairing-request chain, called from the `second-instance` and open-url paths).
- It owns only `pairingRequestTail` and `pairingScopeDriftNotified` (module-level `let` in `main.mts`).
- Shape: factory plus callbacks (`ensureMainWindowForAgentPairing`, `showNativeNotification`, `focusMainWindow`, `getBroker` / `getServer`).
- Rewiring: the boot-stage calls to `scheduleAgentPairingRequests(initialPairingRequestIds)` and `warnExternalPairingScopeDrift()`, plus the second-instance / open-url path `ensureMainWindowForAgentPairing().then(() => scheduleAgentPairingRequests(...))`.

### Step 3 · Window shell (about −240 lines)

- Code (all in `apps/desktop/src/main.mts`, locate by function name): `resolveSplashPresented` / `waitForSplashPresentation` / `nativeSplashUrl` / `createMainWindowShell` / `loadMainWindowApp` / `createMainWindow` / `ensureMainWindowForAgentPairing` / `observeSplashDismissal`.
- Start with the pure function `nativeSplashUrl`. The rest can only be factory-ised with injected getters/setters because `mainWindow` is read in about 30 places, and they must call back into `handleMainWindowClose` and the tray controller's `applyBadge`.

### Step 4 · Close flow (hardest, do last)

- Code (all in `apps/desktop/src/main.mts`, locate by function name): `handleMainWindowClose` / `showClosePrompt` / `quitFromClosePrompt` / `stopLocalServerProcess` / `closeLocalServerForExit` / `prepareLocalServerForUpdateInstall` / `recoverAfterUpdateInstallFailure`. It spans the module-level `isQuitting` / `shutdownPromise` / `closePromptPending` / `localServer` / `desktopAgentBrokerRecoveryGate` / `serverProcess`, and is called back from the shutdown handler, the `prepareForInstall` / `recoverAfterInstallFailure` callbacks, and several exit paths.
- Extract only the pure functions: `stopLocalServerProcess`, `showClosePrompt`, `quitFromClosePrompt`. Keep the orchestration (`closeLocalServerForExit`, `prepareLocalServerForUpdateInstall`, `recoverAfterUpdateInstallFailure`) in the main module.

## 2. agent-service.ts — untangle the types first

> **Status of this section (reviewed 2026-10-07)**: `agent-service.ts` has gone from 3,226 to 1,304 lines. Items 1 and 2 below are **done**, and `streamMessage` / `providerMessages` from the "do not touch" list have also moved out of this file. Items 3 and 4 are partly done; the remainder is described below.

**Do not touch** (these have moved out of this file, so they are now annotated with their new locations): `streamMessage` (body in `apps/server/src/agent/run-engine.ts`; `agent-service.ts` only keeps the delegation), `invokeExternalTool` (still in `agent-service.ts`), `providerMessages` (a `RunEngine` private method in `agent/run-engine.ts`; note `agent/openai-compatible-provider.ts` has a separate module-level function of the same name that builds the wire format — they are not the same thing), the confirmation path (→ `agent/confirmation-lifecycle.ts`).

1. ~~**Extract `AgentServiceError` first**~~ → **✅ done**: it landed in `apps/server/src/agent/agent-shared.ts` (alongside shared helpers such as `now` / `requiredText` — the filename is not the `agent-error.ts` originally envisaged), re-exported from `agent-service.ts` so `routes/agent.ts` and `routes/translation.ts` need no change.
2. ~~**Provider configuration domain**~~ → **✅ done**: the constants, `isLoopbackHost` / `normalizeEndpoint` / `providerSummary` / `parseProviderConfiguration` / `providerConnectionFingerprint` / `validateTimeout`, the internal types `ProviderRow` / `ProviderConfiguration` / `DefaultProviderConfiguration`, and `AgentProviderStore` all landed in `apps/server/src/agent/provider-service.ts`.
   - Additional finding: loopback detection was later split out again into `isLoopbackHostname` in `apps/server/src/endpoint-guard.ts`, shared by `provider-service.ts` / `provider-common.ts` / `translation.ts` (**its semantics differ from the bind check in `config.ts` — do not merge them**).
3. **One-shot LLM tasks**: `translateWithProvider` and `evaluateAutoReply` are **still in `agent-service.ts`**; `generateConversationTitle` is now a private method whose call site is handed to `agent/run-engine.ts` through constructor injection (see `RunEngine`'s `generateConversationTitle` dependency). The three remain isomorphic; if you continue this extraction, **add tests before moving them**.
4. **Conversation scope and leases**: `agent-service.ts` now retains only one conversation helper; the body of the conversation domain is in `agent/conversations.ts` / `agent/lifecycle.ts`. The four original ranges can no longer be located, so this item is treated as **done**.

## 3. App.tsx and styles.css

- `App.tsx`: **substantially slimmed down** (3,764 → 3,031 lines; the 4,380 ratchet still has headroom). The original "not yet seam-mapped" judgement is obsolete — the modules extracted since (including `agent/useAgentSession` on the `AgentWorkspace` side) have proved the approach works. If you continue extracting, map the seams first anyway.
- `styles.css`: **the original plan is done.** The single 16,906-line file was split into 30 modules under `styles/` (layered as `tokens` / `base` / `components` / `overlays` / `features`), leaving a 30-line `@import`-only root. `styles-size.test.ts` asserts that the root contains only `@import`s and blank lines, and that the aggregated total stays within `FROZEN_AGGREGATED_MAX_LINES`. If you slim further, the main risk in splitting CSS remains **cascade order**, not syntax: move fully independent selector families one block at a time, running the e2e geometry and visual baselines after each; `designTokens.test.ts` / `themeContrast.test.ts` keep holding the line.

## 4. Gates for every step

1. `npm run typecheck` (all four workspaces)
2. Full unit tests for the touched workspace. **Test file counts measured 2026-10-07 (`*.test.ts(x)` files, not test cases)**: desktop 33 / server 132 / web 119. Case counts move with every batch, so trust the actual `npm test` output rather than the numbers written here.
3. `npm run test:e2e` (runs smoke / interactions / update-footer / geometry by default; there are 8 specs under `e2e/`, of which `ui-stress.spec.ts` is a standalone stress channel needing seed data and a long timeout, and `capture-*` / `shots` are manual tools with no entry point)
4. Steps touching `main.mts` also run `npm run smoke:desktop`; when packaging behaviour is involved, run `npm run smoke:package`
5. One commit per step, stating what moved, why the seam was cut there, and how it was verified
