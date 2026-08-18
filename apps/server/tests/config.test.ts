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
