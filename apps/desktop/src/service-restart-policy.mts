/**
 * Restart policy for the local-service utility process.
 *
 * The utility process carries the whole backend (SQLite, IMAP, Agent loop).
 * When it died unexpectedly the desktop used to stay silently broken: every
 * bridge request failed, the tray served a dead settings snapshot and a
 * tray-resident user had no signal for days. This module owns the decision
 * side of the recovery — whether to restart, after how long, or when to give
 * up — as pure, time-injected state transitions plus a thin coordinator that
 * sequences them. Electron stays out of here; `main.mts` supplies the effects
 * (forking the service, dialogs, quitting) through the coordinator deps.
 *
 * Policy: exponential backoff (1s/5s/30s) with a bounded budget. Within a
 * 10-minute window at most 3 restarts are attempted; a 4th failure escalates
 * to give-up instead of looping forever on a service that crashes on boot.
 * The counter resets when the window slides past, or after the service stayed
 * up for a stable period, so an isolated crash days into a session starts a
 * fresh budget. A failure itself voids the recovered-stable premise (the
 * recovery timestamp is dropped on the first recorded attempt), so a
 * crash-on-boot loop always burns the full budget and reaches give-up.
 */

export type ServiceRestartDecision =
  | { action: "restart"; delayMs: number }
  | { action: "give-up" };

export const serviceRestartMaxBackoffMs = 30_000;
export const serviceRestartBackoffMs: readonly number[] = [1_000, 5_000, serviceRestartMaxBackoffMs];
export const serviceRestartWindowMs = 10 * 60_000;
export const serviceRestartStableResetMs = 5 * 60_000;
export const maxServiceRestartAttempts = 3;

/** Immutable policy state; transitions return the next state. */
export type ServiceRestartState = {
  /** Restart attempts spent inside the current window. */
  attempts: number;
  /** When the current failure window opened (first unreset attempt). */
  windowStartedAt: number | undefined;
  /** When the service last came back up; drives the stability reset. */
  lastRecoveryAt: number | undefined;
};

export const initialServiceRestartState: ServiceRestartState = {
  attempts: 0,
  windowStartedAt: undefined,
  lastRecoveryAt: undefined,
};

/** Drops spent attempts once the window slid past or the service ran stably. */
export function resetServiceRestartStateIfDue(state: ServiceRestartState, now: number): ServiceRestartState {
  if (state.lastRecoveryAt !== undefined && now - state.lastRecoveryAt >= serviceRestartStableResetMs) {
    return { attempts: 0, windowStartedAt: undefined, lastRecoveryAt: state.lastRecoveryAt };
  }
  if (state.windowStartedAt !== undefined && now - state.windowStartedAt >= serviceRestartWindowMs) {
    return { attempts: 0, windowStartedAt: undefined, lastRecoveryAt: state.lastRecoveryAt };
  }
  return state;
}

/** Backoff for the next restart; clamps so an overrun state still restarts. */
export function nextServiceRestartDelayMs(state: ServiceRestartState): number {
  const index = Math.min(Math.max(state.attempts, 0), serviceRestartBackoffMs.length - 1);
  return serviceRestartBackoffMs[index] ?? serviceRestartMaxBackoffMs;
}

export function evaluateServiceRestart(state: ServiceRestartState, now: number): ServiceRestartDecision {
  const current = resetServiceRestartStateIfDue(state, now);
  if (current.attempts >= maxServiceRestartAttempts) return { action: "give-up" };
  return { action: "restart", delayMs: nextServiceRestartDelayMs(current) };
}

/**
 * Records that a restart was decided (and will run) at `now`. A failure voids
 * the "recovered and running" premise: lastRecoveryAt is cleared, so the
 * stable-period reset can only fire again after a real recovery plus a real
 * silent period — never repeatedly inside a crash-on-boot failure loop (where
 * a stale lastRecoveryAt would otherwise clear the budget on every failure
 * and make give-up unreachable).
 */
export function recordServiceRestartAttempt(state: ServiceRestartState, now: number): ServiceRestartState {
  return {
    attempts: state.attempts + 1,
    windowStartedAt: state.windowStartedAt ?? now,
    lastRecoveryAt: undefined,
  };
}

/** Records that the service came back up at `now`. */
export function recordServiceRecovery(state: ServiceRestartState, now: number): ServiceRestartState {
  return { ...state, lastRecoveryAt: now };
}

/**
 * The give-up dialog is user-facing policy, so its copy lives next to the
 * decision that triggers it. Structurally compatible with Electron's
 * MessageBoxOptions; main.mts hands it straight to dialog.showMessageBox.
 */
export type ServiceGiveUpDialogOptions = {
  type: "error";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  noLink: boolean;
};

export function serviceGiveUpDialogOptions(): ServiceGiveUpDialogOptions {
  return {
    type: "error",
    title: "Nami Mail local service stopped",
    message: "The local mail service stopped and could not be restarted. Your data is safe. Restart Nami Mail to continue.",
    detail: "Details were written to runtime-log.jsonl in the Nami Mail user data folder.",
    buttons: ["OK"],
    noLink: true,
  };
}

/**
 * The lifecycle inputs that must suppress a queued or in-flight restart
 * (R11): quitting, a started quit/close sequence, an app-requested service
 * exit — and an update drain. `prepareLocalServerForUpdateInstall` drains
 * the service and closes it BEFORE it sets isQuitting, so the drain window
 * is shutdown-equivalent: a restart timer firing there would fork a service
 * the installer is about to take down. main.mts feeds its live flags through
 * this one predicate, so the coordinator and the recovery-path guards share
 * a single definition instead of drifting.
 */
export type ServiceLifecycleState = {
  isQuitting: boolean;
  /** A quit/close sequence has started (shutdownPromise present). */
  shutdownStarted: boolean;
  /** The service exit was requested by the app itself. */
  serverProcessExpectedExit: boolean;
  /** An update install is draining the service. */
  updateDraining: boolean;
};

export function isServiceLifecycleShuttingDown(state: ServiceLifecycleState): boolean {
  return state.isQuitting || state.shutdownStarted || state.serverProcessExpectedExit || state.updateDraining;
}

export type ServiceRestartCoordinatorDeps = {
  /** Bounded runtime-log appender; every decision and attempt is logged. */
  log: (event: string, detail?: Record<string, unknown>) => void;
  /** True while the app is quitting or tearing the service down on purpose. */
  isShuttingDown: () => boolean;
  /** True only while a started service handle is installed. */
  isServiceRunning: () => boolean;
  /** Brings the service back up (fork, bridge, renderer, broker). */
  restart: () => Promise<void>;
  /** Surfaces the give-up state to the user and quits. */
  giveUp: () => void;
  now?: () => number;
  schedule?: (delayMs: number, run: () => void) => void;
};

/**
 * Sequences the policy against the process lifecycle. One coordinator spans
 * every service incarnation: crash -> decision -> backoff -> restart, with the
 * races closed (exits during shutdown, during boot's first start handshake and
 * during a restart's own handshake are all ignored — those paths own their
 * error surfacing).
 */
export function createServiceRestartCoordinator(deps: ServiceRestartCoordinatorDeps): {
  onServiceProcessExit: (code: number | null) => void;
} {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule
    ?? ((delayMs: number, run: () => void) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
    });
  let state: ServiceRestartState = { ...initialServiceRestartState };
  // A restart is bringing the service up: exits observed in that window belong
  // to the attempt's own start() rejection, never to a new decision.
  let attemptInFlight = false;
  // Once the budget is spent the decision is final; late exits (e.g. a straggler
  // event racing the give-up quit) must never reschedule or re-prompt.
  let givenUp = false;

  const handleFailure = (): void => {
    // Settle any due reset BEFORE deciding and recording, on one clock
    // reading, so evaluate and record share the same (reset) state. Otherwise
    // a reset due right now would be seen by evaluate's internal check but not
    // by record: the stale window/attempt basis would be incremented, and in a
    // crash-on-boot loop after an old recovery the stale lastRecoveryAt would
    // re-trigger the stable reset on every failure, clearing the budget
    // forever (give-up unreachable, unbounded restart forking).
    const failedAt = now();
    state = resetServiceRestartStateIfDue(state, failedAt);
    const decision = evaluateServiceRestart(state, failedAt);
    if (decision.action === "give-up") {
      givenUp = true;
      deps.log("service-restart-abandoned", { attempts: state.attempts });
      deps.giveUp();
      return;
    }
    state = recordServiceRestartAttempt(state, failedAt);
    deps.log("service-restart-scheduled", { attempts: state.attempts, delayMs: decision.delayMs });
    schedule(decision.delayMs, runAttempt);
  };

  const runAttempt = (): void => {
    // The timer may fire after the user quit or an update began: a queued
    // restart must never race the shutdown/installation sequence. The same
    // gate re-arms after the attempt settles, in both outcomes.
    if (deps.isShuttingDown()) {
      deps.log("service-restart-suppressed", { phase: "before-attempt" });
      return;
    }
    attemptInFlight = true;
    deps.restart()
      .then(() => {
        attemptInFlight = false;
        state = recordServiceRecovery(state, now());
        if (deps.isShuttingDown()) {
          // The service came back up into a shutdown that started mid-attempt:
          // recovery is recorded, but the lifecycle owns what happens next.
          deps.log("service-restart-suppressed", { phase: "after-recovery" });
          return;
        }
        deps.log("local-service-restarted", {});
      })
      .catch((error: unknown) => {
        attemptInFlight = false;
        deps.log("service-restart-attempt-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        // A failure observed while shutting down belongs to the teardown
        // sequence — deciding a next attempt here could fork a service the
        // app is actively tearing down.
        if (deps.isShuttingDown()) {
          deps.log("service-restart-suppressed", { phase: "after-failure" });
          return;
        }
        handleFailure();
      });
  };

  return {
    onServiceProcessExit(code: number | null): void {
      if (givenUp || deps.isShuttingDown()) return;
      deps.log("server-process-exited", { code });
      // Without a running handle this exit belongs to a start handshake
      // (initial boot or an in-flight attempt): its rejection reports it.
      if (!deps.isServiceRunning() || attemptInFlight) return;
      handleFailure();
    },
  };
}
