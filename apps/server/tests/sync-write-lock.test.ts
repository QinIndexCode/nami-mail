import { describe, expect, it, vi } from "vitest";

import { acquireAccountWriteSlots, withAccountWriteLocks, withHeldWriteSlots } from "../src/sync-locks.js";

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
    // Mirrors the task scheduler: the slot is acquired, then the runner executes
    // inside a held-slot context where its nested withAccountWriteLocks must be a
    // no-op instead of waiting on itself (`tasks/scheduler.ts:161-163`).
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

  it("keeps an inner run's acquired slots out of the outer context that spawned it", async () => {
    let releaseInner!: () => void;
    const innerGate = new Promise<void>((resolve) => { releaseInner = resolve; });
    let outerOutcome: "queued-behind-inner" | "rode-the-leaked-slot" | undefined;

    await withAccountWriteLocks(["account-1"], async () => {
      // The outer context now holds a real held-slots set (containing
      // account-1). Spawn an inner run for a different account without
      // awaiting it, so the outer context keeps running while the inner run
      // holds account-2.
      const inner = withAccountWriteLocks(["account-2"], async () => {
        await innerGate;
      });
      // Let the inner run acquire account-2.
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Acquiring account-2 from the outer context must queue behind the
      // inner run. A shared held-slots set would make this a reentrant no-op
      // while account-2 is genuinely held by the inner run.
      const outerForAccount2 = withAccountWriteLocks(["account-2"], async () => undefined);
      const raced = await Promise.race([
        outerForAccount2.then(() => "acquired" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      outerOutcome = raced === "acquired" ? "rode-the-leaked-slot" : "queued-behind-inner";
      releaseInner();
      await inner;
      await outerForAccount2;
    });
    expect(outerOutcome).toBe("queued-behind-inner");
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
