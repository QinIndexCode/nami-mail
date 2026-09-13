import assert from "node:assert/strict";
import test from "node:test";
import {
  createServerBridgeClient,
  defaultServerBridgeSettings,
  isBridgeEvent,
  isBridgeRequest,
  isBridgeResponse,
  PendingRequests,
  type BridgeRequest,
  type ServerBridgeSettings,
  type ServerStartParams,
  type ServerTransport,
} from "../src/server-bridge.mts";

const testSettings: ServerBridgeSettings = {
  locale: "zh-CN",
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  closeBehavior: "ask",
  launchAtStartup: false,
  globalShortcutEnabled: false,
};

function startParams(): ServerStartParams {
  return {
    host: "127.0.0.1",
    port: "0",
    databasePath: "C:/tmp/nami-mail.db",
    masterKey: new Uint8Array(32),
    localApiAccessToken: "token",
    env: {},
  };
}

/** Lets every queued microtask (and the one-hop responder) run. */
const settle = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

type HostReply = { value: unknown } | { error: string };

/**
 * In-memory stand-in for the utility-process transport. `respond` models the
 * service answering a request; anything it leaves unanswered stays pending so a
 * test can trip the exit path.
 */
function createInMemoryTransport(respond?: (request: BridgeRequest) => HostReply | undefined) {
  const received: BridgeRequest[] = [];
  const sent: unknown[] = [];
  let clientListener: ((message: unknown) => void) | undefined;
  let exitListener: ((code: number | null) => void) | undefined;
  let killed = false;

  const transport: ServerTransport = {
    send(message) {
      sent.push(message);
      if (typeof message !== "object" || message === null) return;
      const request = message as BridgeRequest;
      if (typeof request.method !== "string" || typeof request.id !== "number") return;
      received.push(request);
      const reply = respond?.(request);
      if (!reply) return;
      queueMicrotask(() => {
        clientListener?.(rejected(reply) ? { id: request.id, ok: false, error: reply.error } : { id: request.id, ok: true, value: reply.value });
      });
    },
    onMessage(listener) {
      clientListener = listener;
    },
    onExit(listener) {
      exitListener = listener;
    },
    kill() {
      killed = true;
    },
  };

  return {
    transport,
    received,
    sent,
    deliver: (message: unknown) => clientListener?.(message),
    exit: (code: number | null = 0) => exitListener?.(code),
    isKilled: () => killed,
  };
}

function rejected(reply: HostReply): reply is { error: string } {
  return "error" in reply;
}

function answering(settings: ServerBridgeSettings): (request: BridgeRequest) => HostReply | undefined {
  return (request) => {
    if (request.method === "start") return { value: { url: "http://127.0.0.1:4321" } };
    if (request.method === "getSettings") return { value: { ...settings } };
    if (request.method === "updateSettings") {
      return { value: { ...settings, ...(request.params?.[0] as Partial<ServerBridgeSettings> | undefined) } };
    }
    return undefined;
  };
}

test("start() correlates the response and primes the synchronous settings snapshot", async () => {
  const host = createInMemoryTransport((request) => {
    if (request.method === "start") return { value: { url: "http://127.0.0.1:4321" } };
    if (request.method === "getSettings") return { value: { ...testSettings, locale: "en-US" } };
    return undefined;
  });
  const bridge = createServerBridgeClient(host.transport);

  // Before start there is no origin and only the built-in defaults.
  assert.equal(bridge.handle.url, "");
  assert.deepEqual(bridge.handle.getSettings(), defaultServerBridgeSettings);

  const started = await bridge.start(startParams());
  assert.equal(started.url, "http://127.0.0.1:4321");
  assert.equal(bridge.handle.url, "http://127.0.0.1:4321");
  // Synchronous by contract: native menus read it with no await.
  assert.equal(bridge.handle.getSettings().locale, "en-US");
  assert.deepEqual(host.received.map((request) => request.method), ["start", "getSettings"]);
});

test("updateSettings round-trips, and a pushed change refreshes the snapshot", async () => {
  let current: ServerBridgeSettings = { ...testSettings };
  let changeNotifications = 0;
  const host = createInMemoryTransport((request) => {
    if (request.method === "start") return { value: { url: "http://127.0.0.1:1" } };
    if (request.method === "getSettings") return { value: { ...current } };
    if (request.method === "updateSettings") {
      current = { ...current, ...(request.params?.[0] as Partial<ServerBridgeSettings> | undefined) };
      return { value: { ...current } };
    }
    return undefined;
  });
  const bridge = createServerBridgeClient(host.transport, { onSettingsChanged: () => { changeNotifications += 1; } });
  await bridge.start(startParams());
  assert.equal(bridge.handle.getSettings().closeBehavior, "ask");

  const updated = await bridge.handle.updateSettings({ closeBehavior: "tray" });
  assert.equal(updated.closeBehavior, "tray");
  assert.equal(bridge.handle.getSettings().closeBehavior, "tray");
  // A main-initiated write already refreshed the cache; no push is expected.
  assert.equal(changeNotifications, 0);

  // A change made elsewhere (settings page / Agent tool) arrives as an event
  // and refreshes the snapshot without main having to ask.
  current = { ...current, closeBehavior: "quit" };
  host.deliver({ event: "settings-changed", payload: { at: new Date().toISOString() } });
  await settle();
  assert.equal(bridge.handle.getSettings().closeBehavior, "quit");
  assert.equal(changeNotifications, 1);
});

test("forwards host events to the matching handlers and ignores malformed ones", async () => {
  const mail: unknown[] = [];
  const autoReply: unknown[] = [];
  const timings: Array<[string, number]> = [];
  const host = createInMemoryTransport(answering(testSettings));
  const bridge = createServerBridgeClient(host.transport, {
    onNewInboxMessages: (messages) => mail.push(...messages),
    onAutoReplyEvent: (event) => autoReply.push(event),
    onStartupTiming: (stage, elapsedMs) => timings.push([stage, elapsedMs]),
  });
  await bridge.start(startParams());

  host.deliver({ event: "new-inbox-messages", payload: [{ id: "m1", accountId: "a1", subject: "s", fromName: "n", fromAddress: "e" }] });
  host.deliver({ event: "auto-reply-event", payload: { kind: "pending" } });
  host.deliver({ event: "startup-timing", payload: { stage: "server:listen", elapsedMs: 12 } });
  // A structurally wrong payload must not reach native code.
  host.deliver({ event: "startup-timing", payload: { stage: 5, elapsedMs: "12" } });
  // A non-array mail payload degrades to an empty list instead of throwing.
  host.deliver({ event: "new-inbox-messages", payload: "nope" });
  host.deliver({ event: "telemetry-unknown", payload: { anything: true } });

  assert.equal(mail.length, 1);
  assert.deepEqual(autoReply, [{ kind: "pending" }]);
  assert.deepEqual(timings, [["server:listen", 12]]);
});

test("answers host-initiated pairing and confirmation requests, failing closed", async () => {
  const host = createInMemoryTransport(answering(testSettings));
  const bridge = createServerBridgeClient(host.transport, {
    listExternalPairings: async () => [{ profile: "laptop" }],
    requestExternalConfirmation: async (input) => ((input as { approve?: boolean }).approve ? "approve" : "reject"),
  });
  await bridge.start(startParams());

  host.deliver({ id: 900, method: "listExternalPairings", params: [] });
  host.deliver({ id: 901, method: "requestExternalConfirmation", params: [{ approve: true }] });
  host.deliver({ id: 902, method: "teleport" });
  await settle();

  const replies = host.sent
    .filter((message) => typeof (message as { ok?: unknown }).ok === "boolean")
    // Replies land in completion order, which depends on how long each handler
    // awaited; compare by request id instead.
    .sort((left, right) => (left as { id: number }).id - (right as { id: number }).id);
  assert.deepEqual(replies, [
    { id: 900, ok: true, value: [{ profile: "laptop" }] },
    { id: 901, ok: true, value: "approve" },
    { id: 902, ok: false, error: 'Unknown host method "teleport".' },
  ]);

  // Without a confirmation handler the service gets a rejection, never an
  // unintended approval; a missing pairing handler yields an empty list.
  const bareHost = createInMemoryTransport(answering(testSettings));
  const bareBridge = createServerBridgeClient(bareHost.transport);
  await bareBridge.start(startParams());
  bareHost.deliver({ id: 903, method: "requestExternalConfirmation", params: [{}] });
  bareHost.deliver({ id: 904, method: "listExternalPairings", params: [] });
  await settle();
  assert.deepEqual(
    bareHost.sent.filter((message) => typeof (message as { ok?: unknown }).ok === "boolean"),
    [
      { id: 903, ok: true, value: "reject" },
      { id: 904, ok: true, value: [] },
    ],
  );
});

test("surfaces service errors and fails fast after the transport exits", async () => {
  const host = createInMemoryTransport((request) => {
    if (request.method === "start") return { value: { url: "http://127.0.0.1:1" } };
    if (request.method === "getSettings") return { value: { ...testSettings } };
    if (request.method === "invokeExternalAgentTool") return { error: "The provider is unreachable." };
    return undefined;
  });
  const bridge = createServerBridgeClient(host.transport);
  await bridge.start(startParams());

  await assert.rejects(bridge.handle.invokeExternalAgentTool({}), /provider is unreachable/);

  // Never answered: the exit must reject it rather than leak the promise.
  const stranded = bridge.handle.listExternalPairingAccountIds();
  host.exit(1);
  await assert.rejects(stranded, /exited/);
  await assert.rejects(bridge.handle.listExternalPairings(), /no longer running/);
  await assert.rejects(bridge.handle.updateSettings({ closeBehavior: "tray" }), /no longer running/);
});

test("close() is idempotent and only one request reaches the service", async () => {
  const host = createInMemoryTransport((request) => {
    if (request.method === "start") return { value: { url: "http://127.0.0.1:1" } };
    if (request.method === "getSettings") return { value: { ...testSettings } };
    if (request.method === "close") return { value: null };
    return undefined;
  });
  const bridge = createServerBridgeClient(host.transport);
  await bridge.start(startParams());

  await bridge.handle.close();
  await bridge.handle.close();
  assert.equal(host.received.filter((request) => request.method === "close").length, 1);
});

test("PendingRequests settles once and rejects everything on failure", async () => {
  const pending = new PendingRequests();
  const first = pending.create<number>(1);
  const second = pending.create<number>(2);
  assert.equal(pending.size, 2);

  assert.equal(pending.settle({ id: 99, ok: true, value: 0 }), false);
  assert.equal(pending.settle({ id: 1, ok: true, value: 7 }), true);
  assert.equal(pending.settle({ id: 1, ok: true, value: 8 }), false);
  assert.equal(await first.promise, 7);

  pending.rejectAll(new Error("service exited"));
  await assert.rejects(second.promise, /service exited/);
  assert.equal(pending.size, 0);
});

test("bridge message guards discriminate requests, responses and events", () => {
  assert.equal(isBridgeRequest({ id: 1, method: "getSettings" }), true);
  assert.equal(isBridgeRequest({ id: 1, ok: true, value: null }), false);
  assert.equal(isBridgeResponse({ id: 1, ok: false, error: "boom" }), true);
  assert.equal(isBridgeResponse({ id: 1, method: "getSettings" }), false);
  assert.equal(isBridgeEvent({ event: "settings-changed", payload: {} }), true);
  assert.equal(isBridgeEvent({ id: 1, method: "getSettings" }), false);
  assert.equal(isBridgeRequest(null), false);
  assert.equal(isBridgeEvent("settings-changed"), false);
});
