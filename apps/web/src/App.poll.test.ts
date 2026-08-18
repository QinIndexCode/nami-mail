// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { shouldPollTick } from "./App";

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