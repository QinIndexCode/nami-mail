import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain } from "electron";
import { registerRendererLocalStoreIpc } from "../src/renderer-local-store-ipc.mjs";

type Listener = (event: { returnValue?: unknown }) => void;
type Handler = (event: unknown, ...arguments_: unknown[]) => unknown;

type FakeIpc = {
  on: (channel: string, listener: Listener) => void;
  handle: (channel: string, handler: Handler) => void;
  readListeners: Map<string, Listener>;
  setHandlers: Map<string, Handler>;
};

function fakeIpc(): FakeIpc {
  const readListeners = new Map<string, Listener>();
  const setHandlers = new Map<string, Handler>();
  return {
    on: (channel, listener) => { readListeners.set(channel, listener); },
    handle: (channel, handler) => { setHandlers.set(channel, handler); },
    readListeners,
    setHandlers,
  };
}

function setup(options: { currentRenderer: boolean } = { currentRenderer: true }) {
  const userDataPath = mkdtempSync(path.join(tmpdir(), "nami-mail-renderer-local-store-ipc-"));
  const ipc = fakeIpc();
  registerRendererLocalStoreIpc(ipc as unknown as Pick<IpcMain, "on" | "handle">, () => options.currentRenderer, () => userDataPath);
  return { ipc, userDataPath };
}

function cleanup(userDataPath: string): void {
  rmSync(userDataPath, { recursive: true, force: true });
}

test("registers exactly the two durable-preference channels", () => {
  const { ipc, userDataPath } = setup();
  try {
    assert.ok(ipc.readListeners.has("nami:local-store-read"));
    assert.ok(ipc.setHandlers.has("nami:local-store-set"));
    assert.equal(ipc.readListeners.size, 1);
    assert.equal(ipc.setHandlers.size, 1);
  } finally {
    cleanup(userDataPath);
  }
});

test("the read handshake answers with the store snapshot synchronously", () => {
  const { ipc, userDataPath } = setup();
  try {
    const event: { returnValue?: unknown } = {};
    ipc.readListeners.get("nami:local-store-read")!(event);
    assert.deepEqual(event.returnValue, {});
  } finally {
    cleanup(userDataPath);
  }
});

test("a foreign renderer gets an empty snapshot and unsaved writes", () => {
  const { ipc, userDataPath } = setup({ currentRenderer: false });
  try {
    const event: { returnValue?: unknown } = {};
    ipc.readListeners.get("nami:local-store-read")!(event);
    assert.deepEqual(event.returnValue, {});
    const result = ipc.setHandlers.get("nami:local-store-set")!({}, "nami-mail.locale-preference", "en-US");
    assert.deepEqual(result, { saved: false });
  } finally {
    cleanup(userDataPath);
  }
});

test("writes land in the store and a later read handshake sees them (new navigation)", () => {
  const { ipc, userDataPath } = setup();
  try {
    const result = ipc.setHandlers.get("nami:local-store-set")!({}, "nami-mail.locale-preference", "en-US");
    assert.deepEqual(result, { saved: true });
    const event: { returnValue?: unknown } = {};
    ipc.readListeners.get("nami:local-store-read")!(event);
    assert.deepEqual(event.returnValue, { "nami-mail.locale-preference": "en-US" });
  } finally {
    cleanup(userDataPath);
  }
});

test("invalid keys are rejected without touching the store", () => {
  const { ipc, userDataPath } = setup();
  try {
    const result = ipc.setHandlers.get("nami:local-store-set")!({}, "foreign.key", "x");
    assert.deepEqual(result, { saved: false, reason: "invalid-key" });
    const event: { returnValue?: unknown } = {};
    ipc.readListeners.get("nami:local-store-read")!(event);
    assert.deepEqual(event.returnValue, {});
  } finally {
    cleanup(userDataPath);
  }
});
