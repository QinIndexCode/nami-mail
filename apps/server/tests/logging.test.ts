import { afterEach, describe, expect, it, vi } from "vitest";
import { serverLog, setServerLogger } from "../src/logging.js";

afterEach(() => setServerLogger(undefined));

function captureStderr(): { lines: () => unknown[]; restore: () => void } {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    lines: () => write.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown),
    restore: () => write.mockRestore(),
  };
}

describe("serverLog", () => {
  it("writes structured JSONL to stderr while no logger is installed", () => {
    const stderr = captureStderr();
    try {
      serverLog.warn({ accountId: "account-1" }, "Mailbox sync failed");
      expect(stderr.lines()).toEqual([
        expect.objectContaining({ level: 40, accountId: "account-1", msg: "Mailbox sync failed" }),
      ]);
      expect(typeof (stderr.lines()[0] as { time?: unknown }).time).toBe("number");
    } finally {
      stderr.restore();
    }
  });

  it("maps severity to pino level numbers so fallback lines sort with real output", () => {
    const stderr = captureStderr();
    try {
      serverLog.info({}, "i");
      serverLog.warn({}, "w");
      serverLog.error({}, "e");
      expect(stderr.lines().map((line) => (line as { level: number }).level)).toEqual([30, 40, 50]);
    } finally {
      stderr.restore();
    }
  });

  it("delegates to the installed logger and keeps a stack under err", () => {
    const calls: Array<{ meta: object; message: string }> = [];
    setServerLogger({
      info: () => undefined,
      warn: (meta, message) => calls.push({ meta, message }),
      error: () => undefined,
    });
    const error = new Error("Mailbox is gone");
    serverLog.warn({ accountId: "account-1" }, "Mailbox sync failed", error);
    // `err` is the only key Fastify's default pino serializer expands.
    expect(calls).toEqual([{ meta: { accountId: "account-1", err: error }, message: "Mailbox sync failed" }]);
  });

  it("does not send a bare error key when there is nothing to report", () => {
    const stderr = captureStderr();
    try {
      serverLog.warn({ accountId: "account-1" }, "No error attached");
      expect(stderr.lines()[0]).not.toHaveProperty("err");
    } finally {
      stderr.restore();
    }
  });

  it("returns to the stderr fallback once the logger is removed", () => {
    setServerLogger({ info: () => undefined, warn: () => undefined, error: () => undefined });
    setServerLogger(undefined);
    const stderr = captureStderr();
    try {
      serverLog.info({}, "after close");
      expect(stderr.lines()).toHaveLength(1);
    } finally {
      stderr.restore();
    }
  });

  it("never throws when the write itself fails", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    try {
      expect(() => serverLog.error({}, "boom")).not.toThrow();
    } finally {
      write.mockRestore();
    }
  });
});
