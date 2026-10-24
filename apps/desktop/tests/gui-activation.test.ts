import assert from "node:assert/strict";
import test from "node:test";
import { createGuiActivation, type GuiActivationPorts } from "../src/gui-activation.mts";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides: Partial<GuiActivationPorts> = {}) {
  const delivered: string[] = [];
  const errors: unknown[] = [];
  const boot = deferred();
  const appDocument = deferred();
  let windows = 0;
  let hasWindow = false;
  let createCalls = 0;
  // The fake window reports readiness through this hook once the coordinator
  // exists, exactly the way did-finish-load reports it in the real process.
  const lifecycle = { notifyReady: (): void => undefined };
  const ports: GuiActivationPorts = {
    hasMainWindow: () => hasWindow,
    waitForBoot: () => boot.promise,
    waitForAppDocument: () => appDocument.promise,
    createMainWindow: async () => {
      createCalls += 1;
      await appDocument.promise;
      hasWindow = true;
      windows += 1;
      lifecycle.notifyReady();
    },
    focusMainWindow: () => undefined,
    deliverCompose: (mailtoUrl) => delivered.push(mailtoUrl),
    onError: (error) => errors.push(error),
    ...overrides,
  };
  const activation = createGuiActivation(ports);
  lifecycle.notifyReady = activation.notifyAppDocumentReady;
  return {
    activation,
    delivered,
    errors,
    boot,
    appDocument,
    createCalls: () => createCalls,
    windows: () => windows,
    setWindow: (value: boolean) => { hasWindow = value; },
  };
}

test("queues a mailto until boot, window creation and the app document are ready", async () => {
  const harness = createHarness();
  harness.activation.queueMailto("mailto:first@example.com");
  const activated = harness.activation.activate();
  assert.deepEqual(harness.delivered, []);

  harness.boot.resolve();
  await Promise.resolve();
  assert.equal(harness.createCalls(), 1);
  assert.deepEqual(harness.delivered, []);

  harness.appDocument.resolve();
  await activated;
  assert.equal(harness.windows(), 1);
  assert.deepEqual(harness.delivered, ["mailto:first@example.com"]);
});

test("a splash shell that has not loaded the app document only queues", async () => {
  const harness = createHarness();
  harness.setWindow(true);
  harness.activation.queueMailto("mailto:held@example.com");
  assert.deepEqual(harness.delivered, []);

  harness.activation.notifyAppDocumentReady();
  assert.deepEqual(harness.delivered, ["mailto:held@example.com"]);
});

test("concurrent activations share one boot wait and one window creation", async () => {
  const harness = createHarness();
  const first = harness.activation.activate();
  const second = harness.activation.activate();
  assert.equal(harness.createCalls(), 0);

  harness.boot.resolve();
  await Promise.resolve();
  assert.equal(harness.createCalls(), 1);

  harness.appDocument.resolve();
  await Promise.all([first, second]);
  assert.equal(harness.windows(), 1);
  assert.equal(harness.createCalls(), 1);
});

test("a request is delivered once even if readiness is reported again", async () => {
  const harness = createHarness();
  harness.setWindow(true);
  harness.activation.notifyAppDocumentReady();
  harness.activation.queueMailto("mailto:once@example.com");
  harness.activation.notifyAppDocumentReady();
  assert.deepEqual(harness.delivered, ["mailto:once@example.com"]);
});

test("a failed activation reports the error, keeps the queue and can retry", async () => {
  const failure = new Error("window creation failed");
  const delivered: string[] = [];
  const errors: unknown[] = [];
  let attempts = 0;
  let windowExists = false;
  const lifecycle = { notifyReady: (): void => undefined };
  const activation = createGuiActivation({
    hasMainWindow: () => windowExists,
    waitForBoot: () => Promise.resolve(),
    waitForAppDocument: () => Promise.resolve(),
    createMainWindow: async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
      // The real create path loads the app document, whose did-finish-load is
      // what reports readiness; the fake reports it the same way.
      windowExists = true;
      lifecycle.notifyReady();
    },
    focusMainWindow: () => undefined,
    deliverCompose: (mailtoUrl) => delivered.push(mailtoUrl),
    onError: (error) => errors.push(error),
  });
  lifecycle.notifyReady = activation.notifyAppDocumentReady;
  activation.queueMailto("mailto:retry@example.com");
  await activation.activate();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(delivered, []);

  // The queue survived the failure, and the next activation retries it.
  await activation.activate();
  assert.equal(attempts, 2);
  assert.deepEqual(delivered, ["mailto:retry@example.com"]);
});

test("an app reload does not replay a request that was already delivered", async () => {
  const harness = createHarness();
  harness.setWindow(true);
  harness.activation.notifyAppDocumentReady();
  harness.activation.queueMailto("mailto:reload@example.com");

  harness.activation.notifyLoading();
  harness.activation.queueMailto("mailto:held@example.com");
  assert.deepEqual(harness.delivered, ["mailto:reload@example.com"]);

  harness.activation.notifyAppDocumentReady();
  assert.deepEqual(harness.delivered, ["mailto:reload@example.com", "mailto:held@example.com"]);
});

test("a closed window requires a real window before delivering again", async () => {
  const harness = createHarness();
  harness.setWindow(true);
  harness.activation.notifyAppDocumentReady();
  harness.activation.notifyWindowClosed();
  harness.setWindow(false);
  harness.activation.notifyAppDocumentReady();

  harness.activation.queueMailto("mailto:no-window@example.com");
  assert.deepEqual(harness.delivered, []);
});
