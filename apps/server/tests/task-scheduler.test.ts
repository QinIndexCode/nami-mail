import { describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createTaskRegistry } from "../src/tasks/registry.js";
import { recordTask, taskRow } from "../src/tasks/store.js";
import { TaskAbortError, startTaskScheduler } from "../src/tasks/scheduler.js";
import type { TaskRegistry, TaskRow, TaskRunner } from "../src/tasks/types.js";

/**
 * The scheduler's concurrency and settlement contract.
 *
 * Three claims are what this file exists to pin, because they are the ones the
 * old write-behind queue provided implicitly and a rewrite can silently lose:
 *
 *   1. one FIFO chain per account, and a retrying task keeps its place in it;
 *   2. chains on different accounts genuinely run at the same time;
 *   3. every exit path settles the row -- success, a runner's own verdict, a
 *      missing runner, and exhausted attempts -- and says so to the hooks once.
 */

const MASTER_KEY = Buffer.alloc(32, 0x17);

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `${id}@example.com`, "gmail", "Gmail", "encrypted", "imap.gmail.com", 993, 1, "smtp.gmail.com", 465, 1, "email", "connected", new Date().toISOString());
}

type Settled = { id: string; status: string; code?: string; message?: string };

type Harness = {
  db: DatabaseHandle;
  registry: TaskRegistry;
  settled: Settled[];
  permanent: Array<{ id: string; status: string }>;
  start(runner: TaskRunner<unknown>, options?: { dueTickMs?: number; retryBaseMs?: number }): ReturnType<typeof startTaskScheduler>;
};

function harness(): Harness {
  const db = openDatabase(":memory:");
  insertAccount(db, "account-1");
  insertAccount(db, "account-2");
  const registry = createTaskRegistry();
  const settled: Settled[] = [];
  const permanent: Harness["permanent"] = [];
  const hooks = {
    onTaskSettled: (task: TaskRow) => {
      // Recorded from the row the hook receives, never re-read: the hook's whole
      // contract is that it already carries the terminal status. Both error
      // fields are kept apart, because an aborted task has a code while a thrown
      // Error has only a message -- merging them would hide which arrived.
      settled.push({
        id: task.id,
        status: task.status,
        ...(task.error_code ? { code: task.error_code } : {}),
        ...(task.error_message ? { message: task.error_message } : {}),
      });
    },
    onTaskPermanentFailure: (task: TaskRow) => permanent.push({ id: task.id, status: task.status }),
  };
  return {
    db,
    registry,
    settled,
    permanent,
    start(runner, options = {}) {
      registry.register("move", runner);
      // A long tick keeps the interval out of the picture: every test drives the
      // chains itself through start()/drain(), so a tick firing mid-test would
      // only add nondeterminism. The tick has its own test below.
      return startTaskScheduler({
        db,
        masterKey: MASTER_KEY,
        registry,
        hooks,
        dueTickMs: options.dueTickMs ?? 60_000,
        retryBaseMs: options.retryBaseMs ?? 1,
        retryMaxMs: options.retryBaseMs ?? 1,
      });
    },
  };
}

describe("task scheduler: settlement", () => {
  it("runs the registered runner and settles the row completed", async () => {
    const h = harness();
    const seen: Array<{ id: string; payload: unknown; items: string[] }> = [];
    const scheduler = h.start(async ({ task, payload, items, report }) => {
      report({ updated: 1 });
      seen.push({ id: task.id, payload, items: items.map((item) => item.message_id) });
    });
    const id = recordTask(h.db, MASTER_KEY, {
      accountId: "account-1",
      kind: "move",
      payload: { target: "Archive" },
      items: [{ messageId: "m1" }],
    });
    scheduler.start(id);
    await scheduler.drain();

    expect(seen).toEqual([{ id, payload: { target: "Archive" }, items: ["m1"] }]);
    expect(taskRow(h.db, id)).toMatchObject({ status: "completed", attempt_count: 1, updated: 1, completed_at: expect.any(Number) });
    expect(h.settled).toEqual([{ id, status: "completed" }]);
    expect(h.permanent).toEqual([]);
    await scheduler.stop();
    h.db.close();
  });

  it("settles a kind with no registered runner as no_runner on the first sighting", async () => {
    const h = harness();
    const scheduler = h.start(async () => undefined);
    // `recordTask` accepts it (the vocabulary is wider than this app's runners),
    // so the only thing standing between a stale kind and a row that stays
    // pending forever is the scheduler's fallback.
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "agent-apply" });
    scheduler.start(id);
    await scheduler.drain();

    expect(taskRow(h.db, id)).toMatchObject({ status: "failed", error_code: "no_runner", attempt_count: 1 });
    expect(h.settled).toEqual([{ id, status: "failed", code: "no_runner", message: `No executor registered for task kind "agent-apply".` }]);
    // A task nobody can run is also a task whose owner has to be told.
    expect(h.permanent).toEqual([{ id, status: "failed" }]);
    await scheduler.stop();
    h.db.close();
  });

  it("retries a throwing runner and settles completed once it succeeds", async () => {
    const h = harness();
    let attempts = 0;
    const scheduler = h.start(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`flaky ${attempts}`);
    });
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", maxAttempts: 5 });
    scheduler.start(id);
    await scheduler.drain();

    expect(attempts).toBe(3);
    expect(taskRow(h.db, id)).toMatchObject({ status: "completed", attempt_count: 3, error_code: null });
    expect(h.settled).toEqual([{ id, status: "completed" }]);
    // An intermediate attempt is not a settlement: the hook fires once, at the end.
    expect(h.permanent).toEqual([]);
    await scheduler.stop();
    h.db.close();
  });

  it("gives up after max_attempts and reports the last error once", async () => {
    const h = harness();
    let attempts = 0;
    const scheduler = h.start(async () => {
      attempts += 1;
      throw new Error("provider said no");
    });
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", maxAttempts: 3 });
    scheduler.start(id);
    await scheduler.drain();

    expect(attempts).toBe(3);
    expect(taskRow(h.db, id)).toMatchObject({ status: "failed", attempt_count: 3, error_message: "provider said no" });
    expect(h.settled).toEqual([{ id, status: "failed", message: "provider said no" }]);
    expect(h.permanent).toEqual([{ id, status: "failed" }]);
    await scheduler.stop();
    h.db.close();
  });

  it("records a runner's own verdict instead of completing it, and never retries it", async () => {
    const h = harness();
    let attempts = 0;
    const scheduler = h.start(async () => {
      attempts += 1;
      // `cancelled` is not a failure: the user withdrew the task, so nothing was
      // promised that has to be taken back and the permanent-failure hook stays
      // quiet.
      throw new TaskAbortError("cancelled", "the user withdrew the snooze");
    });
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move" });
    scheduler.start(id);
    await scheduler.drain();

    expect(attempts).toBe(1);
    expect(taskRow(h.db, id)).toMatchObject({ status: "cancelled", error_message: "the user withdrew the snooze" });
    expect(h.settled).toEqual([{ id, status: "cancelled", message: "the user withdrew the snooze" }]);
    expect(h.permanent).toEqual([]);
    await scheduler.stop();
    h.db.close();
  });

  it("asks for a rollback when a runner aborts as failed", async () => {
    const h = harness();
    const scheduler = h.start(async () => {
      throw new TaskAbortError("failed", "the account is gone", "account_revoked");
    });
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move" });
    scheduler.start(id);
    await scheduler.drain();

    expect(taskRow(h.db, id)).toMatchObject({ status: "failed", error_code: "account_revoked" });
    expect(h.permanent).toEqual([{ id, status: "failed" }]);
    await scheduler.stop();
    h.db.close();
  });

  it("refuses to guess a payload it cannot open, and does not retry the attempt", async () => {
    const h = harness();
    const runner = vi.fn();
    const scheduler = h.start(runner);
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { target: "Archive" } });
    const wrongKey = startTaskScheduler({
      db: h.db,
      masterKey: Buffer.alloc(32, 0x18),
      registry: h.registry,
      hooks: { onTaskSettled: () => undefined },
      dueTickMs: 60_000,
    });
    wrongKey.start(id);
    await wrongKey.drain();

    // A ciphertext that will not open will not open on attempt two either, so the
    // row is failed rather than retried into the same error eight times.
    expect(runner).not.toHaveBeenCalled();
    expect(taskRow(h.db, id)).toMatchObject({ status: "failed", attempt_count: 1 });
    await wrongKey.stop();
    await scheduler.stop();
    h.db.close();
  });
});

describe("task scheduler: ordering", () => {
  it("runs one account's tasks in commit order, never concurrently", async () => {
    const h = harness();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const scheduler = h.start(async ({ payload }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`enter:${(payload as { tag: string }).tag}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`exit:${(payload as { tag: string }).tag}`);
      inFlight -= 1;
    });
    const ids = ["a", "b", "c"].map((tag) => recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { tag } }));
    for (const id of ids) scheduler.start(id);
    await scheduler.drain();

    expect(order).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"]);
    expect(maxInFlight).toBe(1);
    await scheduler.stop();
    h.db.close();
  });

  it("keeps a retrying task's place in the chain instead of letting a newer one overtake", async () => {
    const h = harness();
    const order: string[] = [];
    let attempts = 0;
    const scheduler = h.start(async ({ payload }) => {
      const tag = (payload as { tag: string }).tag;
      order.push(tag);
      attempts += 1;
      if (tag === "first" && attempts === 1) throw new Error("retry me");
    });
    const first = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { tag: "first" } });
    scheduler.start(first);
    await scheduler.drain();
    // The second task arrives after the first is already claimed, so it can only
    // be ordered by the chain.
    const second = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { tag: "second" } });
    scheduler.start(second);
    await scheduler.drain();

    // The retry of `first` came before `second`, not after: they touch the same
    // message, and running them out of order leaves the older write winning.
    expect(order).toEqual(["first", "first", "second"]);
    expect(taskRow(h.db, first)).toMatchObject({ status: "completed", attempt_count: 2 });
    await scheduler.stop();
    h.db.close();
  });

  it("runs different accounts' chains at the same time", async () => {
    const h = harness();
    const order: string[] = [];
    let entered = 0;
    let releaseBoth!: () => void;
    const bothIn = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const scheduler = h.start(async ({ payload }) => {
      const tag = (payload as { tag: string }).tag;
      entered += 1;
      order.push(`enter:${tag}`);
      if (entered === 2) releaseBoth();
      // Bounded, so a serialized implementation fails an assertion instead of
      // hanging the suite: the race resolves and the order shows one chain
      // finishing before the other started.
      await Promise.race([bothIn, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      order.push(`exit:${tag}`);
    });
    const one = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { tag: "one" } });
    const two = recordTask(h.db, MASTER_KEY, { accountId: "account-2", kind: "move", payload: { tag: "two" } });
    scheduler.start(one);
    scheduler.start(two);
    await scheduler.drain();

    expect(order.slice(0, 2).sort()).toEqual(["enter:one", "enter:two"]);
    await scheduler.stop();
    h.db.close();
  });

  it("lets the due tick pick up a task whose time has come", async () => {
    const h = harness();
    const ran: string[] = [];
    const scheduler = h.start(async ({ payload }) => {
      ran.push((payload as { tag: string }).tag);
    }, { dueTickMs: 5 });
    // Already due at startup: the only thing that can dispatch it is the tick.
    recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move", payload: { tag: "due" } });
    await scheduler.resume();

    for (let i = 0; i < 100 && ran.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toEqual(["due"]);
    await scheduler.stop();
    h.db.close();
  });
});

describe("task scheduler: resume", () => {
  it("re-queues the rows a dead process left running", async () => {
    const h = harness();
    const ran: string[] = [];
    const scheduler = h.start(async ({ task }) => {
      ran.push(task.id);
    });
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move" });
    // What a crash mid-run leaves behind: `running`, with an attempt counted.
    h.db.prepare("UPDATE tasks SET status = 'running', attempt_count = 3 WHERE id = ?").run(id);

    expect(await scheduler.resume()).toBe(1);
    await scheduler.drain();

    expect(ran).toEqual([id]);
    // The attempt budget is not refreshed: a task that died mid-retry does not
    // get eight more tries because the process restarted.
    expect(taskRow(h.db, id)).toMatchObject({ status: "completed", attempt_count: 4 });
    await scheduler.stop();
    h.db.close();
  });

  it("does not re-dispatch an already terminal row", async () => {
    const h = harness();
    const ran: string[] = [];
    const scheduler = h.start(async ({ task }) => {
      ran.push(task.id);
    });
    const id = recordTask(h.db, MASTER_KEY, { accountId: "account-1", kind: "move" });
    h.db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), id);

    expect(await scheduler.resume()).toBe(0);
    await scheduler.drain();
    expect(ran).toEqual([]);
    await scheduler.stop();
    h.db.close();
  });
});
