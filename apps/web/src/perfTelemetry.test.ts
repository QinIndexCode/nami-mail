import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerfTelemetryHandle } from "./perfTelemetry";

declare global {
  // Installed by installPerfTelemetry (see perfTelemetry.ts).
  var __namiPerf: PerfTelemetryHandle | undefined;
}
import {
  beginSpan,
  configurePerfTelemetry,
  DEFAULT_PERF_THRESHOLDS,
  formatPerfReport,
  installPerfTelemetry,
  markInterval,
  observeLongTasks,
  perfEntries,
  recordApiTiming,
  recordCommit,
  setPerfTelemetryEnabled,
  trackSpan,
} from "./perfTelemetry";

const ORIGINAL_INFO = console.info;

function reset(): void {
  installPerfTelemetry();
  globalThis.__namiPerf?.clear();
  configurePerfTelemetry(DEFAULT_PERF_THRESHOLDS);
  setPerfTelemetryEnabled(true);
}

describe("perfTelemetry", () => {
  beforeEach(() => {
    console.info = vi.fn();
    reset();
  });

  afterEach(() => {
    console.info = ORIGINAL_INFO;
  });

  it("records a slow span above the threshold and skips fast ones", () => {
    configurePerfTelemetry({ spanMs: 0 });
    const finish = beginSpan("op.test");
    const ms = finish({ rows: 5 });
    expect(ms).toBeGreaterThanOrEqual(0);
    const entries = perfEntries().filter((entry) => entry.name === "op.test");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("slow-span");
    expect(entries[0].detail).toEqual({ rows: 5 });

    configurePerfTelemetry({ spanMs: 60_000 });
    beginSpan("op.fast")({ rows: 1 });
    expect(perfEntries().filter((entry) => entry.name === "op.fast")).toHaveLength(0);
  });

  it("trackSpan returns the wrapped value and records slow runs", () => {
    const value = trackSpan("op.track", () => "result", { count: 1 });
    expect(value).toBe("result");
    // default 200ms threshold not reached
    expect(perfEntries().filter((entry) => entry.name === "op.track")).toHaveLength(0);

    configurePerfTelemetry({ spanMs: 0 });
    trackSpan("op.track", () => 42, { count: 2 });
    const entries = perfEntries().filter((entry) => entry.name === "op.track");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toEqual({ count: 2 });
  });

  it("records a slow-interval only when the gap exceeds the threshold", () => {
    configurePerfTelemetry({ intervalMs: 0 });
    markInterval("refresh.test");
    // First firing has no baseline: nothing recorded.
    expect(perfEntries().filter((entry) => entry.name === "refresh.test")).toHaveLength(0);
    markInterval("refresh.test", { source: "sse" });
    const entries = perfEntries().filter((entry) => entry.name === "refresh.test");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("slow-interval");
    expect(entries[0].detail).toEqual({ source: "sse" });

    configurePerfTelemetry({ intervalMs: 60 * 60_000 });
    markInterval("refresh.slow-threshold");
    markInterval("refresh.slow-threshold");
    expect(perfEntries().filter((entry) => entry.name === "refresh.slow-threshold")).toHaveLength(0);
  });

  it("records slow api round trips with outcome detail", () => {
    configurePerfTelemetry({ apiMs: 0 });
    recordApiTiming("/api/messages", 12.4, { status: 200 });
    recordApiTiming("/api/messages", 30, { error: "timeout" });
    const entries = perfEntries().filter((entry) => entry.name === "/api/messages");
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("slow-api");
    expect(entries[0].detail).toEqual({ status: 200 });
    expect(entries[1].detail).toEqual({ error: "timeout" });

    configurePerfTelemetry({ apiMs: 1_000 });
    recordApiTiming("/api/fast", 0.5, { status: 200 });
    expect(perfEntries().filter((entry) => entry.name === "/api/fast")).toHaveLength(0);
  });

  it("records slow react commits with the render phase", () => {
    configurePerfTelemetry({ commitMs: 0 });
    recordCommit("MessageList", 88.2, "update");
    const entries = perfEntries().filter((entry) => entry.name === "MessageList");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("slow-commit");
    expect(entries[0].ms).toBeCloseTo(88.2, 5);
    expect(entries[0].detail).toEqual({ phase: "update" });

    configurePerfTelemetry({ commitMs: 1_000 });
    recordCommit("MessageList", 0.5, "mount");
    expect(perfEntries().filter((entry) => entry.name === "MessageList")).toHaveLength(1);
  });

  it("keeps the ring bounded", () => {
    configurePerfTelemetry({ apiMs: 0 });
    for (let index = 0; index < 350; index += 1) {
      recordApiTiming(`/api/ring/${index}`, 1, { status: 200 });
    }
    expect(perfEntries().length).toBeLessThanOrEqual(300);
    // Oldest entries are evicted first.
    expect(perfEntries().some((entry) => entry.name === "/api/ring/0")).toBe(false);
    expect(perfEntries().some((entry) => entry.name === "/api/ring/349")).toBe(true);
  });

  it("disables recording when disabled", () => {
    configurePerfTelemetry({ apiMs: 0, spanMs: 0, commitMs: 0, intervalMs: 0 });
    setPerfTelemetryEnabled(false);
    recordApiTiming("/api/off", 5, { status: 200 });
    beginSpan("span.off")();
    markInterval("mark.off");
    recordCommit("Commit.off", 5, "update");
    expect(perfEntries()).toHaveLength(0);
    setPerfTelemetryEnabled(true);
  });

  it("formats a report aggregated by kind and name", () => {
    expect(formatPerfReport([])).toContain("no slow operations recorded");
    configurePerfTelemetry({ apiMs: 0, spanMs: 0 });
    recordApiTiming("/api/messages", 100, { status: 200 });
    recordApiTiming("/api/messages", 300, { status: 200 });
    beginSpan("list.merge")({ rows: 10 });
    const report = formatPerfReport();
    expect(report).toContain("3 slow operation(s)");
    expect(report).toContain("slow-api /api/messages");
    // Highest total first.
    expect(report.indexOf("slow-api /api/messages")).toBeLessThan(report.indexOf("slow-span list.merge"));
  });

  it("installs the window handle and clears state through it", () => {
    configurePerfTelemetry({ apiMs: 0 });
    recordApiTiming("/api/handle", 5, { status: 200 });
    const handle = globalThis.__namiPerf;
    expect(handle).toBeDefined();
    expect(handle?.entries().length).toBeGreaterThan(0);
    handle?.clear();
    expect(handle?.entries()).toHaveLength(0);
    expect(handle?.report()).toContain("no slow operations recorded");
    // Threshold getter/setter round trip.
    expect(handle?.thresholds({ apiMs: 42 }).apiMs).toBe(42);
  });

  it("observeLongTasks is a safe no-op without PerformanceObserver", () => {
    // jsdom has no PerformanceObserver: must not throw, must not record.
    expect(() => observeLongTasks()).not.toThrow();
  });
});
