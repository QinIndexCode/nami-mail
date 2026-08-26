// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvatar, setAvatar, subscribeAvatars } from "./avatarStore";

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

const AVATAR = "data:image/jpeg;base64,abc123";

describe("avatarStore", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  afterEach(() => {
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
});