import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHost, isLoopbackRemoteAddress } from "../src/config.js";

describe("config loopback guards", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("accepts every loopback bind host form", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.8.8.8")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback bind hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
  });

  it("treats missing and IPv4-mapped peer addresses as loopback", () => {
    expect(isLoopbackRemoteAddress(undefined)).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:7f00:1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
  });

  it("rejects LAN and public peer addresses", () => {
    expect(isLoopbackRemoteAddress("10.0.0.7")).toBe(false);
    expect(isLoopbackRemoteAddress("192.168.0.10")).toBe(false);
    expect(isLoopbackRemoteAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackRemoteAddress("2001:db8::1")).toBe(false);
  });

  it("refuses to load with a non-loopback HOST set", async () => {
    const previous = process.env.HOST;
    process.env.HOST = "0.0.0.0";
    try {
      await expect(import("../src/config.js")).rejects.toThrow(/non-loopback host "0\.0\.0\.0"/);
    } finally {
      if (previous === undefined) delete process.env.HOST;
      else process.env.HOST = previous;
    }
  });
});

describe("sync message limit config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // config evaluates its env read once at import time, so each case reloads
  // the module with the desired environment.
  async function loadConfig() {
    vi.resetModules();
    const { config } = await import("../src/config.js");
    return config;
  }

  it("defaults to the newest 200 messages per folder without an override", async () => {
    vi.stubEnv("SYNC_MESSAGE_LIMIT", "");
    await expect(loadConfig()).resolves.toMatchObject({ syncMessageLimit: 200 });
  });

  it("honors an explicit SYNC_MESSAGE_LIMIT override", async () => {
    vi.stubEnv("SYNC_MESSAGE_LIMIT", "0");
    await expect(loadConfig()).resolves.toMatchObject({ syncMessageLimit: 0 });
    vi.stubEnv("SYNC_MESSAGE_LIMIT", "5000");
    await expect(loadConfig()).resolves.toMatchObject({ syncMessageLimit: 5000 });
  });

  it("clamps out-of-range values to the supported range", async () => {
    vi.stubEnv("SYNC_MESSAGE_LIMIT", "999999999");
    await expect(loadConfig()).resolves.toMatchObject({ syncMessageLimit: 100_000 });
    vi.stubEnv("SYNC_MESSAGE_LIMIT", "-5");
    await expect(loadConfig()).resolves.toMatchObject({ syncMessageLimit: 0 });
  });
});
