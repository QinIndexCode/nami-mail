import { afterEach, describe, expect, it } from "vitest";

/**
 * The startup obligation replay (`replayTaskSettlementObligations`).
 *
 * The settle sequence is two statements: `settleTask` commits the terminal
 * status, `notifySettled` runs the repairs one statement later
 * (`scheduler.ts`). A process that dies between the two -- or a hook that
 * throws, which the scheduler's catch only warns about -- leaves the repairs
 * owed forever, and before the replay existed nothing ever ran them again: a
 * refused flags target stayed readable as confirmed (its baseline was never
 * restored), a failed send's optimistic Sent row kept showing a mail no
 * provider holds, and an undo's rows never latched.
 *
 * These tests simulate exactly that death: the row is driven to a terminal
 * status with `settleTask` directly, *without* the hooks, which is the state a
 * killed process leaves on disk. The replay must then land every repair the
 * hook would have, and -- because it cannot tell a repaired row from a missed
 * one -- must also be a row of no-ops when the repairs already ran. That
 * idempotency is not a convenience: the alternative (a "repaired" marker
 * column) would itself need the two-statement window it exists to close.
 *
 * The settlement functions themselves are pinned in `task-settlement.test.ts`
 * and `task-wiring.test.ts`; what this file owns is the *replay* -- that it
 * reaches the same effects the hooks do, that it reports how many repairs
 * landed, and that running it twice changes nothing the second time.
 */

import { accountById } from "../src/account-store.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { prepareSubmission } from "../src/outbox.js";
import { writePendingSentRow } from "../src/pending-sent.js";
import { acceptFlagsTask } from "../src/tasks/kinds/flags.js";
import { clearOrphanedFlagsMarkers } from "../src/tasks/settlement.js";
import { openTaskPayload, recordTask, settleTask, taskRow } from "../src/tasks/store.js";
import type { TaskSpec } from "../src/tasks/types.js";
import { createTaskHooks, replayTaskSettlementObligations } from "../src/tasks/wiring.js";

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const INBOX = "INBOX";
const FIXED_NOW = 1_767_225_600_000;

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ACCOUNT, "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

function insertFolder(db: DatabaseHandle, path: string, name: string, specialUse: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(ACCOUNT, path, name, specialUse);
}

function insertMessage(db: DatabaseHandle, id: string, uid: number): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ACCOUNT, INBOX, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", "[]", 0, 0, new Date().toISOString());
}

function fixture(count: number): { db: DatabaseHandle; ids: string[] } {
  const db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db, INBOX, "Inbox", "\\Inbox");
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `msg-${i}`;
    insertMessage(db, id, i);
    ids.push(id);
  }
  return { db, ids };
}

const flagState = (db: DatabaseHandle, id: string) =>
  db.prepare("SELECT flags_json, pending_flags_push, pending_flags_base_json FROM messages WHERE id = ?").get(id) as {
    flags_json: string;
    pending_flags_push: number | null;
    pending_flags_base_json: string | null;
  };

const replay = (db: DatabaseHandle): number =>
  replayTaskSettlementObligations({ db, masterKey: MASTER_KEY, now: () => FIXED_NOW });

/** A flags task the way the acceptance commits one, against the real acceptance. */
function acceptFlags(db: DatabaseHandle, messageIds: readonly string[], patch: { seen?: boolean; flagged?: boolean } = { seen: true }): string {
  const started: string[] = [];
  const accepted = acceptFlagsTask(
    { db, masterKey: MASTER_KEY, scheduler: { start: (id) => started.push(id) } },
    { messageIds, patch },
  );
  expect(started).toEqual(accepted.handles.map((handle) => handle.id));
  return accepted.handles[0]!.id;
}

/** A send task with its ledger row and optimistic Sent row, as the acceptance writes them. */
function acceptSend(db: DatabaseHandle): { taskId: string; submissionId: string } {
  insertFolder(db, "Sent", "Sent", "\\Sent");
  const request = { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [] };
  const prepared = prepareSubmission(db, MASTER_KEY, { accountId: ACCOUNT, accountEmail: "demo@example.com", idempotencyKey: "key-1", request });
  const account = accountById(db, ACCOUNT);
  if (!account) throw new Error("Account fixture missing.");
  const placeholderId = writePendingSentRow(db, MASTER_KEY, {
    account,
    submissionId: prepared.submission.id,
    rfcMessageId: prepared.submission.messageId,
    request,
    attachments: [],
  });
  if (!placeholderId) throw new Error("The fixture's account has no Sent mailbox.");
  const taskId = recordTask(db, MASTER_KEY, {
    accountId: ACCOUNT,
    kind: "send",
    total: 1,
    submissionId: prepared.submission.id,
  } satisfies TaskSpec);
  return { taskId, submissionId: prepared.submission.id };
}

const placeholdersFor = (db: DatabaseHandle, submissionId: string): string[] =>
  (db.prepare("SELECT id FROM messages WHERE pending_send = ?").all(submissionId) as Array<{ id: string }>).map((row) => row.id);

let db: DatabaseHandle | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe("task obligation replay", () => {
  it("restores a refused flags target a dead process left behind, and closes its books", () => {
    const world = fixture(1);
    db = world.db;
    const baseline = flagState(db, "msg-1").flags_json;
    const taskId = acceptFlags(db, world.ids);
    // The optimistic target is in place with its baseline and marker; this is
    // the state between acceptance and settlement.
    expect(flagState(db, "msg-1")).toMatchObject({ pending_flags_push: 1 });

    // The process dies between `settleTask` and the hook: the row is terminal,
    // the repairs never ran, and the optimistic target is still readable.
    settleTask(db, taskId, "failed", { message: "process died" }, FIXED_NOW);
    expect(flagState(db, "msg-1")).toMatchObject({ pending_flags_push: 1, pending_flags_base_json: baseline });

    const repaired = replay(db);

    // What the hook would have done, the replay does: the baseline is restored
    // and confirmed, the marker is gone, and the row's books close.
    expect(repaired).toBeGreaterThan(0);
    expect(flagState(db, "msg-1")).toMatchObject({ flags_json: baseline, pending_flags_push: 0, pending_flags_base_json: null });
    expect(taskRow(db, taskId)).toMatchObject({ total: 1, updated: 0, failed: 1 });
  });

  it("must run before the orphan-marker sweep: after it, the sweep finds nothing to undo", () => {
    // The ordering is load-bearing (`app.ts`): `clearOrphanedFlagsMarkers`
    // removes markers no live push holds, which is exactly the marker the flags
    // rollback needs. Run the sweep first and the baseline is unrecoverable;
    // run the replay first and the sweep's remaining work is only ever markers
    // with no task behind them at all.
    const world = fixture(1);
    db = world.db;
    const taskId = acceptFlags(db, world.ids);
    settleTask(db, taskId, "failed", { message: "process died" }, FIXED_NOW);

    replay(db);
    expect(clearOrphanedFlagsMarkers(db)).toBe(0);
  });

  it("retires a failed send's optimistic Sent row a dead process left standing", () => {
    const world = fixture(1);
    db = world.db;
    const { taskId, submissionId } = acceptSend(db);
    expect(placeholdersFor(db, submissionId)).toHaveLength(1);

    settleTask(db, taskId, "failed", { message: "process died" }, FIXED_NOW);
    expect(placeholdersFor(db, submissionId)).toHaveLength(1);

    const repaired = replay(db);

    expect(repaired).toBeGreaterThan(0);
    expect(placeholdersFor(db, submissionId)).toEqual([]);
    expect(taskRow(db, taskId)).toMatchObject({ total: 1, updated: 0, failed: 1 });
  });

  it("is a row of no-ops for rows whose repairs already ran", () => {
    const world = fixture(2);
    db = world.db;
    const baseline = flagState(db, "msg-1").flags_json;
    const taskId = acceptFlags(db, world.ids);

    // The normal path, called the way the scheduler calls it on a give-up:
    // settle, then BOTH hooks (`scheduler.ts` fires the permanent-failure one
    // in addition, and the flags remainder report lives there).
    settleTask(db, taskId, "failed", { message: "provider refused" }, FIXED_NOW);
    const hooks = createTaskHooks({ db, now: () => FIXED_NOW });
    const settled = { ...taskRow(db, taskId)!, status: "failed" as const };
    hooks.onTaskSettled!(settled, openTaskPayload(MASTER_KEY, settled));
    hooks.onTaskPermanentFailure!(settled, openTaskPayload(MASTER_KEY, settled));
    expect(taskRow(db, taskId)).toMatchObject({ total: 2, failed: 2 });

    const afterHook = flagState(db, "msg-1");
    const repaired = replay(db);

    expect(repaired).toBe(0);
    expect(flagState(db, "msg-1")).toEqual(afterHook);
    expect(flagState(db, "msg-1").flags_json).toBe(baseline);
  });

  it("leaves a completed flags task's markers alone when a newer live push holds them", () => {
    // The replay re-runs the marker clear for every terminal row, completed
    // ones included, so it must respect the same protection the hook does: a
    // marker a newer pending push names is not this task's to clear.
    const world = fixture(2);
    db = world.db;
    const first = acceptFlags(db, ["msg-1"]);
    settleTask(db, first, "completed", null, FIXED_NOW);
    createTaskHooks({ db, now: () => FIXED_NOW }).onTaskSettled!(
      { ...taskRow(db, first)!, status: "completed" },
      openTaskPayload(MASTER_KEY, taskRow(db, first)!),
    );

    // A *different* target, so the acceptance is not a no-op: the first push
    // already marked the message seen and settled, so this one stars it.
    const second = acceptFlags(db, ["msg-1"], { flagged: true });
    expect(flagState(db, "msg-1")).toMatchObject({ pending_flags_push: 1 });

    const repaired = replay(db);

    // The newer push's marker survives the older task's replayed clear.
    expect(flagState(db, "msg-1")).toMatchObject({ pending_flags_push: 1 });
    expect(taskRow(db, second)!.status).toBe("pending");
    expect(repaired).toBe(0);
  });
});
