// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvatar, setAvatar, subscribeAvatars } from "./avatarStore";

type BridgeStub = {
  getLocalEntry: (key: string) => string | null;
  setLocalEntry: (key: string, value: string | null) => Promise<{ saved: boolean }>;
  entries: Map<string, string>;
};

function installLocalStorageStub(): Storage {
  const map = new Map<string, string>();
  const stub = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", { value: stub, configurable: true, writable: true });
  return stub;
}

function installDesktopBridge(): BridgeStub {
  const entries = new Map<string, string>();
  const bridge: BridgeStub = {
    entries,
    getLocalEntry: (key: string) => entries.get(key) ?? null,
    setLocalEntry: (key: string, value: string | null) => {
      if (value === null) entries.delete(key);
      else entries.set(key, value);
      return Promise.resolve({ saved: true });
    },
  };
  (window as unknown as { namiDesktop: BridgeStub }).namiDesktop = bridge;
  return bridge;
}

const AVATAR = "data:image/jpeg;base64,abc123";

describe("avatarStore", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  afterEach(() => {
    delete (window as unknown as { namiDesktop?: unknown }).namiDesktop;
    vi.restoreAllMocks();
  });

  it("round-trips an avatar keyed by the normalized email", () => {
    expect(getAvatar("Alice@Example.com")).toBeNull();
    setAvatar("Alice@Example.com", AVATAR);
    expect(getAvatar("alice@example.com")).toBe(AVATAR);
    expect(getAvatar("  ALICE@EXAMPLE.COM ")).toBe(AVATAR);
  });

  it("clears the avatar when set to null", () => {
    setAvatar("bob@example.com", AVATAR);
    expect(getAvatar("bob@example.com")).toBe(AVATAR);
    setAvatar("bob@example.com", null);
    expect(getAvatar("bob@example.com")).toBeNull();
  });

  it("notifies subscribers on set and on clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAvatars(listener);
    setAvatar("carol@example.com", AVATAR);
    expect(listener).toHaveBeenCalledTimes(1);
    setAvatar("carol@example.com", null);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setAvatar("carol@example.com", AVATAR);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("degrades to null when localStorage is unavailable", () => {
    Object.defineProperty(window, "localStorage", {
      get() { throw new Error("denied"); },
      configurable: true,
    });
    expect(getAvatar("dave@example.com")).toBeNull();
    expect(() => setAvatar("dave@example.com", AVATAR)).not.toThrow();
  });

  it("mirrors writes into the desktop durable store and falls back to it when localStorage is empty", () => {
    const bridge = installDesktopBridge();
    setAvatar("erin@example.com", AVATAR);
    expect(bridge.entries.get("nami-mail.avatar.erin@example.com")).toBe(AVATAR);
    // Simulates the next desktop launch: the ephemeral origin's localStorage
    // is empty again, and the durable mirror is what restores the avatar.
    installLocalStorageStub();
    expect(getAvatar("erin@example.com")).toBe(AVATAR);
  });

  it("mirrors clear into the desktop durable store", () => {
    const bridge = installDesktopBridge();
    setAvatar("fred@example.com", AVATAR);
    setAvatar("fred@example.com", null);
    expect(bridge.entries.has("nami-mail.avatar.fred@example.com")).toBe(false);
  });

  it("does not throw when the durable write is rejected (quota, private mode)", () => {
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: () => null,
        setItem: () => { throw new Error("QuotaExceededError"); },
        removeItem: () => { throw new Error("QuotaExceededError"); },
      },
      configurable: true,
    });
    (window as unknown as { namiDesktop: unknown }).namiDesktop = {
      getLocalEntry: () => null,
      setLocalEntry: () => Promise.reject(new Error("ipc failed")),
    };
    const listener = vi.fn();
    const unsubscribe = subscribeAvatars(listener);
    expect(() => setAvatar("gina@example.com", AVATAR)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
