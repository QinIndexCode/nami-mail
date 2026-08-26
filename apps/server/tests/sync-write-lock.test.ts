import { describe, expect, it, vi } from "vitest";

import { acquireAccountWriteSlots, withAccountWriteLocks, withHeldWriteSlots } from "../src/sync.js";

describe("account write locks", () => {
  it("nested acquisition of the same account is a reentrant no-op (no self-deadlock)", async () => {
    const calls: string[] = [];
    await withAccountWriteLocks(["account-1"], async () => {
      calls.push("outer-start");
      await withAccountWriteLocks(["account-1"], async () => {
        calls.push("inner");
      });
      calls.push("outer-end");
    });
    expect(calls).toEqual(["outer-start", "inner", "outer-end"]);
  });

  it("marks held slots so a queued executor's own lock call is skipped", async () => {
    const calls: string[] = [];
    // Mirrors operation-queue.runRow: the slot is acquired, then the executor
    // runs within a held-slot context where its nested withAccountWriteLocks
    // must be a no-op instead of waiting on itself.
    const releases = await acquireAccountWriteSlots(["account-1"]);
    try {
      await withHeldWriteSlots(["account-1"], async () => {
        calls.push("before");
        await withAccountWriteLocks(["account-1"], async () => {
          calls.push("nested");
        });
        calls.push("after");
      });
    } finally {
      for (const release of releases.reverse()) release();
    }
    expect(calls).toEqual(["before", "nested", "after"]);
  });

  it("serializes operations on the same account in FIFO order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withAccountWriteLocks(["account-1"], async () => {
      order.push("first");
      await gate;
    });
    const second = withAccountWriteLocks(["account-1"], async () => {
      order.push("second");
    });
    // Let the first operation acquire the slot before the second is enqueued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("times out waiting for a hung holder instead of blocking forever", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const first = withAccountWriteLocks(["account-1"], async () => {
        await firstGate; // simulates a hung provider command that never settles
      });
      // Let `first` acquire the slot.
      await vi.advanceTimersByTimeAsync(0);

      const second = withAccountWriteLocks(["account-1"], async () => undefined);
      const secondOutcome = second.then(() => "acquired", (error: Error) => error.message);

      // The slot-wait timeout fires; the second operation must fail fast.
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(secondOutcome).resolves.toMatch(/Timed out waiting for the account/);

      // Releasing the first holder still drains the chain cleanly.
      releaseFirst();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });
});
