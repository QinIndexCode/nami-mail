import assert from "node:assert/strict";
import test from "node:test";
import { startServerHost } from "../src/server-host.mts";
import type { BridgeRequest, ServerBridgeSettings, ServerStartParams, ServerTransport } from "../src/server-bridge.mts";

const settle = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

function startParams(): ServerStartParams {
  return {
    host: "127.0.0.1",
    port: "0",
    databasePath: "C:/tmp/nami-mail.db",
    masterKey: new Uint8Array(32),
    localApiAccessToken: "token",
    env: { WEB_DIST_PATH: "C:/app/apps/web/dist" },
  };
}

const baseSettings: ServerBridgeSettings = {
  locale: "zh-CN",
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  closeBehavior: "ask",
  launchAtStartup: false,
  globalShortcutEnabled: false,
};

/** Records what the host sends to main and lets a test inject main's replies. */
function createHostHarness() {
  let hostListener: ((message: unknown) => void) | undefined;
  const toMain: unknown[] = [];
  const transport: ServerTransport = {
    send(message) {
      toMain.push(message);
    },
    onMessage(listener) {
      hostListener = listener;
    },
    onExit() {
      // The host never registers an exit hook; killing is main's job.
    },
    kill() {
      // In-memory harness: nothing to kill.
    },
  };
  const requests = () => toMain.filter((message): message is BridgeRequest => typeof (message as BridgeRequest).method === "string" && typeof (message as BridgeRequest).id === "number");
  const replies = () => toMain.filter((message) => typeof (message as { ok?: unknown }).ok === "boolean");
  const events = () => toMain.filter((message): message is { event: string; payload: unknown } => typeof (message as { event?: unknown }).event === "string");
  return {
    transport,
    toMain,
    fromMain: (message: unknown) => hostListener?.(message),
    requests,
    replies,
    events,
  };
}

type FakeServer = {
  url: string;
  invokeExternalAgentTool(input: unknown): Promise<unknown>;
  listExternalPairingAccountIds(): string[];
  listExternalPairings(): readonly unknown[];
  getSettings(): ServerBridgeSettings;
  updateSettings(patch: Record<string, unknown>): ServerBridgeSettings;
  close(): Promise<void>;
};

/** A fake runtime that exposes the options and the server the host built. */
function createFakeRuntime() {
  const state: {
    options?: Record<string, unknown>;
    server?: FakeServer;
    closeCalls: number;
    settings: ServerBridgeSettings;
    envAtImport?: Record<string, string | undefined>;
  } = {
    closeCalls: 0,
    settings: { ...baseSettings },
  };
  const runtime = {
    async startServer(options: Record<string, unknown>) {
      state.options = options;
      const server: FakeServer = {
        url: "http://127.0.0.1:5555",
        invokeExternalAgentTool: async (input: unknown) => ({ ok: true, value: input }),
        listExternalPairingAccountIds: () => ["a1", "a2"],
        listExternalPairings: () => [{ profile: "laptop" }],
        getSettings: () => ({ ...state.settings }),
        updateSettings: (patch: Record<string, unknown>) => {
          state.settings = { ...state.settings, ...(patch as Partial<ServerBridgeSettings>) };
          (state.options?.onSettingsChanged as (() => void) | undefined)?.();
          return { ...state.settings };
        },
        close: async () => {
          state.closeCalls += 1;
        },
      };
      state.server = server;
      return server;
    },
  };
  return { state, runtime };
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("seeds the environment before the runtime is imported", async (t) => {
  const previous = {
    HOST: process.env.HOST,
    PORT: process.env.PORT,
    DATABASE_PATH: process.env.DATABASE_PATH,
    WEB_DIST_PATH: process.env.WEB_DIST_PATH,
  };
  t.after(() => restoreEnv(previous));

  const harness = createHostHarness();
  const { state, runtime } = createFakeRuntime();
  await startServerHost(harness.transport, async () => {
    // The server's config module reads the environment at import time, so this
    // is exactly where the values must already be in place.
    state.envAtImport = {
      HOST: process.env.HOST,
      PORT: process.env.PORT,
      DATABASE_PATH: process.env.DATABASE_PATH,
      WEB_DIST_PATH: process.env.WEB_DIST_PATH,
    };
    return runtime;
  });

  harness.fromMain({ id: 1, method: "start", params: [startParams()] });
  await settle();

  assert.deepEqual(state.envAtImport, {
    HOST: "127.0.0.1",
    PORT: "0",
    DATABASE_PATH: "C:/tmp/nami-mail.db",
    WEB_DIST_PATH: "C:/app/apps/web/dist",
  });
  assert.deepEqual(harness.replies().at(-1), { id: 1, ok: true, value: { url: "http://127.0.0.1:5555" } });
});

test("mints the desktop confirmation capability inside the service process", async () => {
  const harness = createHostHarness();
  const { state, runtime } = createFakeRuntime();
  await startServerHost(harness.transport, async () => runtime);
  harness.fromMain({ id: 1, method: "start", params: [startParams()] });
  await settle();

  const confirmation = state.options?.desktopConfirmation as {
    capability: unknown;
    verifier: { verify(input: unknown): unknown };
  } | undefined;
  assert.ok(confirmation, "the service must own a confirmation capability");

  // Identity, not shape: a structurally identical object a web caller could
  // build must never verify.
  assert.equal(confirmation.verifier.verify({ capability: { __namiDesktopConfirmation: true } }), undefined);
  assert.equal(confirmation.verifier.verify({ capability: Symbol("nami-desktop-confirmation") }), undefined);
  assert.equal(confirmation.verifier.verify({}), undefined);
  assert.equal(confirmation.verifier.verify(undefined), undefined);
  assert.deepEqual(confirmation.verifier.verify({ capability: confirmation.capability }), {
    principalId: "nami-desktop-main",
    surfaceId: "nami-main-window",
  });
});

test("forwards a persisted settings change back to main as an event", async () => {
  const harness = createHostHarness();
  const { state, runtime } = createFakeRuntime();
  await startServerHost(harness.transport, async () => runtime);
  harness.fromMain({ id: 1, method: "start", params: [startParams()] });
  await settle();
  assert.equal(harness.events().length, 0);

  const updated = state.server!.updateSettings({ closeBehavior: "tray" });
  assert.equal(updated.closeBehavior, "tray");

  const events = harness.events();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "settings-changed");
  assert.equal(typeof (events[0]?.payload as { at?: unknown }).at, "string");
});

test("round-trips the host-initiated pairing and confirmation requests", async () => {
  const harness = createHostHarness();
  const { state, runtime } = createFakeRuntime();
  await startServerHost(harness.transport, async () => runtime);
  harness.fromMain({ id: 1, method: "start", params: [startParams()] });
  await settle();

  const options = state.options ?? {};
  const listPairings = options.listExternalPairings as () => Promise<unknown[]>;
  const pairingsPromise = listPairings();
  const pairingsRequest = harness.requests().at(-1);
  assert.equal(pairingsRequest?.method, "listExternalPairings");
  harness.fromMain({ id: pairingsRequest!.id, ok: true, value: [{ profile: "laptop" }] });
  assert.deepEqual(await pairingsPromise, [{ profile: "laptop" }]);

  const externalConfirmation = options.externalConfirmation as { request(input: unknown): Promise<string> };
  const approvePromise = externalConfirmation.request({ title: "Approve?" });
  const confirmRequest = harness.requests().at(-1);
  assert.equal(confirmRequest?.method, "requestExternalConfirmation");
  harness.fromMain({ id: confirmRequest!.id, ok: true, value: "approve" });
  assert.equal(await approvePromise, "approve");

  // Anything that is not exactly "approve" fails closed.
  const rejectPromise = externalConfirmation.request({ title: "Approve?" });
  const secondRequest = harness.requests().at(-1);
  harness.fromMain({ id: secondRequest!.id, ok: true, value: "weird" });
  assert.equal(await rejectPromise, "reject");
});

test("reports a clear error before start and for unknown methods, and closes once", async () => {
  const harness = createHostHarness();
  const { state, runtime } = createFakeRuntime();
  await startServerHost(harness.transport, async () => runtime);

  harness.fromMain({ id: 10, method: "getSettings" });
  await settle();
  assert.deepEqual(harness.replies().at(-1), { id: 10, ok: false, error: "The local service has not started." });

  harness.fromMain({ id: 11, method: "start", params: [startParams()] });
  await settle();
  harness.fromMain({ id: 12, method: "teleport" });
  await settle();
  assert.deepEqual(harness.replies().at(-1), { id: 12, ok: false, error: 'Unknown method "teleport".' });

  harness.fromMain({ id: 13, method: "getSettings" });
  await settle();
  assert.equal((harness.replies().at(-1) as { value: ServerBridgeSettings }).value.closeBehavior, "ask");

  harness.fromMain({ id: 14, method: "listExternalPairingAccountIds" });
  await settle();
  assert.deepEqual((harness.replies().at(-1) as { value: string[] }).value, ["a1", "a2"]);

  harness.fromMain({ id: 15, method: "updateSettings", params: [{ closeBehavior: "quit" }] });
  await settle();
  assert.deepEqual(harness.replies().at(-1), { id: 15, ok: true, value: { ...baseSettings, closeBehavior: "quit" } });

  harness.fromMain({ id: 16, method: "resolveAgentConfirmation", params: [] });
  await settle();
  assert.deepEqual(harness.replies().at(-1), { id: 16, ok: true, value: { ok: false } });

  harness.fromMain({ id: 17, method: "close" });
  await settle();
  assert.equal(state.closeCalls, 1);
  assert.deepEqual(harness.replies().at(-1), { id: 17, ok: true, value: null });
});

test("reports a failed start instead of a fake readiness", async () => {
  const harness = createHostHarness();
  await startServerHost(harness.transport, async () => ({
    async startServer() {
      throw new Error("database is locked");
    },
  }));

  harness.fromMain({ id: 1, method: "start", params: [startParams()] });
  await settle();
  assert.deepEqual(harness.replies().at(-1), { id: 1, ok: false, error: "database is locked" });

  // A failed start must not leave a half-initialized server behind.
  harness.fromMain({ id: 2, method: "getSettings" });
  await settle();
  assert.deepEqual(harness.replies().at(-1), { id: 2, ok: false, error: "The local service has not started." });
});
