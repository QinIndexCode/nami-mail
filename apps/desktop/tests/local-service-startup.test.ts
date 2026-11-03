import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  startDesktopService,
  startLocalServiceAndRestoreDesktop,
  type ServiceStartupPlan,
} from "../src/local-service-startup.mts";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("desktop starts the service with an OS-assigned loopback port", async () => {
  const calls: unknown[] = [];
  const params = { databasePath: "test.db", masterKey: new Uint8Array(32), env: {} };
  await startDesktopService({ start: async (received) => { calls.push(received); } }, params);
  assert.deepEqual(calls, [{ ...params, host: "127.0.0.1", port: "0" }]);
});

test("the utility process starts through the desktop service handshake", async () => {
  const source = ts.createSourceFile("main.mts", await readFile(path.join(desktopRoot, "src", "main.mts"), "utf8"), ts.ScriptTarget.Latest, true);
  const startup = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "startLocalServiceInUtilityProcess");
  assert.ok(startup?.body, "expected the desktop utility process startup function");
  let handshakeCalls = 0;
  let directBridgeStarts = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "startDesktopService" && node.arguments[0]?.getText(source) === "bridge") handshakeCalls += 1;
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "bridge" && node.expression.name.text === "start") directBridgeStarts += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(startup.body);
  assert.equal(handshakeCalls, 1);
  assert.equal(directBridgeStarts, 0);
});

type FakeService = { id: string };

/**
 * Recording harness. Every effect appends to one ordered call log so the tests
 * can assert the *sequence* (the point of the extraction) and not just that
 * each step was called.
 */
function createPlanHarness(overrides: Partial<ServiceStartupPlan<FakeService>> = {}) {
  const calls: string[] = [];
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const installed: FakeService[] = [];
  const failures: unknown[] = [];
  const masterKey = Buffer.alloc(32, 7);
  let releaseWindow: (() => void) | undefined;
  let rejectWindow: ((error: unknown) => void) | undefined;

  const plan: ServiceStartupPlan<FakeService> = {
    loadMasterKey: () => {
      calls.push("loadMasterKey");
      return Promise.resolve(masterKey);
    },
    startService: () => {
      calls.push("startService");
      return Promise.resolve({ id: "service-1" });
    },
    installService: (service) => {
      calls.push("installService");
      installed.push(service);
    },
    applySettings: () => {
      calls.push("applySettings");
    },
    restoreBroker: () => {
      calls.push("restoreBroker");
      return Promise.resolve();
    },
    restoreWindow: () => {
      calls.push("restoreWindow");
      return new Promise<void>((resolve, reject) => {
        releaseWindow = resolve;
        rejectWindow = reject;
      });
    },
    log: (event, detail) => events.push({ event, detail }),
    onServiceStarted: () => {
      calls.push("onServiceStarted");
    },
    onWindowRestored: () => {
      calls.push("onWindowRestored");
    },
    onBrokerRestored: () => {
      calls.push("onBrokerRestored");
    },
    onWindowRestoreFailure: (error) => {
      calls.push("onWindowRestoreFailure");
      failures.push(error);
    },
    ...overrides,
  };

  return {
    calls,
    events,
    failures,
    installed,
    masterKey,
    plan,
    finishWindow: () => releaseWindow?.(),
    failWindow: (error: unknown) => rejectWindow?.(error),
  };
}

/** Lets the promise chain inside the sequence run to its next await. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Resolves to "resolved" or "still-waiting", so a sequence that stops waiting
 * where it must not shows up as a failed assertion instead of a hung run.
 */
async function settleWithin(promise: Promise<unknown>, ms = 50): Promise<"resolved" | "still-waiting"> {
  return Promise.race([
    promise.then(() => "resolved" as const),
    new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), ms)),
  ]);
}

test("starts the service, installs it and applies the desktop settings before the window reload", async () => {
  const harness = createPlanHarness();

  const run = startLocalServiceAndRestoreDesktop(harness.plan);
  await flush();
  harness.finishWindow();

  await run;
  assert.deepEqual(harness.calls, [
    "loadMasterKey",
    "startService",
    "installService",
    "onServiceStarted",
    "applySettings",
    "restoreBroker",
    "restoreWindow",
    "onWindowRestored",
    "onBrokerRestored",
  ]);
  assert.deepEqual(harness.installed, [{ id: "service-1" }]);
});

test("a restart applies the same desktop settings the first launch applies", async () => {
  // DSK-1: the recovery path used to skip applyDesktopSettingsFromServer, so
  // launchAtStartup / globalShortcut silently kept their pre-crash values.
  const firstLaunch = createPlanHarness();
  const recovery = createPlanHarness({ awaitRestores: false });

  const recoveryRun = startLocalServiceAndRestoreDesktop(recovery.plan);
  assert.equal(await settleWithin(recoveryRun), "resolved");
  const recoverySteps = [...recovery.calls];
  recovery.finishWindow();
  await recoveryRun;

  const first = startLocalServiceAndRestoreDesktop(firstLaunch.plan);
  await flush();
  firstLaunch.finishWindow();
  await first;

  const stepsOf = (calls: string[]) => calls.filter((call) => ["loadMasterKey", "startService", "installService", "applySettings", "restoreWindow", "restoreBroker"].includes(call));
  assert.deepEqual(stepsOf(recoverySteps), stepsOf(firstLaunch.calls));
  assert.ok(recoverySteps.includes("applySettings"));
  assert.ok(
    recoverySteps.indexOf("applySettings") < recoverySteps.indexOf("restoreWindow"),
    "settings must be applied before the renderer is reloaded onto the new service",
  );
});

test("runs the broker restore alongside the window instead of after it", async () => {
  const harness = createPlanHarness();

  const run = startLocalServiceAndRestoreDesktop(harness.plan);
  await flush();

  // The broker's PowerShell handshake is the slowest restore; the first paint
  // must not wait for it, so it is started before the window navigation.
  assert.ok(harness.calls.includes("restoreBroker"));
  assert.ok(!harness.calls.includes("onBrokerRestored"));
  harness.finishWindow();
  await run;
  assert.ok(harness.calls.includes("onBrokerRestored"));
});

test("restores the broker for a host without a window", async () => {
  const harness = createPlanHarness({ restoreWindow: undefined });

  await startLocalServiceAndRestoreDesktop(harness.plan);

  assert.deepEqual(harness.calls, [
    "loadMasterKey",
    "startService",
    "installService",
    "onServiceStarted",
    "applySettings",
    "restoreBroker",
    "onBrokerRestored",
  ]);
  assert.deepEqual(harness.failures, []);
});

test("keeps the recovery sequence free of the first-launch instrumentation", async () => {
  // A crash restart must never write smoke progress, splash or pairing work:
  // those hooks are first-launch-only and absent from the recovery plan.
  const harness = createPlanHarness({ awaitRestores: false });

  const run = startLocalServiceAndRestoreDesktop({
    loadMasterKey: harness.plan.loadMasterKey,
    startService: harness.plan.startService,
    installService: harness.plan.installService,
    applySettings: harness.plan.applySettings,
    restoreBroker: harness.plan.restoreBroker,
    restoreWindow: harness.plan.restoreWindow,
    log: harness.plan.log,
    onWindowRestoreFailure: harness.plan.onWindowRestoreFailure,
    awaitRestores: false,
  });
  assert.equal(await settleWithin(run), "resolved");
  const calls = [...harness.calls];
  harness.finishWindow();
  await run;

  assert.deepEqual(calls, [
    "loadMasterKey",
    "startService",
    "installService",
    "applySettings",
    "restoreBroker",
    "restoreWindow",
  ]);
});

test("shows a window reload that failed during recovery instead of failing into the void", async () => {
  const failure = new Error("renderer never painted");
  const harness = createPlanHarness({ awaitRestores: false });

  const run = startLocalServiceAndRestoreDesktop(harness.plan);
  await flush();
  harness.failWindow(failure);

  await run;
  await flush();
  assert.deepEqual(harness.failures, [failure]);
  assert.deepEqual(harness.events.map((entry) => entry.event), ["window-restore-failed"]);
  assert.equal(harness.events[0]?.detail?.message, "renderer never painted");
});

test("does not await the restored surfaces on the recovery path", async () => {
  // The restart handshake must stay bounded by the service start: a renderer
  // that never finishes loading cannot hold it open, or the next crash would be
  // swallowed as part of the attempt that is still running.
  const harness = createPlanHarness({ awaitRestores: false });
  // The window never settles here on purpose, so "resolved" below can only be
  // reached by a sequence that does not wait for it.
  const outcome = await Promise.race([
    startLocalServiceAndRestoreDesktop(harness.plan).then(() => "resolved"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-waiting"), 50)),
  ]);

  assert.equal(outcome, "resolved", "the recovery handshake resolved on the service start alone");
  assert.ok(harness.calls.includes("restoreWindow"));
  assert.ok(!harness.calls.includes("onWindowRestored"));
  assert.ok(!harness.calls.includes("onBrokerRestored"));
  harness.failWindow(new Error("late renderer failure"));
  await flush();
  assert.equal(harness.failures.length, 1, "a late renderer failure is still presented, never unhandled");
});

test("hands a failed window reload to the caller's own failure path when asked", async () => {
  const failure = new Error("first load never finished");
  const harness = createPlanHarness({ windowRestoreFailure: "throw" });

  const run = startLocalServiceAndRestoreDesktop(harness.plan);
  await flush();
  harness.failWindow(failure);

  await assert.rejects(run, failure);
  assert.deepEqual(harness.failures, [], "the caller's own failure path owns a fatal first load");
  assert.deepEqual(harness.events.map((entry) => entry.event), ["window-restore-failed"]);
});

test("zeroes the master key on success and on a failed fork", async () => {
  const started = createPlanHarness();
  const run = startLocalServiceAndRestoreDesktop(started.plan);
  await flush();
  started.finishWindow();
  await run;
  assert.ok(started.masterKey.every((byte) => byte === 0));

  const failedCalls: string[] = [];
  const failed = createPlanHarness({
    startService: () => {
      failedCalls.push("startService");
      return Promise.reject(new Error("fork failed"));
    },
  });
  await assert.rejects(startLocalServiceAndRestoreDesktop(failed.plan), /fork failed/);
  assert.ok(failed.masterKey.every((byte) => byte === 0));
  assert.deepEqual(failed.calls, ["loadMasterKey"], "nothing downstream of a failed fork runs");
});

// DSK-1 was a structural defect: two hand-written copies of one startup
// sequence. Behaviour tests above cannot see a third copy appearing, so the
// wiring in main.mts is pinned here.
test("main.mts brings the local service up through the one shared sequence", async () => {
  const source = await readFile(path.join(desktopRoot, "src", "main.mts"), "utf8");
  const occurrences = (needle: string) => source.split(needle).length - 1;

  assert.equal(occurrences("startLocalServiceAndRestoreDesktop({"), 2, "expected exactly the boot and the crash-recovery call site");
  assert.equal(
    occurrences("startLocalServiceInUtilityProcess({"),
    1,
    "only the shared effects may fork the utility process; a second call site is a re-forked startup sequence",
  );
  assert.equal(
    occurrences("startLocalServiceInUtilityProcess({ dataDirectory, masterKey }"),
    1,
    "the fork must stay inside the shared effects wiring",
  );

  const recovery = source.slice(
    source.indexOf("async function restartLocalServiceAfterCrash"),
    source.indexOf("async function startLocalServiceInUtilityProcess"),
  );
  assert.ok(recovery.length > 0, "expected the crash-recovery restart function in main.mts");
  for (const step of ["startLocalServiceInUtilityProcess", "applyDesktopSettingsFromServer", "loadOrCreateDesktopMasterKey"]) {
    assert.ok(!recovery.includes(step), `the recovery path must not re-inline ${step}: it goes through the shared sequence`);
  }
});
