import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as syncMovesModule from "../src/sync-moves.js";

const { moveMessage, batchMoveMessages } = vi.hoisted(() => ({
  moveMessage: vi.fn(),
  batchMoveMessages: vi.fn(),
}));

// The operation queue serializes through the real sync write locks, so only
// the executor entry points are replaced.
vi.mock("../src/sync-moves.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncMovesModule>();
  return { ...actual, moveMessage, batchMoveMessages };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createOperationQueue } from "../src/operation-queue.js";
import { acquireAccountWriteSlots } from "../src/sync-locks.js";

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `${id}@example.com`,
    "gmail",
    "Gmail",
    "encrypted",
    "imap.gmail.com",
    993,
    1,
    "smtp.gmail.com",
    465,
    1,
    "email",
    "connected",
    new Date().toISOString(),
  );
}

function insertMessage(db: DatabaseHandle, id: string, accountId: string, mailbox = "INBOX", uid?: number): void {
  const now = new Date().toISOString();
  const nextUid = uid ?? ((db.prepare("SELECT COALESCE(MAX(uid), 0) + 1 AS next FROM messages WHERE account_id = ? AND mailbox = ?").get(accountId, mailbox) as { next: number }).next);
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, mailbox, nextUid, "Subject", "Sender", "sender@example.com", "[]", now, "", "", "", JSON.stringify([]), 0, 0, now);
}

function insertQueueRow(
  db: DatabaseHandle,
  id: string,
  accountId: string,
  kind: string,
  payload: unknown,
  status: "pending" | "running" | "completed" | "failed",
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO operation_queue (id, account_id, kind, payload_json, status, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, kind, JSON.stringify(payload), status, now, now, status === "completed" || status === "failed" ? now : null);
}

describe("operation queue", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 9) });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  it("queues a second move behind an in-flight one on the same account instead of failing", async () => {
    insertAccount(db);
    insertMessage(db, "message-1", "account-1");
    insertMessage(db, "message-2", "account-1");
    const callOrder: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    moveMessage.mockImplementationOnce(async (_db: unknown, _key: unknown, messageId: string) => {
      callOrder.push(messageId);
      await firstGate;
      return { accountId: "account-1", destination: "Trash", refreshPending: false };
    });
    moveMessage.mockImplementationOnce(async (_db: unknown, _key: unknown, messageId: string) => {
      callOrder.push(messageId);
      return { accountId: "account-1", destination: "Trash", refreshPending: false };
    });

    const first = app.inject({ method: "POST", url: "/api/messages/message-1/move", payload: { target: "trash" } });
    try {
      // Let the first request reach the blocked executor.
      await vi.waitFor(() => expect(moveMessage).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      const second = app.inject({ method: "POST", url: "/api/messages/message-2/move", payload: { target: "trash" } });

      // While the first move is in flight, the second request is durably
      // queued (pending row) instead of failing with a busy error.
      await vi.waitFor(() => {
        const pending = db.prepare("SELECT COUNT(*) AS c FROM operation_queue WHERE status = 'pending'").get() as { c: number };
        expect(pending.c).toBe(1);
      }, { timeout: 10_000 });
      const race = await Promise.race([
        second.then(() => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 80)),
      ]);
      expect(race).toBe("pending");

      releaseFirst();
      const [firstRes, secondRes] = await Promise.all([first, second]);
      expect(firstRes.statusCode).toBe(200);
      expect(secondRes.statusCode).toBe(200);
      // Executors ran strictly in request order.
      expect(callOrder).toEqual(["message-1", "message-2"]);
      const settled = db.prepare("SELECT COUNT(*) AS c FROM operation_queue WHERE status = 'completed'").get() as { c: number };
      expect(settled.c).toBe(2);
    } finally {
      // Never leave the blocked executor hanging across a failed assertion:
      // the app must be able to close and release the account lock chain.
      releaseFirst();
    }
  });

  it("resumes pending and running rows left by a crash and settles them", async () => {
    insertAccount(db);
    const queue = createOperationQueue(db);
    const calls: string[] = [];
    queue.registerRunner("move", async (payload) => {
      calls.push((payload as { messageId: string }).messageId);
    });
    insertQueueRow(db, "op-1", "account-1", "move", { messageId: "message-1", target: "trash" }, "pending");
    insertQueueRow(db, "op-2", "account-1", "move", { messageId: "message-2", target: "trash" }, "running");
    // Settled rows must not be resumed.
    insertQueueRow(db, "op-3", "account-1", "move", { messageId: "message-3", target: "trash" }, "completed");
    insertQueueRow(db, "op-4", "account-1", "move", { messageId: "message-4", target: "trash" }, "failed");

    const resumed = await queue.resumePending();
    expect(resumed).toBe(2);
    await vi.waitFor(() => expect(calls.sort()).toEqual(["message-1", "message-2"]), { timeout: 10_000 });
    const statuses = db.prepare("SELECT id, status FROM operation_queue ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(statuses).toEqual([
      { id: "op-1", status: "completed" },
      { id: "op-2", status: "completed" },
      { id: "op-3", status: "completed" },
      { id: "op-4", status: "failed" },
    ]);
  });

  it("records a failed operation durably and rethrows to the caller", async () => {
    insertAccount(db);
    const queue = createOperationQueue(db);
    queue.registerRunner("move", async () => {
      throw new Error("provider rejected the move");
    });
    await expect(queue.enqueueAndRun(["account-1"], "move", { messageId: "message-1", target: "trash" }))
      .rejects.toThrow("provider rejected the move");
    const row = db.prepare("SELECT * FROM operation_queue").get() as { status: string; error_message: string; attempt_count: number };
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("provider rejected the move");
    expect(row.attempt_count).toBe(1);
  });

  it("enqueues one durable row per affected account for a batch move", async () => {
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    insertMessage(db, "message-1", "account-1");
    insertMessage(db, "message-2", "account-1");
    insertMessage(db, "message-3", "account-2");
    batchMoveMessages.mockResolvedValue({ updated: 1, failed: 0, failures: [], pendingAccounts: new Set<string>() });

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/batch/move",
      payload: { ids: ["message-1", "message-2", "message-3"], target: "trash" },
    });

    expect(response.statusCode).toBe(200);
    const rows = db.prepare("SELECT account_id, payload_json FROM operation_queue ORDER BY account_id").all() as Array<{ account_id: string; payload_json: string }>;
    expect(rows.map((row) => row.account_id)).toEqual(["account-1", "account-2"]);
    const firstPayload = JSON.parse(rows[0]!.payload_json) as { ids: string[] };
    expect([...firstPayload.ids].sort()).toEqual(["message-1", "message-2"]);
    const secondPayload = JSON.parse(rows[1]!.payload_json) as { ids: string[] };
    expect(secondPayload.ids).toEqual(["message-3"]);
    expect(batchMoveMessages).toHaveBeenCalledTimes(2);
  });

  it("surfaces a move failure through the HTTP layer as before", async () => {
    insertAccount(db);
    insertMessage(db, "message-1", "account-1");
    moveMessage.mockRejectedValueOnce(new Error("Message not found."));

    const response = await app.inject({ method: "POST", url: "/api/messages/message-1/move", payload: { target: "trash" } });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ ok: false, code: "unprocessable", message: "Message not found." });
    const row = db.prepare("SELECT status FROM operation_queue").get() as { status: string };
    expect(row.status).toBe("failed");
  });

  it("settles a foreground row as failed when its own write-slot wait times out", async () => {
    vi.useFakeTimers();
    try {
      insertAccount(db);
      const queue = createOperationQueue(db);
      let runnerCalls = 0;
      queue.registerRunner("move", async () => { runnerCalls += 1; });
      // The row's OWN account slot is held elsewhere, so the acquisition
      // inside runRow is what times out — before the executor could be marked
      // running.
      const wedged = await acquireAccountWriteSlots(["account-1"]);
      insertQueueRow(db, "op-1", "account-1", "move", { messageId: "message-1", target: "trash" }, "pending");

      const resumed = queue.resumePending();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await resumed).toBe(1);

      // The row settled as a real failure: it must never resurrect on the
      // next restart, and the executor never ran.
      const row = db.prepare("SELECT status, error_message, error_code, completed_at, attempt_count FROM operation_queue").get() as {
        status: string;
        error_message: string;
        error_code: string | null;
        completed_at: string | null;
        attempt_count: number;
      };
      expect(row.status).toBe("failed");
      expect(row.error_message).toMatch(/Timed out waiting for the account account-1 write slot/);
      expect(row.completed_at).not.toBeNull();
      expect(row.attempt_count).toBe(0);
      expect(runnerCalls).toBe(0);

      // Releasing the wedge afterwards does not bring the row back: only
      // pending/running rows are resumed.
      for (const release of [...wedged].reverse()) release();
      const secondPass = await queue.resumePending();
      expect(secondPass).toBe(0);
      expect(runnerCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up a background operation that lost the account write slot instead of retrying into the same saturation", async () => {
    vi.useFakeTimers();
    try {
      insertAccount(db);
      const givenUp: Array<{ kind: string; payload: unknown }> = [];
      const queue = createOperationQueue(db, {
        onBackgroundPermanentFailure: (kind, payload) => { givenUp.push({ kind, payload }); },
      });
      // A second account whose slot is wedged. An executor that has to touch it
      // (a batch move spanning accounts) can only end in a real write-slot
      // timeout — not a stand-in error — and every attempt is countable.
      const wedged = await acquireAccountWriteSlots(["account-wedged"]);
      let attempts = 0;
      queue.registerRunner("move", async () => {
        attempts += 1;
        const reached = await acquireAccountWriteSlots(["account-wedged"]);
        for (const release of reached.reverse()) release();
      });

      try {
        queue.enqueueBackground(["account-1"], "move", { messageId: "message-1", target: "trash" });
        // Far past the slot-wait budget, and past the whole ~90s retry ladder a
        // transient failure would still be climbing.
        await vi.advanceTimersByTimeAsync(300_000);

        // Exactly one attempt: a saturated account is not a transient fault, and
        // re-queueing would only add another waiter to the queue that just
        // rejected it.
        expect(attempts).toBe(1);
        expect(givenUp).toEqual([{ kind: "move", payload: { messageId: "message-1", target: "trash" } }]);
        const row = db.prepare("SELECT status, error_message FROM operation_queue").get() as {
          status: string;
          error_message: string;
        };
        expect(row.status).toBe("failed");
        expect(row.error_message).toMatch(/Timed out waiting for the account account-wedged write slot/);
      } finally {
        for (const release of [...wedged].reverse()) release();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("still retries a background operation that failed for a transient reason", async () => {
    vi.useFakeTimers();
    try {
      insertAccount(db);
      const givenUp: unknown[] = [];
      const queue = createOperationQueue(db, {
        onBackgroundPermanentFailure: (_kind, payload) => { givenUp.push(payload); },
      });
      let attempts = 0;
      queue.registerRunner("move", async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("ECONNRESET");
      });

      queue.enqueueBackground(["account-1"], "move", { messageId: "message-1", target: "trash" });
      // Backoff after the first two attempts is 1s then 2s.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(attempts).toBe(3);
      expect(givenUp).toEqual([]);
      const row = db.prepare("SELECT status, error_message FROM operation_queue").get() as {
        status: string;
        error_message: string | null;
      };
      expect(row.status).toBe("completed");
      expect(row.error_message).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

