import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncScheduler } from "../src/runtime.js";

describe("background sync scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces the pending delay when the persisted refresh setting changes", async () => {
    let refreshIntervalSeconds = 300;
    const sync = vi.fn(async () => undefined);
    const scheduler = createSyncScheduler({
      getIntervalSeconds: () => refreshIntervalSeconds,
      sync,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).not.toHaveBeenCalled();

    refreshIntervalSeconds = 30;
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);

    await scheduler.close();
  });

  it("does not overlap sync work and waits for completion before scheduling again", async () => {
    let finishFirstSync: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      finishFirstSync = resolve;
    });
    let syncCalls = 0;
    const sync = vi.fn(() => {
      syncCalls += 1;
      return syncCalls === 1 ? firstSync : Promise.resolve();
    });
    const scheduler = createSyncScheduler({
      getIntervalSeconds: () => 30,
      sync,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sync).toHaveBeenCalledTimes(1);

    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sync).toHaveBeenCalledTimes(1);

    finishFirstSync?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);

    await scheduler.close();
  });

  it("stops new work and waits for an in-flight sync before closing", async () => {
    let finishSync: (() => void) | undefined;
    const syncFinished = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    const sync = vi.fn(() => syncFinished);
    const scheduler = createSyncScheduler({
      getIntervalSeconds: () => 30,
      sync,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sync).toHaveBeenCalledTimes(1);

    let closeResolved = false;
    const closePromise = scheduler.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sync).toHaveBeenCalledTimes(1);

    finishSync?.();
    await closePromise;
    expect(closeResolved).toBe(true);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("cancels pending work when closed before the first sync", async () => {
    const sync = vi.fn(async () => undefined);
    const scheduler = createSyncScheduler({
      getIntervalSeconds: () => 30,
      sync,
    });

    await scheduler.close();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(sync).not.toHaveBeenCalled();
  });
});
