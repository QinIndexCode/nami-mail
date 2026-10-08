// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { durableGet, durableSet } from "./durablePreferences";

/**
 * R12 regression harness: the desktop bridge resolves its writes ASYNCHRONOUSLY
 * and the startup snapshot can still hold a pre-write value, so every test
 * here uses a genuinely delayed/rejecting bridge instead of the synchronous
 * fakes the store-level tests use.
 */
function installDelayedBridge(options: {
  snapshot: Record<string, string>;
  gate?: Promise<void>;
  reject?: boolean;
}): { entries: Map<string, string>; release: () => void } {
  const entries = new Map<string, string>(Object.entries(options.snapshot));
  let release: () => void = () => undefined;
  const gate = options.gate ?? new Promise<void>((resolve) => { release = resolve; });
  (window as unknown as { namiDesktop: unknown }).namiDesktop = {
    getLocalEntry: (key: string) => entries.get(key) ?? null,
    setLocalEntry: (key: string, value: string | null) => {
      if (options.reject) return Promise.reject(new Error("ipc failed"));
      return gate.then(() => {
        if (value === null) entries.delete(key);
        else entries.set(key, value);
        return { saved: true };
      });
    },
  };
  return { entries, release: () => release() };
}

function installLocalStorage(entries: Map<string, string>, options: { failing?: boolean } = {}): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (options.failing) throw new Error("QuotaExceededError");
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        if (options.failing) throw new Error("QuotaExceededError");
        entries.delete(key);
      },
    },
  });
}

describe("durablePreferences session overrides (R12)", () => {
  afterEach(() => {
    delete (window as unknown as { namiDesktop?: unknown }).namiDesktop;
    vi.restoreAllMocks();
  });

  it("a clear right after boot overrides the startup snapshot immediately and stays cleared", async () => {
    const storage = new Map<string, string>();
    installLocalStorage(storage);
    const bridge = installDelayedBridge({ snapshot: { "nami-mail.avatar.alice@example.com": "old-avatar" } });
    // Boot state: localStorage is empty, the snapshot serves the old value.
    expect(durableGet("nami-mail.avatar.alice@example.com")).toBe("old-avatar");

    durableSet("nami-mail.avatar.alice@example.com", null);
    // Before the IPC write lands the read must already return the tombstone,
    // not fall back to the stale snapshot.
    expect(durableGet("nami-mail.avatar.alice@example.com")).toBeNull();

    bridge.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Still null after the durable write settles; the snapshot entry the
    // bridge captured at boot is irrelevant for this session.
    expect(durableGet("nami-mail.avatar.alice@example.com")).toBeNull();
  });

  it("a replacement is visible immediately and survives the asynchronous write", async () => {
    const storage = new Map<string, string>();
    installLocalStorage(storage);
    const bridge = installDelayedBridge({ snapshot: { "k1": "old" } });

    durableSet("k1", "new-avatar");
    expect(durableGet("k1")).toBe("new-avatar");
    bridge.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(durableGet("k1")).toBe("new-avatar");
    expect(storage.get("k1")).toBe("new-avatar");
    expect(bridge.entries.get("k1")).toBe("new-avatar");
  });

  it("a rejected durable write keeps the session value and rejects nothing", async () => {
    const storage = new Map<string, string>();
    installLocalStorage(storage);
    installDelayedBridge({ snapshot: {}, reject: true });

    expect(() => durableSet("k2", "session-value")).not.toThrow();
    expect(durableGet("k2")).toBe("session-value");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The override still governs after the rejection settles.
    expect(durableGet("k2")).toBe("session-value");
  });

  it("a quota-blocked localStorage write still honors the override", () => {
    const storage = new Map<string, string>();
    installLocalStorage(storage, { failing: true });
    installDelayedBridge({ snapshot: {} });

    durableSet("k3", "v");
    expect(durableGet("k3")).toBe("v");
    durableSet("k3", null);
    expect(durableGet("k3")).toBeNull();
  });

  it("the override map distinguishes keys, so one tombstone never leaks into another key", () => {
    const storage = new Map<string, string>();
    installLocalStorage(storage);
    installDelayedBridge({ snapshot: { "k5": "snapshot-value" } });

    durableSet("k4", null);
    expect(durableGet("k5")).toBe("snapshot-value");
  });

  it("browser mode without a bridge round-trips and clears through the same contract", () => {
    const storage = new Map<string, string>();
    installLocalStorage(storage);
    durableSet("k6", "browser-value");
    expect(durableGet("k6")).toBe("browser-value");
    durableSet("k6", null);
    expect(durableGet("k6")).toBeNull();
    expect(storage.has("k6")).toBe(false);
  });

  it("a successful write re-syncs localStorage, so a quota-failed earlier write cannot resurrect the stale value", async () => {
    // The recheck's repro: localStorage already held an old value and its
    // write FAILED (quota). The replacement is chosen, the durable write
    // succeeds — but the session override was dropped on success alone, and
    // the read order then served the OLD localStorage value back forever.
    const storage = new Map<string, string>([["k7", "old-avatar"]]);
    installLocalStorage(storage, { failing: true });
    const bridge = installDelayedBridge({ snapshot: {} });

    durableSet("k7", "new-avatar");
    expect(durableGet("k7")).toBe("new-avatar");

    // The durable write succeeds (the bridge is healthy) while the
    // localStorage write keeps failing for this session.
    bridge.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.entries.get("k7")).toBe("new-avatar");

    // The user-visible value stays the session choice across the settlement:
    // the override is only dropped when a readable surface holds it, and here
    // the permanently quota-blocked localStorage keeps the override alive
    // instead of letting the stale entry win the read order.
    expect(durableGet("k7")).toBe("new-avatar");
  });

  it("a successful clear re-syncs a transiently-quota-blocked surface so the stale value cannot revive", async () => {
    // Same window, but the surface recovers before the durable write settles
    // (a quota that clears, e.g. the user deleted other data). The settlement
    // re-asserts the session value and only then drops the override, so the
    // stale localStorage entry never becomes the authoritative read again.
    const storage = new Map<string, string>([["k8", "old-avatar"]]);
    let failWrites = true;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failWrites) throw new Error("QuotaExceededError");
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          if (failWrites) throw new Error("QuotaExceededError");
          storage.delete(key);
        },
      },
    });
    const bridge = installDelayedBridge({ snapshot: { "k8": "old-avatar" } });

    durableSet("k8", null);
    expect(durableGet("k8")).toBeNull();

    // The quota clears while the durable write is still in flight.
    failWrites = false;
    bridge.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // After the durable clear settles, neither surface may serve the old
    // value again — not the snapshot, not the stale localStorage entry.
    expect(durableGet("k8")).toBeNull();
    expect(storage.has("k8")).toBe(false);
    expect(bridge.entries.has("k8")).toBe(false);
  });
});
