import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { moveMessage, batchMoveMessages } = vi.hoisted(() => ({
  moveMessage: vi.fn(),
  batchMoveMessages: vi.fn(),
}));

// The operation queue serializes through the real sync write locks, so only
// the executor entry points are replaced.
vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, moveMessage, batchMoveMessages };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createOperationQueue } from "../src/operation-queue.js";

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
      await vi.waitFor(() => expect(moveMessage).toHaveBeenCalledTimes(1));
      const second = app.inject({ method: "POST", url: "/api/messages/message-2/move", payload: { target: "trash" } });

      // While the first move is in flight, the second request is durably
      // queued (pending row) instead of failing with a busy error.
      await vi.waitFor(() => {
        const pending = db.prepare("SELECT COUNT(*) AS c FROM operation_queue WHERE status = 'pending'").get() as { c: number };
        expect(pending.c).toBe(1);
      });
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
    await vi.waitFor(() => expect(calls.sort()).toEqual(["message-1", "message-2"]));
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
    expect(response.json()).toEqual({ ok: false, message: "Message not found." });
    const row = db.prepare("SELECT status FROM operation_queue").get() as { status: string };
    expect(row.status).toBe("failed");
  });
});
