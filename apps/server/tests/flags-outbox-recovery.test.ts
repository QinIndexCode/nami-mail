import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

// Fastify's inject stamps "Host: localhost:80" on requests that carry no host
// header, and the token-less Host allowlist in src/app.ts only accepts this
// server's own loopback authorities on the configured port.
vi.hoisted(() => {
  process.env.PORT = "80";
});

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { clearOrphanedPendingFlagsMarkers, clearPendingFlagsMarkers, commitLocalFlags } from "../src/flags-outbox.js";
import type { OperationQueue } from "../src/operation-queue.js";

function insertAccount(db: DatabaseHandle, id: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    )
    VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, now);
  db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, 'INBOX', 'INBOX', '\\Inbox', 0, 0)")
    .run(id);
}

function insertMessage(db: DatabaseHandle, id: string, accountId: string, uid: number, pendingFlagsPush?: number): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at, pending_flags_push
    )
    VALUES (?, ?, 'INBOX', ?, 'Subject', 'Sender', 'sender@example.test', '[]', ?, '', '', '', ?, 0, 0, ?, ?)
  `).run(id, accountId, uid, now, JSON.stringify(["\\Seen"]), now, pendingFlagsPush ?? null);
}

function insertFlagsPushRow(
  db: DatabaseHandle,
  id: string,
  accountId: string,
  messageIds: string[],
  status: "pending" | "running" | "completed" | "failed",
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO operation_queue (id, account_id, kind, payload_json, status, created_at, updated_at, completed_at)
    VALUES (?, ?, 'flags-push', ?, ?, ?, ?, ?)
  `).run(
    id,
    accountId,
    JSON.stringify({ accountId, entries: messageIds.map((messageId) => ({ id: messageId, mailbox: "INBOX", uid: 1, add: ["\\Flagged"], remove: [] })) }),
    status,
    now,
    now,
    status === "pending" || status === "running" ? null : now,
  );
}

function markerOf(db: DatabaseHandle, id: string): number | null {
  const row = db.prepare("SELECT pending_flags_push FROM messages WHERE id = ?").get(id) as { pending_flags_push: number | null };
  return row.pending_flags_push;
}

describe("orphaned flag push markers", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("clears a marker no push was ever queued for", () => {
    insertAccount(db, "account-1");
    insertMessage(db, "message-1", "account-1", 1, 1);

    expect(clearOrphanedPendingFlagsMarkers(db)).toBe(1);
    expect(markerOf(db, "message-1")).toBe(0);
  });

  it("keeps the marker of a message a pending or running push still owns", () => {
    insertAccount(db, "account-1");
    insertMessage(db, "queued-pending", "account-1", 1, 1);
    insertMessage(db, "queued-running", "account-1", 2, 1);
    insertMessage(db, "orphaned", "account-1", 3, 1);
    insertFlagsPushRow(db, "push-pending", "account-1", ["queued-pending"], "pending");
    insertFlagsPushRow(db, "push-running", "account-1", ["queued-running"], "running");

    expect(clearOrphanedPendingFlagsMarkers(db)).toBe(1);
    expect(markerOf(db, "queued-pending")).toBe(1);
    expect(markerOf(db, "queued-running")).toBe(1);
    expect(markerOf(db, "orphaned")).toBe(0);
  });

  it("matches per message, not per account, so a neighbour's push cannot hide an orphan", () => {
    // Same account, same pending push — but this message is not one of its
    // entries, and an id that merely shares a prefix must not be mistaken for
    // it either.
    insertAccount(db, "account-1");
    insertMessage(db, "message-1", "account-1", 1, 1);
    insertMessage(db, "message-10", "account-1", 2, 1);
    insertMessage(db, "message-2", "account-1", 3, 1);
    insertFlagsPushRow(db, "push-1", "account-1", ["message-1"], "pending");

    expect(clearOrphanedPendingFlagsMarkers(db)).toBe(2);
    expect(markerOf(db, "message-1")).toBe(1);
    expect(markerOf(db, "message-10")).toBe(0);
    expect(markerOf(db, "message-2")).toBe(0);
  });

  it("releases markers whose push has already settled", () => {
    insertAccount(db, "account-1");
    insertMessage(db, "completed-push", "account-1", 1, 1);
    insertMessage(db, "failed-push", "account-1", 2, 1);
    insertFlagsPushRow(db, "push-completed", "account-1", ["completed-push"], "completed");
    insertFlagsPushRow(db, "push-failed", "account-1", ["failed-push"], "failed");

    expect(clearOrphanedPendingFlagsMarkers(db)).toBe(2);
    expect(markerOf(db, "completed-push")).toBe(0);
    expect(markerOf(db, "failed-push")).toBe(0);
  });

  it("leaves unmarked rows and a queue of other kinds alone", () => {
    insertAccount(db, "account-1");
    insertMessage(db, "untouched", "account-1", 1);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO operation_queue (id, account_id, kind, payload_json, status, created_at, updated_at)
      VALUES ('move-1', 'account-1', 'move', ?, 'pending', ?, ?)
    `).run(JSON.stringify({ messageId: "untouched", target: "trash" }), now, now);

    expect(clearOrphanedPendingFlagsMarkers(db)).toBe(0);
    expect(markerOf(db, "untouched")).toBeNull();
  });
});

describe("flag commit durability", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    insertMessage(db, "message-1", "account-1", 1);
  });

  afterEach(() => {
    if (db) db.close();
  });

  function stubQueue(overrides: Partial<OperationQueue>): OperationQueue {
    return {
      registerRunner: () => undefined,
      enqueueAndRun: async () => undefined as never,
      enqueueBackground: () => undefined,
      resumePending: async () => 0,
      stageBackgroundInTransaction: () => () => undefined,
      ...overrides,
    } as OperationQueue;
  }

  it("records the push row inside the same transaction as the marker it belongs to", () => {
    const seenDuringStaging: Array<number | null> = [];
    let started = 0;
    const queue = stubQueue({
      stageBackgroundInTransaction: () => {
        // Reading the marker here is only possible from inside the commit: an
        // outside observer sees it after the transaction returns.
        seenDuringStaging.push(markerOf(db, "message-1"));
        return () => { started += 1; };
      },
    });

    const outcome = commitLocalFlags(db, ["message-1"], { flagged: true }, queue);

    expect(outcome.changedIds).toEqual(["message-1"]);
    expect(seenDuringStaging).toEqual([1]);
    // The FIFO chain joins the row after the commit, never inside it.
    expect(started).toBe(1);
  });

  it("rolls the marker back when the push row cannot be recorded", () => {
    // The failure that used to leave a permanent orphan: the marker committed,
    // the queue insert never did, and nothing would ever clear it again.
    const queue = stubQueue({
      stageBackgroundInTransaction: () => { throw new Error("operation queue insert failed"); },
    });

    expect(() => commitLocalFlags(db, ["message-1"], { flagged: true }, queue)).toThrow("operation queue insert failed");
    expect(markerOf(db, "message-1")).toBeNull();
    const rows = db.prepare("SELECT COUNT(*) AS c FROM operation_queue").get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("startup reconciliation", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    imapClientForAccount.mockReset();
    db = openDatabase(":memory:");
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  it("clears an orphaned marker left behind by an earlier build", async () => {
    insertAccount(db, "account-1");
    insertMessage(db, "orphan", "account-1", 1, 1);
    insertMessage(db, "queued", "account-1", 2, 1);
    // The provider is unreachable, so the queued push keeps retrying and its
    // marker must survive the boot that reconciles the orphan.
    imapClientForAccount.mockReturnValue(undefined as never);
    insertFlagsPushRow(db, "push-queued", "account-1", ["queued"], "pending");

    app = await buildApp({ db, masterKey: Buffer.alloc(32, 5) });

    expect(markerOf(db, "orphan")).toBe(0);
    expect(markerOf(db, "queued")).toBe(1);
  });
});

/**
 * R03: the same message committed twice in quick succession (seen=true then
 * seen=false) is named by TWO flags-push rows. The older row's settlement
 * must not drop the newer row's protection marker, or the next sync can
 * overwrite the user's newest local choice with stale remote state.
 */
describe("settling a flags push keeps newer pushes protected", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    insertMessage(db, "message-1", "account-1", 1, 1);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("keeps the marker when the older push settles while a newer push is still pending", () => {
    insertFlagsPushRow(db, "push-old", "account-1", ["message-1"], "running");
    insertFlagsPushRow(db, "push-new", "account-1", ["message-1"], "pending");

    clearPendingFlagsMarkers(db, ["message-1"]);

    expect(markerOf(db, "message-1")).toBe(1);
  });

  it("keeps the marker when the older push failed permanently while a newer push is pending", () => {
    insertFlagsPushRow(db, "push-old", "account-1", ["message-1"], "failed");
    insertFlagsPushRow(db, "push-new", "account-1", ["message-1"], "pending");

    clearPendingFlagsMarkers(db, ["message-1"]);

    expect(markerOf(db, "message-1")).toBe(1);
  });

  it("clears the marker once the last push that names the message has settled", () => {
    // The settling row itself is 'running' (never 'pending'), so a lone push
    // clears its own messages.
    insertFlagsPushRow(db, "push-old", "account-1", ["message-1"], "running");
    clearPendingFlagsMarkers(db, ["message-1"]);
    expect(markerOf(db, "message-1")).toBe(0);

    // Same after a permanent failure: the row is 'failed', nothing newer
    // names the message.
    insertMessage(db, "message-2", "account-1", 2, 1);
    insertFlagsPushRow(db, "push-failed", "account-1", ["message-2"], "failed");
    clearPendingFlagsMarkers(db, ["message-2"]);
    expect(markerOf(db, "message-2")).toBe(0);
  });

  it("clears the marker when the newer push finally settles as well", () => {
    insertFlagsPushRow(db, "push-old", "account-1", ["message-1"], "failed");
    insertFlagsPushRow(db, "push-new", "account-1", ["message-1"], "pending");
    clearPendingFlagsMarkers(db, ["message-1"]);
    expect(markerOf(db, "message-1")).toBe(1);

    // The newer push settles: nothing pending names the message anymore.
    db.prepare("UPDATE operation_queue SET status = 'completed', completed_at = ? WHERE id = 'push-new'")
      .run(new Date().toISOString());
    clearPendingFlagsMarkers(db, ["message-1"]);
    expect(markerOf(db, "message-1")).toBe(0);
  });
});

