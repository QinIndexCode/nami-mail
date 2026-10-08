import assert from "node:assert/strict";
import test from "node:test";
import {
  createServiceRestartCoordinator,
  evaluateServiceRestart,
  initialServiceRestartState,
  nextServiceRestartDelayMs,
  recordServiceRecovery,
  recordServiceRestartAttempt,
  resetServiceRestartStateIfDue,
  serviceGiveUpDialogOptions,
  serviceRestartStableResetMs,
  serviceRestartWindowMs,
  type ServiceRestartCoordinatorDeps,
} from "../src/service-restart-policy.mts";

/** Manual-clock, queued-schedule harness: no real timers, fully deterministic. */
function createCoordinatorHarness() {
  const scheduledDelays: number[] = [];
  const pendingRuns: Array<() => void> = [];
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const restartQueue: Array<() => Promise<void>> = [];
  const flags = { shuttingDown: false, serviceRunning: true, giveUpCalls: 0, now: 0 };
  let restartCalls = 0;
  const coordinator = createServiceRestartCoordinator({
    log: (event, detail) => events.push({ event, detail }),
    isShuttingDown: () => flags.shuttingDown,
    isServiceRunning: () => flags.serviceRunning,
    restart: () => {
      restartCalls += 1;
      const next = restartQueue.shift();
      if (!next) return Promise.reject(new Error("No restart result queued."));
      return next();
    },
    giveUp: () => { flags.giveUpCalls += 1; },
    now: () => flags.now,
    schedule: (delayMs, run) => {
      scheduledDelays.push(delayMs);
      pendingRuns.push(run);
    },
  } satisfies ServiceRestartCoordinatorDeps);
  return {
    coordinator,
    events,
    flags,
    restartQueue,
    scheduledDelays,
    get restartCalls() { return restartCalls; },
    // The coordinator settles attempts in microtasks; flush them so a drained
    // schedule is fully settled (recovery recorded or failure re-decided).
    async drainSchedule() {
      for (const run of pendingRuns.splice(0)) run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

const startupFailure = async () => {
  throw new Error("service start failed");
};

test("backs off exponentially (1s/5s/30s) and gives up on the fourth failure", () => {
  const t0 = 1_000_000;
  let state = initialServiceRestartState;
  assert.deepEqual(evaluateServiceRestart(state, t0), { action: "restart", delayMs: 1_000 });
  state = recordServiceRestartAttempt(state, t0);
  assert.deepEqual(evaluateServiceRestart(state, t0 + 2_000), { action: "restart", delayMs: 5_000 });
  state = recordServiceRestartAttempt(state, t0 + 2_000);
  assert.deepEqual(evaluateServiceRestart(state, t0 + 8_000), { action: "restart", delayMs: 30_000 });
  state = recordServiceRestartAttempt(state, t0 + 8_000);
  assert.deepEqual(evaluateServiceRestart(state, t0 + 40_000), { action: "give-up" });
});

test("keeps counting inside the window and resets once the window slid past", () => {
  const t0 = 0;
  let state = recordServiceRestartAttempt(initialServiceRestartState, t0);
  state = recordServiceRestartAttempt(state, t0 + 60_000);
  // One millisecond inside the window: the spent attempts still count.
  const insideWindow = resetServiceRestartStateIfDue(state, t0 + serviceRestartWindowMs - 1);
  assert.equal(nextServiceRestartDelayMs(insideWindow), 30_000);
  // Exactly at the window boundary the budget is fresh again.
  assert.deepEqual(evaluateServiceRestart(state, t0 + serviceRestartWindowMs), { action: "restart", delayMs: 1_000 });
});

test("resets the attempt count after the service ran stably past the reset period", () => {
  const t0 = 0;
  let state = recordServiceRestartAttempt(initialServiceRestartState, t0);
  state = recordServiceRecovery(state, t0 + 1_000);
  // One millisecond before stability: the count persists (window not slid yet).
  const beforeStable = resetServiceRestartStateIfDue(state, t0 + 1_000 + serviceRestartStableResetMs - 1);
  assert.equal(nextServiceRestartDelayMs(beforeStable), 5_000);
  assert.deepEqual(
    evaluateServiceRestart(state, t0 + 1_000 + serviceRestartStableResetMs),
    { action: "restart", delayMs: 1_000 },
  );
});

test("give-up dialog copy is an error box pointing at the runtime log", () => {
  const options = serviceGiveUpDialogOptions();
  assert.equal(options.type, "error");
  assert.ok(options.message.includes("could not be restarted"));
  assert.ok(options.detail.includes("runtime-log.jsonl"));
  assert.ok(options.buttons.includes("OK"));
});

test("wiring: an unexpected exit logs, decides a backoff restart, and logs the recovery", async () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.onServiceProcessExit(null);
  assert.deepEqual(harness.events.map((entry) => entry.event), ["server-process-exited", "service-restart-scheduled"]);
  assert.deepEqual(harness.scheduledDelays, [1_000]);

  harness.restartQueue.push(async () => undefined);
  await harness.drainSchedule();
  assert.equal(harness.restartCalls, 1);
  assert.equal(harness.events.at(-1)?.event, "local-service-restarted");
  assert.equal(harness.flags.giveUpCalls, 0);
  assert.equal(harness.scheduledDelays.length, 1);
});

test("wiring: repeated failures run the 1s/5s/30s budget, then give up exactly once", async () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.onServiceProcessExit(1);
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();

  assert.equal(harness.restartCalls, 3);
  assert.deepEqual(harness.scheduledDelays, [1_000, 5_000, 30_000]);
  assert.equal(harness.flags.giveUpCalls, 1);
  assert.ok(harness.events.some((entry) => entry.event === "service-restart-attempt-failed"));
  assert.ok(harness.events.some((entry) => entry.event === "service-restart-abandoned"));

  // A straggler exit after give-up must not re-prompt or reschedule.
  harness.coordinator.onServiceProcessExit(1);
  assert.equal(harness.flags.giveUpCalls, 1);
  assert.equal(harness.scheduledDelays.length, 3);
});

test("wiring: expected exits during shutdown never trigger a restart", () => {
  const harness = createCoordinatorHarness();
  harness.flags.shuttingDown = true;
  harness.coordinator.onServiceProcessExit(0);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.scheduledDelays.length, 0);
  assert.equal(harness.flags.giveUpCalls, 0);
});

test("wiring: an exit during a start handshake is logged but owned by start()'s rejection", () => {
  const harness = createCoordinatorHarness();
  harness.flags.serviceRunning = false;
  harness.coordinator.onServiceProcessExit(null);
  assert.deepEqual(harness.events.map((entry) => entry.event), ["server-process-exited"]);
  assert.equal(harness.scheduledDelays.length, 0);
  assert.equal(harness.flags.giveUpCalls, 0);
});

test("wiring: an exit while a restart attempt is in flight does not double-count", async () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.onServiceProcessExit(1);
  let releaseAttempt: () => void = () => undefined;
  harness.restartQueue.push(() => new Promise<void>((resolve) => { releaseAttempt = resolve; }));
  await harness.drainSchedule();
  assert.equal(harness.restartCalls, 1);

  // The freshly forked attempt dies during its own start handshake.
  harness.coordinator.onServiceProcessExit(null);
  assert.equal(harness.scheduledDelays.length, 1);
  assert.equal(harness.flags.giveUpCalls, 0);

  releaseAttempt();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.events.at(-1)?.event, "local-service-restarted");

  // Recovery recorded; the very next crash is a normal continuation of the
  // budget (no stable period elapsed, so the second-step backoff applies),
  // never a double-counted give-up.
  harness.coordinator.onServiceProcessExit(1);
  assert.deepEqual(harness.scheduledDelays, [1_000, 5_000]);
  assert.equal(harness.flags.giveUpCalls, 0);
});

test("wiring: a crash after a stable period starts a fresh backoff sequence", async () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.onServiceProcessExit(1);
  harness.restartQueue.push(async () => undefined);
  await harness.drainSchedule();

  harness.flags.now = 6 * 60_000;
  harness.coordinator.onServiceProcessExit(1);
  assert.deepEqual(harness.scheduledDelays, [1_000, 1_000]);
  assert.equal(harness.flags.giveUpCalls, 0);
});

/*
 * Self-check derivation for the coordinator's reset-before-decide ordering and
 * the recovery-premise clearing in recordServiceRestartAttempt (three scenes):
 *
 *   a) recovery -> stable >= 5min -> crash: the first failure settles the due
 *      stable reset, so the budget restarts from attempts=0 (1s backoff) with
 *      windowStartedAt re-anchored at the new failure.
 *   b) recovery -> stable >= 5min -> crash-on-boot loop: after the first loop
 *      failure lastRecoveryAt is undefined, so the stable reset cannot fire
 *      again; 1s/5s/30s are spent and the 4th failure gives up. (Regression:
 *      a stale lastRecoveryAt used to re-clear the budget on every failure,
 *      making give-up unreachable and forking forever.)
 *   c) legal resets are untouched: a real recovery plus a silent period still
 *      resets (scene a), and the window-slide reset — whose recorded state has
 *      lastRecoveryAt undefined after any attempt — still fires at the 10min
 *      boundary (covered by the pure-function window test above).
 */
test("wiring: gives up after the bounded budget even when the service had recovered before the crash loop", async () => {
  const harness = createCoordinatorHarness();
  // Setup: one crash, one successful restart — recovery recorded at now=1s.
  harness.flags.now = 1_000;
  harness.coordinator.onServiceProcessExit(1);
  harness.restartQueue.push(async () => undefined);
  await harness.drainSchedule();
  assert.equal(harness.flags.giveUpCalls, 0);

  // Much later (past the stable-reset period) the service enters a
  // crash-on-boot loop: every restart attempt fails immediately.
  harness.flags.now = 6 * 60_000;
  harness.coordinator.onServiceProcessExit(1);
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();

  // The first loop failure opens a fresh budget (1s), the loop climbs the
  // backoff (5s/30s), and the fourth failure gives up exactly once.
  assert.equal(harness.restartCalls, 4);
  assert.deepEqual(harness.scheduledDelays, [1_000, 1_000, 5_000, 30_000]);
  assert.equal(harness.flags.giveUpCalls, 1);
  assert.ok(harness.events.some((entry) => entry.event === "service-restart-abandoned"));

  // A straggler exit after give-up must not re-prompt or reschedule.
  harness.coordinator.onServiceProcessExit(1);
  assert.equal(harness.flags.giveUpCalls, 1);
  assert.equal(harness.scheduledDelays.length, 4);
});

test("wiring: still resets the budget when the service stayed up past the stable window before failing", async () => {
  const harness = createCoordinatorHarness();
  // Setup: one crash, one successful restart — recovery recorded at now=1s.
  harness.flags.now = 1_000;
  harness.coordinator.onServiceProcessExit(1);
  harness.restartQueue.push(async () => undefined);
  await harness.drainSchedule();

  // The service stayed up well past the stable-reset period; the next crash
  // must open a fresh budget starting at the 1s backoff (scene a), with the
  // record built on the reset state (window re-anchored, recovery premise
  // cleared).
  harness.flags.now = 6 * 60_000;
  harness.coordinator.onServiceProcessExit(1);
  assert.deepEqual(harness.scheduledDelays, [1_000, 1_000]);
  assert.equal(harness.flags.giveUpCalls, 0);

  // The follow-up failure counts inside the fresh window (second-step backoff,
  // not another reset): this pins both halves of the fix — a preserved
  // lastRecoveryAt would re-clear to 1s, a stale record basis would jump 30s.
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();
  assert.deepEqual(harness.scheduledDelays, [1_000, 1_000, 5_000]);
  assert.equal(harness.flags.giveUpCalls, 0);
  assert.equal(harness.restartCalls, 2);
});

test("suppresses a queued restart once shutdown has started (R11)", async () => {
  const harness = createCoordinatorHarness();
  // Crash outside shutdown: the decision schedules an attempt.
  harness.coordinator.onServiceProcessExit(1);
  assert.equal(harness.scheduledDelays.length, 1);

  // The user quits (or an update begins) before the backoff timer fires.
  harness.flags.shuttingDown = true;
  await harness.drainSchedule();

  assert.equal(harness.restartCalls, 0);
  assert.equal(harness.flags.giveUpCalls, 0);
  assert.deepEqual(harness.scheduledDelays, [1_000]);
});

test("suppresses an already-queued follow-up attempt once shutdown has started (R11)", async () => {
  const harness = createCoordinatorHarness();
  harness.coordinator.onServiceProcessExit(1);
  harness.restartQueue.push(startupFailure);
  await harness.drainSchedule();
  assert.equal(harness.restartCalls, 1);
  assert.equal(harness.scheduledDelays.length, 2);

  // Shutdown starts while the NEXT queued attempt is pending: the before-
  // attempt gate suppresses it entirely — restart is never called, nothing
  // is rescheduled, and no give-up prompt fires during teardown.
  harness.flags.shuttingDown = true;
  await harness.drainSchedule();

  assert.equal(harness.restartCalls, 1);
  assert.equal(harness.scheduledDelays.length, 2);
  assert.equal(harness.flags.giveUpCalls, 0);
});

test("suppresses the next decision when an in-flight attempt fails during shutdown (R11)", async () => {
  const harness = createCoordinatorHarness();
  // The attempt is already in flight when shutdown starts: its rejection
  // settles into a shutdown that is tearing the service down, so it must
  // neither re-decide nor prompt.
  let failAttempt!: () => void;
  harness.restartQueue.push(() => new Promise<void>((_resolve, reject) => { failAttempt = reject; }));
  harness.coordinator.onServiceProcessExit(1);
  await harness.drainSchedule();
  assert.equal(harness.restartCalls, 1);

  harness.flags.shuttingDown = true;
  failAttempt();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.scheduledDelays.length, 1);
  assert.equal(harness.flags.giveUpCalls, 0);
});

test("records recovery during shutdown but schedules nothing further (R11)", async () => {
  const harness = createCoordinatorHarness();
  let finishAttempt!: () => void;
  harness.restartQueue.push(() => new Promise<void>((resolve) => { finishAttempt = resolve; }));
  harness.coordinator.onServiceProcessExit(1);
  await harness.drainSchedule();
  assert.equal(harness.restartCalls, 1);

  // Shutdown starts while the restart attempt is still in flight; the
  // recovery then lands into that shutdown.
  harness.flags.shuttingDown = true;
  finishAttempt();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.scheduledDelays.length, 1);
  assert.ok(harness.events.some((event) => event.event === "service-restart-suppressed"));
});
