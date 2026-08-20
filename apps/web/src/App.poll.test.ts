// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { accountShowsFreshness, accountStatusDotClass, shouldPollTick } from "./App";

describe("shouldPollTick", () => {
  const intervalMs = 60_000;

  it("polls when no SSE event has ever arrived (stream disabled or never connected)", () => {
    // lastSseEventAt starts at 0; a fresh mount must keep the poll cadence.
    expect(shouldPollTick(0, 1_700_000_000_000, intervalMs)).toBe(true);
  });

  it("skips every tick while events keep the stream fresh", () => {
    const lastEvent = 5_000_000;
    expect(shouldPollTick(lastEvent, lastEvent + 1, intervalMs)).toBe(false);
    expect(shouldPollTick(lastEvent, lastEvent + 20_000, intervalMs)).toBe(false);
    expect(shouldPollTick(lastEvent, lastEvent + intervalMs - 1, intervalMs)).toBe(false);
  });

  it("polls again once a full interval passes without an event", () => {
    const lastEvent = 5_000_000;
    expect(shouldPollTick(lastEvent, lastEvent + intervalMs, intervalMs)).toBe(true);
    expect(shouldPollTick(lastEvent, lastEvent + intervalMs + 5_000, intervalMs)).toBe(true);
  });
});

describe("accountStatusDotClass", () => {
  const presentation = (severity: "error" | "warning") =>
    ({ kind: "sync", severity, title: "t", message: "m", guidance: "g", retryable: false }) as const;

  it("keeps the raw status when there is no issue", () => {
    expect(accountStatusDotClass(undefined, "connected")).toBe("connected");
    expect(accountStatusDotClass(undefined, "degraded")).toBe("degraded");
  });

  it("uses the warning state for sync-cap warnings", () => {
    expect(accountStatusDotClass(presentation("warning"), "connected")).toBe("warning");
  });

  it("forces the error state for real issues regardless of status", () => {
    expect(accountStatusDotClass(presentation("error"), "connected")).toBe("error");
    expect(accountStatusDotClass(presentation("error"), "degraded")).toBe("error");
  });
});

describe("accountShowsFreshness", () => {
  const presentation = (severity: "error" | "warning") =>
    ({ kind: "sync", severity, title: "t", message: "m", guidance: "g", retryable: false }) as const;

  it("keeps the freshness line for healthy accounts and warnings", () => {
    expect(accountShowsFreshness(undefined)).toBe(true);
    expect(accountShowsFreshness(presentation("warning"))).toBe(true);
  });

  it("hands the subtitle to real issues only", () => {
    expect(accountShowsFreshness(presentation("error"))).toBe(false);
  });
});