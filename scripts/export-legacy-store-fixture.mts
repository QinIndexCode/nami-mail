/**
 * Exports the frozen "legacy store" snapshot the batch-2 task-layer migration
 * has to read: one real database built by the CURRENT `openDatabase`, with
 * representative rows in all four task stores, dumped as schema SQL + row SQL
 * into `apps/server/tests/fixtures/legacy-store-2026-10/`.
 *
 * Why this exists at all
 * ---------------------
 * Batch 2 absorbs `operation_queue` + `batch_jobs`/`batch_job_messages` +
 * `outbound_submissions` into one `tasks` table and drops the old DDL. Once
 * that DDL is gone, a "legacy database" can only be reconstructed by
 * hand-copying it — and a hand-copied legacy database defeats the entire
 * purpose, because reading it exercises the copy, not the migration. So the
 * snapshot must be produced BEFORE any code change, from the real code.
 *
 * Every row below is written by the production function that writes it in
 * production (`prepareSubmission`, `createBatchJob`, `undoBatchJob`,
 * `applyPreparedFlagsInTransaction`, `moveStatements().beginMoveIntent`,
 * `createOutboundAttachment`, …), never by a hand-built INSERT. The places that
 * are not a single production call are marked `MIRRORS` with the statement they
 * stand in for; each is a state production reaches on its own, reached here by
 * applying the exact statement production applies.
 *
 * The schema is never hand-written either: `schema.sql` is `sqlite_master`
 * verbatim, in creation order, so it is whatever `openDatabase` produced.
 *
 * Usage — run this BEFORE touching `db.ts`:
 *   node node_modules/tsx/dist/cli.mjs scripts/export-legacy-store-fixture.mts
 *
 * DEAD as of the batch-4 "delete the legacy layer" change: this file imports
 * `operation-queue.ts`, `batch-jobs.ts` and `flags-outbox.ts`'s
 * `applyPreparedFlagsInTransaction` at load time, and that batch deleted all
 * three — so Node now fails at module resolution before the past-batch-2 guards
 * below can fire. Run it from a pre-batch-2 revision instead. It is kept only as
 * the provenance record for the frozen snapshot in
 * `apps/server/tests/fixtures/legacy-store-2026-10/` (which row came from which
 * production call, and which lines are `MIRRORS` stand-ins).
 *
 * The generated files are the frozen baseline and this script therefore
 * REFUSES to overwrite them; pass `--force` only if you intend to replace the
 * baseline from the current source, which must still be a pre-batch-2 revision
 * or the "legacy" snapshot becomes a copy of the new schema.
 *
 * Not reproducible byte-for-byte: submission ids, RFC message ids, attachment
 * tokens and every AES-GCM ciphertext are random by construction. Two runs
 * describe the same legacy shape with different ids, which is also how two
 * real users' databases differ. Identify rows by property, never by id.
 *
 * This file touches nothing outside a fresh OS temp directory. It never opens
 * an installed app's data directory or a mailbox.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { openDatabase, type DatabaseHandle } from "../apps/server/src/db.js";
import { createOperationQueue, type OperationQueue } from "../apps/server/src/operation-queue.js";
import { applyPreparedFlagsInTransaction, prepareLocalFlags, type MessageFlagsPatch } from "../apps/server/src/flags-outbox.js";
import { createBatchJob, revertMoveJobFailures, undoBatchJob } from "../apps/server/src/batch-jobs.js";
import { moveStatements } from "../apps/server/src/sync-move-statements.js";
import { ensureMessageFtsIndex } from "../apps/server/src/message-search.js";
import { encryptMessagePayload, MESSAGE_PAYLOAD_VERSION, type MessagePayload } from "../apps/server/src/message-storage.js";
import { createOutboundAttachment, linkOutboundAttachmentsToSubmission } from "../apps/server/src/outbound-attachments.js";
import {
  markSubmissionConfirmed,
  markSubmissionFailed,
  markSubmissionSubmitted,
  markSubmissionUnknownDelivery,
  prepareSubmission,
} from "../apps/server/src/outbox.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "apps", "server", "tests", "fixtures", "legacy-store-2026-10");
const force = process.argv.includes("--force");

/**
 * Fixed master key for the whole snapshot. Not a secret: the fixture is test
 * data, and a fixed key is what makes the encrypted rows readable by the
 * migration test that will load it. 32 bytes because the envelope's HKDF takes
 * the master key directly.
 */
const MASTER_KEY = Buffer.alloc(32, 0x2b);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The fixture's own "now". Every relative offset below is measured from it. */
const base = new Date();

/**
 * How far behind `base` the app's own clock runs while the fixture is built.
 *
 * The app stamps `created_at` on the rows it creates and a settle stamps
 * `completed_at`; production always has the second later than the first, and the
 * undo window needs the settle in the past. Both hold only if `created_at` is
 * itself in the past, which means the build has to run on a clock behind `base`
 * — otherwise a job settled one minute ago would read as created one minute
 * after it completed, a shape no revision produces. The settle offsets in the
 * mirrors below are measured from `base`, so they land strictly inside
 * `(build clock, base)`: after their own creation, and before now.
 */
const BUILD_CLOCK_SKEW_MS = 10 * MINUTE;

/** The instant the app's own code sees as "now" while the fixture is built. */
const fixtureNow = base.getTime() - BUILD_CLOCK_SKEW_MS;

const iso = (offsetMs = 0): string => new Date(fixtureNow + offsetMs).toISOString();

/**
 * Runs `build` with the process clock fixed at `fixtureNow`.
 *
 * The app reads the wall clock through `new Date()`, not `Date.now()`, so a
 * clock the fixture controls has to replace the constructor itself. Fixing it
 * buys two things: every `created_at` the app writes is deterministic, and it is
 * far enough behind `base` that the settle mirrors below land strictly after
 * their own creation while still in the past — the only interval that is both
 * ordered and does not put a completion in the future.
 */
async function withFixedClock<T>(build: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) { super(fixtureNow); return; }
      if (args.length === 1) { super(args[0] as number); return; }
      throw new Error("The fixture's fixed clock supports `new Date()` and the single-argument constructor only.");
    }
    static override now(): number { return fixtureNow; }
  }
  globalThis.Date = FixtureDate as unknown as DateConstructor;
  try {
    return await build();
  } finally {
    globalThis.Date = RealDate;
  }
}

type Statement = {
  run: (...args: unknown[]) => { changes: number };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
  pluck: () => Statement;
};

function statement(db: DatabaseHandle, sql: string): Statement {
  return db.prepare(sql) as unknown as Statement;
}

/** The rowids `sqlite_master` holds right now, so a later query can name only
 * the rows a step just created without depending on ids that step generates. */
function watermarks(db: DatabaseHandle): Record<"queue" | "job", number> {
  return {
    queue: Number((statement(db, "SELECT COALESCE(MAX(rowid), 0) AS rowid FROM operation_queue").get() as { rowid: number }).rowid),
    job: Number((statement(db, "SELECT COALESCE(MAX(rowid), 0) AS rowid FROM batch_jobs").get() as { rowid: number }).rowid),
  };
}

type QueueRow = { id: string; kind: string; status: string; payload_json: string };

function queueRowsCreatedSince(db: DatabaseHandle, rowid: number): QueueRow[] {
  return statement(db, "SELECT id, kind, status, payload_json FROM operation_queue WHERE rowid > ? ORDER BY rowid").all(rowid) as QueueRow[];
}

function countOf(db: DatabaseHandle, sql: string, ...params: unknown[]): number {
  return Number((statement(db, sql).get(...params) as { count: number }).count);
}

// ── accounts, folders, messages ────────────────────────────────────────────

function account(db: DatabaseHandle, id: string, email: string, providerName: string): void {
  const domain = email.split("@")[1];
  statement(db, `
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password, auth_method,
      imap_host, imap_port, imap_secure, imap_transport, imap_username,
      smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
      signature, display_name, username_mode, status, created_at
    ) VALUES (?, ?, 'custom', ?, ?, 'password', ?, 993, 1, 'tls', ?, ?, 465, 1, 'tls', ?, '', ?, 'email', 'connected', ?)
  `).run(
    id, email, providerName, "envelope-placeholder",
    `imap.${domain}`, email, `smtp.${domain}`, email, providerName, iso(),
  );
}

function folder(db: DatabaseHandle, accountId: string, folderPath: string, name: string, specialUse: string, total: number, unseen: number): void {
  statement(db, `
    INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
    VALUES (?, ?, ?, ?, ?, ?, '1')
  `).run(accountId, folderPath, name, specialUse, total, unseen);
}

type MessageSeed = {
  id: string;
  accountId: string;
  mailbox: string;
  uid: number;
  subject: string;
  fromAddress: string;
  fromName: string;
  sentAt: string | null;
  flags: string[];
  /** False mirrors a pre-encryption row: plaintext columns only, no envelope. */
  encrypted: boolean;
  hasAttachments?: boolean;
  snoozedUntil?: string;
  allMailArchived?: number;
  remoteIdLookup?: string;
};

const ATTACHMENT_METADATA = [{
  partId: "2",
  filename: "quarterly-report.pdf",
  contentType: "application/pdf",
  size: 182_400,
  related: false,
  disposition: "attachment" as const,
}];

/**
 * Writes one cached message row with sync's own column list
 * (`sync.ts`'s `INSERT INTO messages (...)`, minus the two VIRTUAL generated
 * columns SQLite computes on read) and a real encryption envelope.
 */
function message(db: DatabaseHandle, seed: MessageSeed): void {
  const payload: MessagePayload = {
    messageId: `<${seed.id}@example.test>`,
    subject: seed.subject,
    fromName: seed.fromName,
    fromAddress: seed.fromAddress,
    to: [{ name: "Nami Fixture", address: `recipient-${seed.uid}@example.test` }],
    cc: null,
    inReplyTo: null,
    references: null,
    snippet: `${seed.subject} — fixture snippet`,
    textBody: `${seed.subject}\n\nFixture body. Nothing here is real mail.`,
    htmlBody: `<p>${seed.subject}</p><p>Fixture body.</p>`,
    attachments: seed.hasAttachments ? ATTACHMENT_METADATA : null,
  };
  statement(db, `
    INSERT INTO messages (
      id, account_id, mailbox, uid, remote_id_lookup, all_mail_archived, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body, html_body, flags_json,
      has_attachments, attachments_json, attachment_kinds_json, payload_metadata_ready, encrypted_payload, payload_version,
      size, snoozed_until, created_at
    ) VALUES (
      @id, @accountId, @mailbox, @uid, @remoteIdLookup, @allMailArchived, @messageId, @subject, @fromName, @fromAddress,
      @toJson, NULL, NULL, NULL, @sentAt, @snippet, @textBody, @htmlBody, @flagsJson,
      @hasAttachments, @attachmentsJson, @attachmentKindsJson, @payloadMetadataReady, @encryptedPayload, @payloadVersion,
      @size, @snoozedUntil, @createdAt
    )
  `).run({
    id: seed.id,
    accountId: seed.accountId,
    mailbox: seed.mailbox,
    uid: seed.uid,
    remoteIdLookup: seed.remoteIdLookup ?? null,
    allMailArchived: seed.allMailArchived ?? null,
    messageId: `<${seed.id}@example.test>`,
    subject: seed.subject,
    fromName: seed.fromName,
    fromAddress: seed.fromAddress,
    toJson: JSON.stringify([{ name: "Nami Fixture", address: `recipient-${seed.uid}@example.test` }]),
    sentAt: seed.sentAt,
    snippet: payload.snippet,
    textBody: payload.textBody,
    htmlBody: payload.htmlBody,
    flagsJson: JSON.stringify(seed.flags),
    hasAttachments: seed.hasAttachments ? 1 : 0,
    attachmentsJson: seed.hasAttachments ? JSON.stringify(ATTACHMENT_METADATA) : null,
    attachmentKindsJson: seed.hasAttachments ? JSON.stringify(["pdf"]) : "[]",
    payloadMetadataReady: seed.encrypted ? 1 : null,
    encryptedPayload: seed.encrypted ? encryptMessagePayload(MASTER_KEY, seed.id, seed.accountId, payload) : null,
    payloadVersion: seed.encrypted ? MESSAGE_PAYLOAD_VERSION : 0,
    size: 4_096,
    snoozedUntil: seed.snoozedUntil ?? null,
    createdAt: seed.sentAt ?? iso(),
  });
}

// ── mirrors ────────────────────────────────────────────────────────────────

/**
 * MIRRORS the terminal half of `snapshotFromDbRow`'s lazy settle
 * (`UPDATE batch_jobs SET status = 'completed', updated = ?, failed = ?,
 * completed_at = ? WHERE id = ? AND status = 'running'`).
 *
 * The status and the timestamp are applied directly for two reasons: that
 * settle's recomputed `updated`/`failed` come out of projection SQL whose
 * inputs (`syncing`, `failed_pushes`) only reach zero with the running app's
 * `onOperationSettled` hook wiring, which a fixture builder does not have; and
 * the fixture needs `completed_at` in the past to exercise the undo window and
 * the 15-minute job prune. The stored `updated`/`failed` are therefore the
 * ACCEPTANCE-TIME numbers production itself inserted — for the flags job that
 * is precisely the deficit this fixture exists to carry.
 */
function completeJob(db: DatabaseHandle, jobId: string, completedAtOffsetMs: number): void {
  statement(db, "UPDATE batch_jobs SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(base.getTime() + completedAtOffsetMs, jobId);
}

/**
 * MIRRORS `operation-queue.ts`'s `markRunning` (`UPDATE operation_queue SET
 * status = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE
 * id = ?`), which runs once an operation holds the account write slot. Applied
 * directly because a genuinely in-flight row would make the fixture's status a
 * race between the builder and the executor.
 */
function claimQueueRow(db: DatabaseHandle, rowId: string): void {
  statement(db, "UPDATE operation_queue SET status = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
    .run(iso(), rowId);
}

/**
 * MIRRORS `operation-queue.ts`'s `markSettled`, in both terminal shapes the
 * queue writes: `completed` for an executor that returned, and `failed` for one
 * that threw (`runRow`'s catch marks it, then `driveWithRetries` gives up after
 * its retries).
 */
function settleQueueRow(db: DatabaseHandle, rowId: string, status: "completed" | "failed", errorMessage: string | null, completedAtOffsetMs = 0): void {
  // An ISO string, not an epoch number: `operation_queue.completed_at` is TEXT
  // and every writer in `operation-queue.ts` binds `new Date().toISOString()`.
  // Binding a number here would store a value no revision ever produces, and it
  // would also change `pruneTerminal`'s comparison below from TEXT-vs-TEXT to
  // the cross-storage-class ordering SQLite falls back on.
  const at = new Date(base.getTime() + completedAtOffsetMs).toISOString();
  statement(db, "UPDATE operation_queue SET status = ?, error_code = NULL, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?")
    .run(status, errorMessage, at, at, rowId);
}

/**
 * MIRRORS `operation-queue.ts`'s private `pruneTerminal` (`DELETE FROM
 * operation_queue WHERE status IN ('completed', 'failed') AND completed_at < ?`,
 * the 24h TTL applied by `resumePending` at startup). Called here because
 * `resumePending` would also re-enqueue and EXECUTE every pending row, which
 * needs a provider and would rewrite the very rows under test.
 *
 * Both halves bind ISO strings, because that is what the column holds and what
 * `pruneTerminal` binds; the `<` then compares TEXT to TEXT, which is the
 * comparison production actually performs.
 */
function pruneTerminalQueueRows(db: DatabaseHandle, rowIds: readonly string[]): void {
  if (!rowIds.length) throw new Error("The prune mirror was handed no rows; the fixture would silently lose boundary 8a.");
  const placeholders = rowIds.map(() => "?").join(", ");
  statement(db, `UPDATE operation_queue SET completed_at = ? WHERE id IN (${placeholders})`)
    .run(new Date(base.getTime() - 25 * HOUR).toISOString(), ...rowIds);
  const deleted = statement(db, "DELETE FROM operation_queue WHERE status IN ('completed', 'failed') AND completed_at < ?")
    .run(new Date(base.getTime() - 24 * HOUR).toISOString());
  if (deleted.changes !== rowIds.length) {
    throw new Error(`The prune mirror deleted ${deleted.changes} row(s) instead of the ${rowIds.length} it backdated.`);
  }
}

/**
 * Drains the background FIFO chains the jobs above join. The runners registered
 * in `buildDatabase` resolve immediately and no retry backoff is ever entered,
 * so the chains settle without a timer; these macrotask turns only give the
 * promise chains room to finish before the next assertion reads them.
 */
async function drainBackground(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A flags commit whose push rows are staged but never started, so the local
 * markers stay pending. `commitLocalFlags` would start them; its two halves are
 * `prepareLocalFlags` + `applyPreparedFlagsInTransaction`, and calling them
 * directly is exactly what leaves the row `pending`. Returns the rows it
 * staged, so a caller can name them without a second query.
 */
function commitFlagsWithoutPushing(db: DatabaseHandle, queue: OperationQueue, messageIds: readonly string[], patch: MessageFlagsPatch): QueueRow[] {
  const before = watermarks(db);
  const { prepared, blocked } = prepareLocalFlags(db, messageIds, patch);
  if (blocked.length) throw new Error(`A fixture flags commit was refused for ${blocked.length} row(s); the selection is wrong.`);
  db.transaction(() => applyPreparedFlagsInTransaction(db, prepared, queue))();
  const rows = queueRowsCreatedSince(db, before.queue);
  if (!rows.length) {
    throw new Error("A fixture flags commit staged no push row: the patch produced no delta on any selected message.");
  }
  return rows;
}

// ── the fixture ────────────────────────────────────────────────────────────

async function buildDatabase(databasePath: string, attachmentDirectory: string): Promise<DatabaseHandle> {
  const db = openDatabase(databasePath);

  // T6's guard. This exporter captures the state of the revision BEFORE batch 2.
  // Once `folders` loses its counter columns or `tasks` replaces
  // `operation_queue`, running it would overwrite a legacy snapshot with a
  // post-refactor database that merely looks like one — and `--force` would let
  // it. Cheap to check, and the failure is the whole point of the file.
  const tableColumns = (table: string): string[] =>
    (statement(db, `PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((column) => column.name);
  for (const column of ["total", "unseen"]) {
    if (!tableColumns("folders").includes(column)) {
      throw new Error(`\`folders.${column}\` is already gone: this revision is past batch 2 and cannot produce the legacy snapshot.`);
    }
  }
  if (!tableColumns("operation_queue").length) {
    throw new Error("`operation_queue` is already gone: this revision is past batch 2 and cannot produce the legacy snapshot.");
  }
  const tasksTable = (statement(db, "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as { count: number }).count;
  if (Number(tasksTable) !== 0) {
    throw new Error("`tasks` already exists: this revision is past batch 2 and cannot produce the legacy snapshot.");
  }

  const queue = createOperationQueue(db);
  // The jobs and flags commits below JOIN their staged rows to the background
  // FIFO chains the moment they commit. With no executor registered, `runRow`
  // settles each row `failed`/"no_runner" and `driveWithRetries` then burns its
  // eight-attempt backoff (~90s of live timers); with these two no-ops the rows
  // settle `completed` at once, which is the state a real push or move leaves
  // behind. This is the only thing the fixture substitutes for the app.
  queue.registerRunner("batch-move", async () => undefined);
  queue.registerRunner("flags-push", async () => undefined);

  // ── accounts and folders ────────────────────────────────────────────────
  account(db, "acc-alpha", "alpha@example.test", "Alpha Mail");
  account(db, "acc-beta", "beta@example.test", "Beta Mail");
  // The doomed account: removed near the end, which cascades its messages and
  // its `operation_queue` rows away while leaving its batch job behind
  // (boundary 8b).
  account(db, "acc-gamma", "gamma@example.test", "Gamma Mail");
  for (const [accountId, total, unseen] of [["acc-alpha", 12, 4], ["acc-beta", 5, 1], ["acc-gamma", 2, 0]] as const) {
    folder(db, accountId, "INBOX", "Inbox", "\\Inbox", total, unseen);
    folder(db, accountId, "Sent", "Sent", "\\Sent", 3, 0);
    folder(db, accountId, "Drafts", "Drafts", "\\Drafts", 0, 0);
    folder(db, accountId, "Archive", "Archive", "\\Archive", 2, 0);
    folder(db, accountId, "Trash", "Trash", "\\Trash", 1, 0);
    folder(db, accountId, "Junk", "Junk", "\\Junk", 0, 0);
  }
  // These counts are deliberately not the number of messages seeded below, and
  // the build's own flags and move commits nudge them further as they run. The
  // impossible `unseen > total` pair is applied at the very end of the build,
  // after the last writer, and asserted there — see "the counter drift".

  // ── messages ────────────────────────────────────────────────────────────
  const seeds: MessageSeed[] = [
    { id: "fx-alpha-inbox-1", accountId: "acc-alpha", mailbox: "INBOX", uid: 101, subject: "Fixture one", fromAddress: "one@example.test", fromName: "One", sentAt: iso(-72 * HOUR), flags: ["\\Seen"], encrypted: true },
    { id: "fx-alpha-inbox-2", accountId: "acc-alpha", mailbox: "INBOX", uid: 102, subject: "Fixture two", fromAddress: "two@example.test", fromName: "Two", sentAt: iso(-70 * HOUR), flags: ["\\Flagged"], encrypted: true },
    // The stale 'intent' row: a MOVE whose response was lost. Boundary 7a.
    { id: "fx-alpha-inbox-3", accountId: "acc-alpha", mailbox: "INBOX", uid: 103, subject: "Fixture three", fromAddress: "three@example.test", fromName: "Three", sentAt: iso(-68 * HOUR), flags: ["\\Seen"], encrypted: true },
    // A pre-encryption row: plaintext columns only, no envelope, no metadata
    // flag. `message-storage.ts`'s `legacyPayload` is its reader.
    { id: "fx-alpha-inbox-4", accountId: "acc-alpha", mailbox: "INBOX", uid: 104, subject: "Fixture legacy", fromAddress: "legacy@example.test", fromName: "Legacy", sentAt: iso(-66 * HOUR), flags: ["\\Seen"], encrypted: false },
    { id: "fx-alpha-inbox-5", accountId: "acc-alpha", mailbox: "INBOX", uid: 105, subject: "Fixture with attachment", fromAddress: "files@example.test", fromName: "Files", sentAt: iso(-64 * HOUR), flags: ["\\Seen"], encrypted: true, hasAttachments: true },
    { id: "fx-alpha-inbox-6", accountId: "acc-alpha", mailbox: "INBOX", uid: 106, subject: "Fixture snoozed", fromAddress: "snooze@example.test", fromName: "Snooze", sentAt: iso(-62 * HOUR), flags: ["\\Seen"], encrypted: true, snoozedUntil: iso(HOUR) },
    { id: "fx-alpha-inbox-7", accountId: "acc-alpha", mailbox: "INBOX", uid: 107, subject: "Fixture seven", fromAddress: "seven@example.test", fromName: "Seven", sentAt: iso(-60 * HOUR), flags: ["\\Seen"], encrypted: true },
    { id: "fx-alpha-inbox-8", accountId: "acc-alpha", mailbox: "INBOX", uid: 108, subject: "Fixture eight", fromAddress: "eight@example.test", fromName: "Eight", sentAt: iso(-58 * HOUR), flags: [], encrypted: true },
    { id: "fx-alpha-sent-1", accountId: "acc-alpha", mailbox: "Sent", uid: 201, subject: "Fixture sent", fromAddress: "alpha@example.test", fromName: "Alpha", sentAt: iso(-50 * HOUR), flags: ["\\Seen"], encrypted: true, allMailArchived: 1, remoteIdLookup: "lookup-alpha-sent-1" },
    // Already in the archive target, so a move job's no-op branch is represented.
    { id: "fx-alpha-archive-1", accountId: "acc-alpha", mailbox: "Archive", uid: 301, subject: "Fixture archived", fromAddress: "arch@example.test", fromName: "Arch", sentAt: iso(-48 * HOUR), flags: ["\\Seen"], encrypted: true, allMailArchived: 1, remoteIdLookup: "lookup-alpha-archive-1" },
    { id: "fx-alpha-trash-1", accountId: "acc-alpha", mailbox: "Trash", uid: 401, subject: "Fixture trashed", fromAddress: "trash@example.test", fromName: "Trash", sentAt: iso(-46 * HOUR), flags: ["\\Seen"], encrypted: true },
    { id: "fx-beta-inbox-1", accountId: "acc-beta", mailbox: "INBOX", uid: 101, subject: "Beta fixture one", fromAddress: "b1@example.test", fromName: "B1", sentAt: iso(-40 * HOUR), flags: ["\\Seen"], encrypted: true },
    { id: "fx-beta-inbox-2", accountId: "acc-beta", mailbox: "INBOX", uid: 102, subject: "Beta fixture two", fromAddress: "b2@example.test", fromName: "B2", sentAt: iso(-38 * HOUR), flags: [], encrypted: true },
    { id: "fx-gamma-inbox-1", accountId: "acc-gamma", mailbox: "INBOX", uid: 101, subject: "Gamma fixture one", fromAddress: "g1@example.test", fromName: "G1", sentAt: iso(-30 * HOUR), flags: ["\\Seen"], encrypted: true },
    { id: "fx-gamma-inbox-2", accountId: "acc-gamma", mailbox: "INBOX", uid: 102, subject: "Gamma fixture two", fromAddress: "g2@example.test", fromName: "G2", sentAt: iso(-28 * HOUR), flags: ["\\Seen"], encrypted: true },
  ];
  for (const seed of seeds) message(db, seed);

  // Boundary 7b: a local flags change that was never pushed. `commitLocalFlags`
  // minus its starters, so the `flags-push` row stays `pending` and the marker
  // stays set — the pending branch of `CONFIRMED_FLAGS_SQL`.
  const unpushedRows = commitFlagsWithoutPushing(db, queue, ["fx-alpha-inbox-2"], { flagged: false });
  if (unpushedRows.length !== 1 || unpushedRows[0].status !== "pending") {
    throw new Error("The fixture's unpushed flags change did not leave exactly one pending push row.");
  }
  const unpushedPushRowId = unpushedRows[0].id;
  const marked = statement(db, "SELECT pending_flags_push, pending_flags_base_json, flags_json FROM messages WHERE id = 'fx-alpha-inbox-2'").get() as {
    pending_flags_push: number;
    pending_flags_base_json: string;
    flags_json: string;
  };
  if (marked.pending_flags_push !== 1 || marked.pending_flags_base_json === marked.flags_json) {
    throw new Error("The fixture's unpushed flags change left no usable pending baseline.");
  }

  // Boundary 7a: the stale move intent, written by the statement that claims
  // one. `pending_move_state='intent'` keeps the row in its SOURCE folder under
  // the generated `effective_mailbox`, which is what makes it a row the flags
  // path must refuse.
  statement(db, "UPDATE messages SET remote_id_lookup = 'lookup-alpha-inbox-3' WHERE id = 'fx-alpha-inbox-3'").run();
  moveStatements(db).beginMoveIntent.run("Archive", 9001, "\\Archive", "fx-alpha-inbox-3");
  const intent = statement(db, "SELECT pending_move_state, pending_move_destination, effective_mailbox FROM messages WHERE id = 'fx-alpha-inbox-3'").get() as {
    pending_move_state: string;
    pending_move_destination: string;
    effective_mailbox: string;
  };
  if (intent.pending_move_state !== "intent" || intent.pending_move_destination !== "Archive" || intent.effective_mailbox !== "INBOX") {
    throw new Error("The fixture's stale move intent is not readable as an intent that still sits in its source folder.");
  }

  // ── outbound submissions ────────────────────────────────────────────────
  // Boundary 4: the only legacy ledger row that produces a new `tasks` row.
  const scheduled = prepareSubmission(db, MASTER_KEY, {
    accountId: "acc-alpha",
    accountEmail: "alpha@example.test",
    idempotencyKey: "fixture-scheduled-send",
    request: { to: ["later@example.test"], subject: "Fixture scheduled", text: "Scheduled fixture body.", attachmentTokens: [] },
    sendAt: iso(2 * HOUR),
  });
  const scheduledRow = statement(db, "SELECT status, send_at FROM outbound_submissions WHERE id = ?").get(scheduled.submission.id) as {
    status: string;
    send_at: string;
  };
  if (scheduledRow.status !== "pending" || !scheduledRow.send_at) {
    throw new Error("The fixture's scheduled submission is not a pending send with a due time.");
  }
  prepareSubmission(db, MASTER_KEY, {
    accountId: "acc-alpha",
    accountEmail: "alpha@example.test",
    idempotencyKey: "fixture-pending-send",
    request: { to: ["now@example.test"], subject: "Fixture pending", text: "Pending fixture body.", attachmentTokens: [] },
  });
  // Boundary 5: an unresolved delivery outcome. It must survive the migration
  // readable, and must NOT be turned into retryable work.
  const unknown = prepareSubmission(db, MASTER_KEY, {
    accountId: "acc-alpha",
    accountEmail: "alpha@example.test",
    idempotencyKey: "fixture-unknown-delivery",
    request: { to: ["lost@example.test"], subject: "Fixture unknown delivery", text: "Unknown-delivery fixture body.", attachmentTokens: [] },
  });
  markSubmissionUnknownDelivery(db, MASTER_KEY, unknown.submission.id, "smtp_timeout", "SMTP DATA timed out; delivery unknown.");
  const failed = prepareSubmission(db, MASTER_KEY, {
    accountId: "acc-alpha",
    accountEmail: "alpha@example.test",
    idempotencyKey: "fixture-failed-send",
    request: { to: ["bounce@example.test"], subject: "Fixture failed", text: "Failed fixture body.", attachmentTokens: [] },
  });
  markSubmissionFailed(db, MASTER_KEY, failed.submission.id, "smtp_rejected", "550 mailbox unavailable");
  const confirmed = prepareSubmission(db, MASTER_KEY, {
    accountId: "acc-alpha",
    accountEmail: "alpha@example.test",
    idempotencyKey: "fixture-confirmed-send",
    request: { to: ["delivered@example.test"], subject: "Fixture confirmed", text: "Confirmed fixture body.", attachmentTokens: [] },
  });
  markSubmissionSubmitted(db, MASTER_KEY, confirmed.submission.id, "provider-msg-fixture");
  markSubmissionConfirmed(db, MASTER_KEY, confirmed.submission.id);

  // Boundary 6: a submission with an attachment, linked inside its own create
  // transaction the way the scheduled-send route does it, so the ledger row and
  // the `outbound_attachment_submissions` foreign key are both real.
  const attachment = createOutboundAttachment(db, attachmentDirectory, MASTER_KEY, {
    accountId: "acc-beta",
    filename: "quarterly-report.pdf",
    contentType: "application/pdf",
    content: Buffer.from("%PDF-1.4 fixture attachment, not a real document\n"),
  });
  const withAttachment = prepareSubmission(db, MASTER_KEY, {
    accountId: "acc-beta",
    accountEmail: "beta@example.test",
    idempotencyKey: "fixture-attached-send",
    request: { to: ["attach@example.test"], subject: "Fixture attached", text: "Attached fixture body.", attachmentTokens: [attachment.token] },
    linkAttachmentsInCreate: (submissionId) => linkOutboundAttachmentsToSubmission(db, "acc-beta", submissionId, [attachment.token]),
  });
  if (countOf(db, "SELECT COUNT(*) AS count FROM outbound_attachment_submissions WHERE submission_id = ?", withAttachment.submission.id) !== 1) {
    throw new Error("The fixture's submission attachment was not linked.");
  }

  // ── batch jobs ──────────────────────────────────────────────────────────
  const deps = { db, masterKey: MASTER_KEY, operationQueue: queue };

  // jobA — a flags job on one account's inbox. Its own push row is settled
  // `failed` below, so the status vocabulary is not all happy path.
  //
  // It is also boundary 3. `acceptFlagsJob` stores `total = ids.length`,
  // `updated = changedIds.length` (rows whose delta was non-empty) and
  // `failed = ids.length - prepared.length` (rows `prepareLocalFlags` refused
  // because they carry a pending move, PLUS rows that do not exist at all). A
  // selection row the patch was already satisfied on is in NONE of them, so
  // `updated + failed !== total` by construction — and
  // `batch_job_messages.changed = 1` marks only the first group, so `changed =
  // 0` is not a synonym for failed. A migration that reads `updated + failed`
  // as `total`, or `changed = 0` as failed, breaks here.
  //
  // The expectation is DERIVED from the selection's pre-state rather than
  // hardcoded, so it stays true if a seed's flags change, and comparing `total`
  // against it pins the selection predicate too: a query that stopped returning
  // all of alpha's inbox fails here instead of quietly shrinking the fixture.
  const alphaInboxBefore = statement(db, `
    SELECT id, flags_json, pending_move_destination, pending_move_state
    FROM messages WHERE account_id = 'acc-alpha' AND effective_mailbox = 'INBOX'
  `).all() as Array<{ id: string; flags_json: string; pending_move_destination: string | null; pending_move_state: string | null }>;
  let expectedRefused = 0;
  let expectedChanged = 0;
  let expectedAlreadyAtTarget = 0;
  for (const row of alphaInboxBefore) {
    if (row.pending_move_destination !== null || row.pending_move_state !== null) {
      expectedRefused += 1;
    } else if ((JSON.parse(row.flags_json) as string[]).includes("\\Seen")) {
      expectedAlreadyAtTarget += 1;
    } else {
      expectedChanged += 1;
    }
  }
  if (!expectedRefused || !expectedChanged || !expectedAlreadyAtTarget) {
    throw new Error("The fixture's flags job no longer has all three groups (refused, changed, already at target); boundary 3 would collapse.");
  }

  const beforeA = watermarks(db);
  const jobA = createBatchJob({ kind: "flags", patch: { seen: true }, query: { accountId: "acc-alpha", folder: "INBOX" } }, deps);
  await drainBackground();
  const jobAQueue = queueRowsCreatedSince(db, beforeA.queue);
  // One minute ago: inside the undo window and inside the 15-minute job TTL
  // `createBatchJob` sweeps on, both of which jobA's later readers depend on.
  completeJob(db, jobA.id, -MINUTE);
  const jobAStored = statement(db, "SELECT status, total, updated, failed FROM batch_jobs WHERE id = ?").get(jobA.id) as {
    status: string;
    total: number;
    updated: number;
    failed: number;
  };
  if (jobAStored.status !== "completed") {
    throw new Error(`The fixture's flags job is stored ${jobAStored.status}, not completed.`);
  }
  const jobADeficit = jobAStored.total - (jobAStored.updated + jobAStored.failed);
  if (
    jobAStored.total !== alphaInboxBefore.length
    || jobAStored.failed !== expectedRefused
    || jobAStored.updated !== expectedChanged
    || jobADeficit !== expectedAlreadyAtTarget
  ) {
    throw new Error(
      `The fixture's flags job no longer matches the selection it was accepted on: got ${JSON.stringify({ ...jobAStored, deficit: jobADeficit })}, `
      + `expected ${JSON.stringify({ total: alphaInboxBefore.length, failed: expectedRefused, updated: expectedChanged, deficit: expectedAlreadyAtTarget })}.`,
    );
  }
  const pushRowsA = jobAQueue.filter((row) => row.kind === "flags-push");
  if (pushRowsA.length !== 1) throw new Error(`The fixture's flags job staged ${pushRowsA.length} push rows, expected 1.`);
  // The row a failed executor leaves: `runRow`'s catch marks it, and the retry
  // loop then gives up for good. Applied directly so the fixture does not spend
  // the retry backoff and so the failure is not a race with the executor.
  settleQueueRow(db, pushRowsA[0].id, "failed", "IMAP refused the flag push.");

  // Boundary 2: the undo job, with `parent_id` pointing at the job it reverses.
  // Inside jobA's 5-minute undo window, so it is the real undo path.
  const jobC = undoBatchJob(jobA.id, deps);
  if (!jobC.ok || !jobC.jobId) throw new Error(`The fixture's undo job was refused: ${jobC.reason}`);
  await drainBackground();
  if ((statement(db, "SELECT undone FROM batch_jobs WHERE id = ?").get(jobA.id) as { undone: number }).undone !== 1) {
    throw new Error("The fixture's undo did not mark its parent undone.");
  }
  // Boundary 9: the undo job is left exactly as a crash between its commit and
  // the next observation leaves it — stored `running` with a NULL
  // `completed_at`, even though every queue row it staged is already terminal.
  // Production settles it lazily on the next read (`snapshotFromDbRow`), so
  // this is a transient state that a crash makes durable. A migration that
  // maps it to a pending task with nothing left to run would hang there.
  const jobCStored = statement(db, "SELECT status, completed_at FROM batch_jobs WHERE id = ?").get(jobC.jobId) as {
    status: string;
    completed_at: number | null;
  };
  if (jobCStored.status !== "running" || jobCStored.completed_at !== null) {
    throw new Error(`The fixture's undo job is not stored as the unobserved-completion shape: ${JSON.stringify(jobCStored)}`);
  }
  if (countOf(db, "SELECT COUNT(*) AS count FROM operation_queue WHERE status IN ('pending', 'running')") !== 1) {
    throw new Error("The fixture's undo job has live queue rows; boundary 9's point is that it does not.");
  }
  // The undo's push rows are the prune control: terminal, and inside the 24h
  // TTL, so they must survive the prune mirror below. That is what proves the
  // prune removed jobE's rows by its predicate and not by deleting rows.
  const controlRow = queueRowsCreatedSince(db, beforeA.queue).find((row) => row.kind === "flags-push" && row.status === "completed");
  if (!controlRow) throw new Error("The fixture has no completed push row to keep as the prune control.");

  // jobB — a MOVE job over the unified inbox, so its selection spans three
  // accounts and it stages one `batch-move` row per account: boundary 1's
  // neighbour, and the cross-account attribution case.
  const jobB = createBatchJob({ kind: "move", target: "archive", query: {} }, deps);
  await drainBackground();
  const jobBAccounts = new Set(
    (statement(db, `
      SELECT DISTINCT m.account_id AS account_id FROM batch_job_messages b
      JOIN messages m ON m.id = b.message_id WHERE b.job_id = ?
    `).all(jobB.id) as Array<{ account_id: string }>).map((row) => row.account_id),
  );
  if (jobBAccounts.size !== 3) {
    throw new Error(`The fixture's cross-account move job reached ${jobBAccounts.size} account(s), expected exactly 3 — alpha, beta, and the gamma it loses below.`);
  }
  completeJob(db, jobB.id, -5 * MINUTE);


  // jobD — boundary 8b: a job whose every selection row is unresolvable, so its
  // owning account cannot be determined. What the shape keys on is
  // resolvability, not cause: any path that deletes the referenced messages
  // produces it (`sync.ts` deleteRemoteDeletionCandidate / deleteFolderMessages,
  // drafting in `drafts.ts`). Removing an account is the road used here because
  // it ALSO takes the `operation_queue` rows — that table is the only one of the
  // three with a foreign key to `accounts` — so the job loses both pieces of
  // evidence at once instead of only one.
  // It is deliberately the reverse of "the selection rows were pruned":
  // `pruneDurableJobs` deletes `batch_job_messages` and `batch_jobs` under the
  // same predicate in the same call, so a surviving job with pruned selections
  // is unreachable.
  message(db, { id: "fx-gamma-inbox-3", accountId: "acc-gamma", mailbox: "INBOX", uid: 103, subject: "Gamma fixture three", fromAddress: "g3@example.test", fromName: "G3", sentAt: iso(-26 * HOUR), flags: ["\\Seen"], encrypted: true });
  const jobD = createBatchJob({ kind: "move", target: "archive", query: { accountId: "acc-gamma", folder: "INBOX" } }, deps);
  await drainBackground();
  completeJob(db, jobD.id, -5 * MINUTE);
  if (countOf(db, "SELECT COUNT(*) AS count FROM batch_job_messages WHERE job_id = ?", jobD.id) !== 1) {
    throw new Error("The fixture's doomed job does not have exactly the one selection row it needs.");
  }
  // `account-store.ts`'s own removal statement.
  statement(db, "DELETE FROM accounts WHERE id = ?").run("acc-gamma");

  // The removal costs jobB two of its eleven rows: they stay in the selection
  // with `changed=1`, and they are why that job is only *partly* attributable
  // (jobD below is the job that is entirely so). Both halves are asserted
  // because the README says "three accounts, one since removed, 2 rows
  // unresolvable" and nothing else in the build would notice the number
  // drifting.
  const unresolvableB = countOf(db, `
    SELECT COUNT(*) AS count FROM batch_job_messages b
    WHERE b.job_id = ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = b.message_id)
  `, jobB.id);
  if (unresolvableB !== 2) {
    throw new Error(`Removing gamma left ${unresolvableB} of the cross-account move job's rows unresolvable, expected 2.`);
  }

  // jobE — boundary 8a: the selection and its messages are intact, but the
  // `operation_queue` rows that named the job are gone. Attribution here has to
  // fall back to the selection rows' messages.
  message(db, { id: "fx-beta-inbox-3", accountId: "acc-beta", mailbox: "INBOX", uid: 103, subject: "Beta fixture three", fromAddress: "b3@example.test", fromName: "B3", sentAt: iso(-20 * HOUR), flags: ["\\Seen"], encrypted: true });
  message(db, { id: "fx-beta-inbox-4", accountId: "acc-beta", mailbox: "INBOX", uid: 104, subject: "Beta fixture four", fromAddress: "b4@example.test", fromName: "B4", sentAt: iso(-18 * HOUR), flags: [], encrypted: true });
  const beforeE = watermarks(db);
  const jobE = createBatchJob({ kind: "move", target: "archive", query: { accountId: "acc-beta", folder: "INBOX" } }, deps);
  await drainBackground();
  completeJob(db, jobE.id, -5 * MINUTE);
  const jobEMoveRows = queueRowsCreatedSince(db, beforeE.queue)
    .filter((row) => row.kind === "batch-move" && row.payload_json.includes(jobE.id));
  if (jobEMoveRows.length !== 1) throw new Error(`The fixture's pruned job staged ${jobEMoveRows.length} movable rows, expected 1.`);
  pruneTerminalQueueRows(db, jobEMoveRows.map((row) => row.id));

  // The fourth selection group: ids the move tried and permanently gave up on.
  // This is the executor's own path, not a mirror — `runMoveJobRow` hands the
  // non-retryable refusals to `revertMoveJobFailures` — so the goals it clears
  // and the departures it gives back are the ones production clears. Two ids,
  // deliberately: `batch_jobs.failed` is the ACCEPTANCE bucket and stays 1, so
  // the snapshot shows two same-named quantities that are different things.
  //
  // Placed after the jobs that resolve their own selections from the unified
  // inbox: it clears move goals, and a job accepted before it would see a
  // different selection depending on which ids it happened to pick. The JOIN
  // keeps the candidates to rows whose message still exists, because the same
  // function takes a different branch for one whose message the gamma cascade
  // removed — a latch with no goal to clear, which this snapshot does not need
  // a second copy of.
  const giveUpIds = (statement(db, `
    SELECT b.message_id FROM batch_job_messages b
    JOIN messages m ON m.id = b.message_id
    WHERE b.job_id = ? AND b.changed = 1 AND b.failed = 0
    ORDER BY b.rowid LIMIT 2
  `).all(jobB.id) as Array<{ message_id: string }>).map((row) => row.message_id);
  if (giveUpIds.length !== 2) throw new Error(`The fixture's move job has ${giveUpIds.length} give-up candidates, expected 2.`);
  const reverted = revertMoveJobFailures(db, jobB.id, giveUpIds);
  const gaveUp = statement(db, `
    SELECT COUNT(*) AS count FROM batch_job_messages b
    JOIN messages m ON m.id = b.message_id
    WHERE b.job_id = ? AND b.failed = 1 AND m.pending_move_destination IS NULL
  `).get(jobB.id) as { count: number };
  const jobBFailed = (statement(db, "SELECT failed FROM batch_jobs WHERE id = ?").get(jobB.id) as { failed: number }).failed;
  if (Number(gaveUp.count) !== 2 || jobBFailed === Number(gaveUp.count)) {
    throw new Error(`The fixture no longer separates the give-up latch from the acceptance bucket: selections=${gaveUp.count}, job.failed=${jobBFailed}, reverted=${reverted}`);
  }

  // Boundary 1: one `running` row, claimed by the statement a claim goes
  // through (`markRunning`), and never settled — the row a crash between the
  // claim and the executor's return leaves behind.
  //
  // Its history is a real unpushed flags commit on alpha's Sent row: a message
  // no job above selects, so the row survives every acceptance to reach the
  // dump, and `prepareLocalFlags` refusing a row that carries a move goal is
  // itself the assertion that no job claimed it. Claiming from `pending` (never
  // from a settled row) is what keeps the shape one production reaches:
  // `resumePending` re-enqueues exactly this on the next start.
  const claimSource = commitFlagsWithoutPushing(db, queue, ["fx-alpha-sent-1"], { flagged: true });
  if (claimSource.length !== 1 || claimSource[0].status !== "pending") {
    throw new Error(`The fixture's claim source is not one pending push row: ${JSON.stringify(claimSource.map((row) => row.status))}`);
  }
  claimQueueRow(db, claimSource[0].id);
  const claimedRow = statement(db, "SELECT status, completed_at, attempt_count FROM operation_queue WHERE id = ?")
    .get(claimSource[0].id) as { status: string; completed_at: string | null; attempt_count: number };
  if (claimedRow.status !== "running" || claimedRow.completed_at !== null || claimedRow.attempt_count !== 1) {
    throw new Error(`The fixture's claimed row is not a first-attempt running row: ${JSON.stringify(claimedRow)}`);
  }

  // The prune control: terminal, and inside the TTL, so it survives.
  settleQueueRow(db, controlRow.id, "completed", null, -MINUTE);

  // The FTS index last: every message row above must be indexed. `indexMessageFts`
  // reads a row through `messagePayloadForRow`, so the legacy pre-encryption row
  // is indexed through its legacy reader — as production would.
  ensureMessageFtsIndex(db, MASTER_KEY);

  // ── what the fixture must contain, asserted before it is dumped ──────────
  const unfinished = statement(db, "SELECT id, kind, status FROM operation_queue WHERE status IN ('pending', 'running') ORDER BY rowid")
    .all() as Array<{ id: string; kind: string; status: string }>;
  if (unfinished.length !== 2) {
    throw new Error(`Expected exactly two unfinished rows (the unpushed push and the claimed one), got ${unfinished.length}.`);
  }
  const pendingRow = unfinished.find((row) => row.status === "pending");
  const runningRow = unfinished.find((row) => row.status === "running");
  if (!pendingRow || pendingRow.id !== unpushedPushRowId || pendingRow.kind !== "flags-push") {
    throw new Error(`The unfinished pending row is not the unpushed push: ${JSON.stringify(pendingRow)}`);
  }
  if (!runningRow || runningRow.id !== claimSource[0].id || runningRow.kind !== "flags-push") {
    throw new Error(`The unfinished running row is not the claimed push: ${JSON.stringify(runningRow)}`);
  }
  if (countOf(db, "SELECT COUNT(*) AS count FROM operation_queue WHERE kind = 'flags-push' AND status = 'failed'") !== 1) {
    throw new Error("The fixture lost its failed push row.");
  }
  // Every move row is terminal: the claim above took a push row, so the queue
  // holds no in-flight move. A `batch-move` row that is not `completed` would
  // mean the fixture's move jobs never ran to the state boundary 8a needs.
  if (countOf(db, "SELECT COUNT(*) AS count FROM operation_queue WHERE kind = 'batch-move' AND status != 'completed'") !== 0) {
    throw new Error("The fixture holds a move row that is not completed.");
  }
  // Deliberate drift, applied AFTER the last writer rather than at the folder
  // seed. T5 established the ±1 counters can reach `unseen > total` (a clamped
  // DECREASE plus an unclamped INCREASE). Seeding that at the folder loop does
  // not survive: the fixture's own flags and move commits nudge these columns
  // as they run, and by the end of the build beta/INBOX's `total` had been
  // nudged from the seeded 0 back up to 2, washing the impossible pair out.
  // Applying it here is what makes the shape present instead of merely likely.
  statement(db, "UPDATE folders SET total = 0, unseen = 1 WHERE account_id = 'acc-beta' AND path = 'INBOX'").run();
  const seededPair = statement(db, "SELECT total, unseen FROM folders WHERE account_id = 'acc-beta' AND path = 'INBOX'").get() as { total: number; unseen: number };
  if (seededPair.total !== 0 || seededPair.unseen !== 1 || countOf(db, "SELECT COUNT(*) AS count FROM folders WHERE unseen > total") !== 1) {
    throw new Error("The snapshot must carry exactly one `unseen > total` folder (beta/INBOX at 1 > 0) — a pair no derivation can produce.");
  }
  // The counter drift batch 3 has to survive, asserted per folder against the
  // messages that folder actually holds. Without this check a later seed edit
  // could wash the drift out and leave the snapshot looking consistent.
  const driftedFolders = (statement(db, `
    SELECT f.account_id AS account_id, f.path AS path, f.total AS total,
           (SELECT COUNT(*) FROM messages m WHERE m.account_id = f.account_id AND m.effective_mailbox = f.path) AS actual
    FROM folders f ORDER BY f.account_id, f.path
  `).all() as Array<{ account_id: string; path: string; total: number; actual: number }>)
    .filter((row) => row.total !== row.actual);
  if (!driftedFolders.length) {
    throw new Error("Every folder counter agrees with the messages it holds; the snapshot has lost the drift batch 3 must be validated against.");
  }
  const driftReport = driftedFolders.map((row) => `${row.account_id}/${row.path} stored=${row.total} holds=${row.actual}`).join("; ");
  console.log(`folder-counter drift carried: ${driftedFolders.length} folder(s) — ${driftReport}`);
  // Every settle must sit after its own creation. Production writes
  // `completed_at` from `markSettled`/the job settle, both later than the row
  // was staged — equal is reachable (a settle in the same millisecond), before
  // is not, and it is exactly what a fixed `base` produced here before the
  // build clock was skewed behind it.
  for (const table of ["batch_jobs", "operation_queue"] as const) {
    const reversed = countOf(db, `SELECT COUNT(*) AS count FROM ${table} WHERE completed_at IS NOT NULL AND completed_at < created_at`);
    if (reversed !== 0) {
      throw new Error(`${reversed} row(s) in ${table} are settled before they were created; the fixture's clock is wrong.`);
    }
  }
  const orphanedJob = statement(db, `
    SELECT bj.id FROM batch_jobs bj
    WHERE bj.id = ?
      AND NOT EXISTS (
        SELECT 1 FROM batch_job_messages b
        JOIN messages m ON m.id = b.message_id
        WHERE b.job_id = bj.id
      )
  `).get(jobD.id);
  if (!orphanedJob) throw new Error("The fixture's doomed job still resolves to a message; the account cascade did not orphan it.");
  if (countOf(db, "SELECT COUNT(*) AS count FROM batch_jobs") !== 5) {
    throw new Error("The fixture does not hold the five jobs it means to (flags, undo, cross-account move, doomed, pruned).");
  }
  if (countOf(db, "SELECT COUNT(*) AS count FROM outbound_submissions") !== 6) {
    throw new Error("The fixture does not hold the six submissions it means to.");
  }

  return db;
}

// ── dumping ────────────────────────────────────────────────────────────────

/** FTS5 keeps its index in shadow tables (`messages_fts_data`, `_idx`, …);
 * they are written by the virtual table, never by hand — and SQLite refuses to
 * `CREATE` them at all ("object name reserved for internal use"), so dumping
 * them into `schema.sql` makes the file unloadable. Excluded from both the
 * schema dump and the row dump; `messages_fts` itself carries the index. */
function isFtsShadowTable(name: string): boolean {
  return /^messages_fts_/.test(name);
}

/** Everything the dumper owns: user tables, not SQLite's own bookkeeping and
 * not FTS5's shadow tables. */
function isDumpableTable(name: string): boolean {
  return !/^sqlite_/i.test(name) && !isFtsShadowTable(name);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Every table a row can be written to, ordered parents-first.
 *
 * Discovered from `sqlite_master` rather than listed, so a future table cannot
 * be silently omitted from the fixture; the order comes from each table's own
 * foreign keys, so `rows.sql` also loads with foreign keys ON. A table nobody
 * inserted into simply dumps nothing.
 */
function dumpOrder(db: DatabaseHandle): string[] {
  const names = (statement(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => isDumpableTable(name));
  const known = new Set(names);
  const parents = new Map<string, string[]>();
  for (const name of names) {
    const foreignKeys = statement(db, `PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as Array<{ table: string }>;
    parents.set(name, [...new Set(foreignKeys.map((fk) => fk.table))].filter((parent) => parent !== name && known.has(parent)));
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (placed.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const parent of parents.get(name) ?? []) visit(parent);
    visiting.delete(name);
    placed.add(name);
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return ordered;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error(`Unsupported column value of type ${typeof value} in the fixture dumper.`);
}

/**
 * Insertable columns. `hidden = 0` is the only kind that can appear in an
 * INSERT: 2 and 3 are VIRTUAL and STORED generated columns, and 1 is a virtual
 * table's own hidden column — which for fts5 means `messages_fts` (the table
 * aux value) and `rank`, neither of which SQLite will accept in a column list.
 */
function insertableColumns(db: DatabaseHandle, table: string): string[] {
  const columns = statement(db, `PRAGMA table_xinfo(${quoteIdentifier(table)})`).all() as Array<{ name: string; hidden: number }>;
  return columns.filter((column) => column.hidden === 0).map((column) => column.name);
}

function dumpSchema(db: DatabaseHandle): string {
  const rows = statement(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }>;
  return [
    "-- Verbatim `sqlite_master` of a database created by this revision's `openDatabase`,",
    "-- in creation order, minus FTS5's shadow tables — `CREATE VIRTUAL TABLE` refuses to",
    "-- let them be created directly, so `messages_fts`'s own statement is what rebuilds",
    "-- them. Nothing here was hand-written; regenerating this file from a revision that",
    "-- has already changed the schema would produce a different database.",
    "-- A test must load this with the raw SQLite constructor: `openDatabase` runs",
    "-- `migrateDatabase` and would rewrite the state under test.",
    "",
    "PRAGMA foreign_keys = OFF;",
    "",
    ...rows
      .filter((row) => row.type !== "table" || isDumpableTable(row.name))
      .map((row) => row.sql.trim().replace(/;?$/, ";")),
    "",
  ].join("\n");
}

function dumpRows(db: DatabaseHandle): string {
  const lines = [
    "-- Row data for the fixture. Written through the production writers, not by hand;",
    "-- see the README for which boundary row is which and which call produced it.",
    "-- FTS5 shadow tables are omitted: `messages_fts` is dumped, and loading it",
    "-- rebuilds its index.",
    "",
    "PRAGMA foreign_keys = OFF;",
    "",
  ];
  let total = 0;
  let populated = 0;
  for (const table of dumpOrder(db)) {
    const columns = insertableColumns(db, table);
    const rows = statement(db, `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
    if (!rows.length) continue;
    populated += 1;
    total += rows.length;
    lines.push(`-- ${table}: ${rows.length} row(s)`);
    for (const row of rows) {
      lines.push(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map((column) => literal(row[column])).join(", ")});`);
    }
    lines.push("");
  }
  lines.push("PRAGMA foreign_keys = ON;", "");
  process.stdout.write(`Dumped ${total} row(s) across ${populated} populated tables.\n`);
  return lines.join("\n");
}

const README = `# legacy-store-2026-10 — the frozen pre-batch-2 database snapshot

A real database as the **current revision's** \`openDatabase\` produces it, with
representative rows in all four task stores. Batch 2 absorbs
\`operation_queue\` + \`batch_jobs\`/\`batch_job_messages\` +
\`outbound_submissions\` into one \`tasks\` table and drops the old DDL; this
snapshot exists so the migration can be tested against a database that was
**not** reconstructed from the new code.

## How it was produced

\`\`\`
node node_modules/tsx/dist/cli.mjs scripts/export-legacy-store-fixture.mts
\`\`\`

Run against source, not \`dist\`, so the schema cannot be stale. The exporter
**refuses to overwrite** these files: regenerating them from a revision that has
already changed the schema would silently turn the "legacy" snapshot into a copy
of the new one. \`--force\` is for deliberately replacing the baseline, and only
from a pre-batch-2 revision.

It also refuses to run **at all** once the revision is past batch 2, and refuses
even with \`--force\`: it opens the database and stops if \`folders\` has lost
\`total\`/\`unseen\`, if \`operation_queue\` is gone, or if a \`tasks\` table exists.
Past that point a run would produce a post-refactor database wearing the legacy
snapshot's name, which is the one failure this file cannot survive.

Generating it again does **not** reproduce these bytes: submission ids, RFC
message ids, attachment tokens and every AES-GCM ciphertext are random by
construction. Identify rows by property, never by id.

## The one thing the builder substitutes

The jobs and flags commits in it join their staged rows to the background FIFO
chains the moment they commit, and with no executor registered \`runRow\` settles
each row \`failed\`/"no_runner" and the retry loop then burns eight attempts of
backoff. The builder therefore registers **no-op executors** for \`batch-move\`
and \`flags-push\`, so those rows settle \`completed\` at once — the state a real
push or move leaves behind. Everything else is a production writer.

Five states are reached by applying the statement production applies, rather
than by waiting for production to reach it. The first four are marked \`MIRRORS\`
in the exporter:

| State | The statement it mirrors |
|---|---|
| A job settled (\`status='completed'\`, \`completed_at\` in the past) | the terminal half of \`snapshotFromDbRow\`'s lazy settle (\`SET status='completed', completed_at=? WHERE id=? AND status='running'\`) |
| A row claimed (\`status='running'\`, \`attempt_count\` incremented) | \`operation_queue\`'s \`markRunning\` |
| A row terminal (\`completed\`, or \`failed\` with an \`error_message\`) | \`operation_queue\`'s \`markSettled\` |
| A row pruned past the 24h TTL | \`operation_queue\`'s \`pruneTerminal\` |

The fifth is **not** a mirror: the give-up group below is produced by calling
\`revertMoveJobFailures\` itself, the function the move executor hands its
non-retryable refusals to.

Both the queue's timestamps and the prune's threshold are **ISO strings**,
because \`operation_queue.completed_at\` is \`TEXT\` and every writer in
\`operation-queue.ts\` binds \`new Date().toISOString()\`. Binding a number would
store a value and a comparison neither revision ever produces.

**Every timestamp here is relative to the export run**, so a regenerated
snapshot has different dates; the committed files are the baseline. The builder
runs on a clock fixed ten minutes behind its reference instant, which is what
lets a job be settled both *after* it was created and *in the past* — with a live
clock those two are unsatisfiable together, and the earlier output had jobs
completing a minute before they existed. The exporter now asserts against that
inversion.

**A job's terminal \`updated\`/\`failed\` are the ACCEPTANCE-TIME numbers
production inserted, not the lazily projected ones.** The projection's inputs
(\`syncing\`, \`failed_pushes\`) only reach zero with the running app's
\`onOperationSettled\` hook wiring, which a fixture builder does not have. For the
flags job this is exactly the point: its acceptance-time numbers carry the
deficit. Do not assert a projected total against this fixture.

## The master key

\`MASTER_KEY = Buffer.alloc(32, 0x2b)\` — 32 bytes of \`0x2b\`, and nothing else.
Every encrypted row here (\`messages.encrypted_payload\`,
\`outbound_submissions.request_json\`/\`encrypted_details\`,
\`outbound_attachments.encrypted_metadata\`) is a real envelope under that key,
so a test can read them the way the app does. It is test data, not a secret.

\`accounts.encrypted_password\` is the literal string \`envelope-placeholder\`: no
fixture path decrypts it, and a real envelope there would imply a credential
that does not exist.

## Loading it

\`schema.sql\` then \`rows.sql\` into an empty database. Both files bracket their
statements with \`PRAGMA foreign_keys = OFF\`, so a test must load them, then turn
foreign keys ON and check \`PRAGMA foreign_key_check\` — which the read-back test
does. Mirror \`openDatabase\`'s pragmas when opening (\`secure_delete = ON\`,
\`journal_mode = WAL\`, \`foreign_keys = ON\`, \`busy_timeout = 5000\`).

Use the raw SQLite constructor, **not** \`openDatabase\`: \`openDatabase\` runs
\`migrateDatabase\` and would rewrite the very state under test. Anything that
boots the whole app on this file also runs the startup prunes
(\`resumePending\`'s 24h terminal-row sweep, and \`createBatchJob\`'s 15-minute job
sweep), which delete rows this snapshot deliberately keeps.

## Regenerating it is not byte-reproducible

Re-running the exporter produces different bytes while the shape stays identical.
Two causes, both intentional:

- **Every timestamp is relative to the run.** Rows are dated with offsets from a
  \`now\` captured when the export starts (\`-26 * HOUR\`, \`-5 * MINUTE\`, …), so on a
  regeneration all of them move together.
- **Every encrypted payload is re-sealed with a fresh AES-GCM nonce.** Payloads
  are written through the production writers and those never reuse a nonce, so
  the \`nami-v1.…\` strings differ every run.

\`schema.sql\` **is** stable — it is DDL only, so it can be compared byte-for-byte.
For \`rows.sql\`, compare **shape**: the read-back test
(\`apps/server/tests/legacy-store-fixture.test.ts\`) pins the table inventory, the
per-table row counts and every boundary row's identity, which is what a migration
can actually break. A raw diff of \`rows.sql\` after a regeneration is expected
churn and proves nothing either way.

## What each row is for

### The four stores

| Store | Rows |
|---|---|
| \`operation_queue\` | a claimed \`flags-push\` row; an unpushed \`flags-push\` row; a failed \`flags-push\` row; a \`flags-push\` row settled one minute ago (the TTL control); two completed \`batch-move\` rows |
| \`batch_jobs\` + \`batch_job_messages\` | a flags job carrying a deficit, its undo job, an 11-row move job over three accounts — one of them later removed, so 2 of its rows no longer resolve — a job whose account is gone, a job whose queue rows are pruned |
| \`outbound_submissions\` | scheduled, pending-now, unknown-delivery, failed, confirmed, attached |
| \`messages.pending_*\` | a stale move \`intent\`, two unpushed flags markers (each named by a non-terminal \`flags-push\` row), and one marker whose push already settled |
| \`data_migrations\`, \`schema_meta\` | five applied migration ids and \`schema_version=1\` — state a migration must read, not re-apply |

### Boundary rows — the states a migration can get wrong

| # | State | Where to find it |
|---|---|---|
| 1 | A \`running\` queue row, which must map to \`pending\` | \`operation_queue\`: the \`flags-push\` row with \`status='running'\`, \`attempt_count=1\` and \`completed_at IS NULL\`. It is a real unpushed commit on alpha's **Sent** row — a message no job moves — that was then claimed and never settled: the row a crash between the claim and the executor's return leaves behind, and what \`resumePending\` re-enqueues. The transpose is the point: no migration may carry "running" over as a durable task state |
| 2 | An \`undo\` job with \`parent_id\` set, plus its selection | \`batch_jobs\`: \`kind='undo' AND parent_id IS NOT NULL\`; its parent carries \`undone=1\` |
| 3 | A job whose stored arithmetic **does not add up**: \`updated + failed < total\` | \`batch_jobs\`: the \`flags\` job on alpha's inbox, \`total=8, updated=2, failed=1\`. Its selection partitions exactly: \`fx-alpha-inbox-2\` and \`fx-alpha-inbox-8\` had a non-empty delta (\`updated\`), \`fx-alpha-inbox-3\` — the 7a intent — was refused by \`prepareLocalFlags\` because it already carries a move (\`failed\`), and the other five had the patch **already satisfied**, so they are counted in NEITHER and are the deficit. 8 = 2 + 1 + 5. Note where the refusal lives: the flags path inserts its selection rows **without** the \`failed\` column, so it keeps its DDL default \`0\`, and \`changed=0\` is what marks both the refused row and the five no-ops — \`batch_jobs.failed\` is the only place the refusal is recorded. The exporter derives all three groups from the selection's pre-state and asserts them, so the numbers are not decoration |
| 4 | A **scheduled** send: \`status='pending'\` with a future \`send_at\` | \`outbound_submissions\`; the only legacy ledger row that produces a new \`tasks\` row. Its \`due_at\` must equal \`CAST(strftime('%s', send_at) AS INTEGER) * 1000\` |
| 5 | \`status='unknown_delivery'\` | \`outbound_submissions\`; must stay readable, and must **not** become retryable work |
| 6 | A submission **with an attachment**, plus \`request_json\`/\`encrypted_details\` | \`outbound_submissions\` joined to \`outbound_attachment_submissions\`; proves the ledger row and its foreign key come through untouched |
| 7a | A stale move \`intent\` | \`messages\`: \`pending_move_state='intent'\` **with** a destination and a candidate uid. The generated \`effective_mailbox\` keeps it in its source folder, and flags commits must refuse it |
| 7b | An unpushed local flags change | \`messages\`: \`pending_flags_push=1\` with \`pending_flags_base_json\` differing from \`flags_json\`, named by a \`pending\` \`flags-push\` row. The pending branch of \`CONFIRMED_FLAGS_SQL\` |
| 8a | A settled job whose selection is intact but whose queue rows are already pruned | Attribution must fall back to the selection rows' messages |
| 8b | A job that is **not attributable at all** | Its account was removed, so the cascade took its messages and its queue rows and left the job and its selection behind, every \`message_id\` now unresolvable. Must **not** be migrated, and must warn |
| 9 | A job stored \`running\` with \`completed_at IS NULL\` while **every queue row it staged is already terminal** | \`batch_jobs\`: the \`undo\` job. Production settles it lazily on the next read (\`snapshotFromDbRow\`), so this is a transient state that only a crash makes durable. A migration that treats "running" as live work would recreate a task for something already finished |
| 10 | Selection rows the move **permanently gave up on** | \`batch_job_messages\`: \`failed=1\` on \`fx-beta-inbox-1\` and \`fx-beta-inbox-2\`, two of the 11-row move job's \`changed=1\` rows, with their move goal cleared. Produced by \`revertMoveJobFailures\` itself, which is the only writer of this column — \`acceptMoveJob\` inserts every selection row with a literal \`0\` |

7a and 7b are **two rows, not one**, deliberately: \`prepareLocalFlags\` refuses a
row that carries a pending move, so the app never puts both markers on the same
message. A single row carrying both would be a state no code path produces — and
a migration bug could hide behind it.

8b is deliberately the **reverse** of the obvious phrasing "the selection rows
were pruned": \`pruneDurableJobs\` deletes \`batch_job_messages\` and \`batch_jobs\`
under the same predicate in the same call, so a surviving job row with pruned
selections is unreachable. What the shape really keys on is not *why* the job
lost its evidence but **resolvability**: it is unattributable when none of its
selection rows' \`message_id\`s resolves to a message any more. Removing an
account is one road to that, and the one used as the constructor here — because
\`operation_queue\` is the only one of the three tables carrying a foreign key to
\`accounts\`, removing it takes the job's queue rows AND its messages at once.
But the sync paths that delete messages (\`deleteRemoteDeletionCandidate\`,
\`deleteFolderMessages\`) and drafting do the same thing to the messages while
leaving the queue rows in place, so the same "cannot be determined" verdict is
reachable without touching any account.

### More traps in the legacy numbers

- **\`failed\` conflates two different things.** It is
  \`ids.length - prepared.length\`, so it counts a row \`prepareLocalFlags\`
  refused (a pending move) *and* a row that does not exist at all. A migration
  cannot tell them apart from the count; and a selection row with no message is
  not hypothetical, it is exactly what 8b is.
- **\`batch_job_messages.changed = 0\` is not "failed".** \`changed\` marks the
  rows whose delta was non-empty, which is the same set as \`updated\` — so
  \`COUNT(changed = 0)\` equals \`total - updated\`, and that is *more* than
  \`failed\` by the already-satisfied rows of boundary 3. Use \`failed\` for the
  refused-plus-missing count, and treat the remainder as "no work needed".
- **\`batch_job_messages.failed\` is a *different* quantity from
  \`batch_jobs.failed\`, under the same name.** The selection's column is the
  one-time give-up latch, written per message by \`revertMoveJobFailures\` when a
  move permanently fails (boundary 10). The job's column is the acceptance-time
  bucket of boundary 3. The move job here carries **\`failed=1\`** on the job and
  **\`failed=2\`** on its selection, deliberately unequal, so no migration can
  merge the two by accident. \`undoMoveJob\` reads the selection's column
  (\`failed = 0\`), never the job's.
- **A move job's acceptance-time numbers are not progress.** \`acceptMoveJob\`
  fixes both columns at accept time under names that mean something else later:
  \`failed\` counts the ids it **refused**, which is four different situations
  (no such message; an account with no target folder; a message another move
  already owns; a goal write that lost a race) collapsed into one number, and
  \`updated\` counts the ids already **at** their destination — a no-op, not
  work delivered, and not something the projection waits for. So the three move
  jobs here show \`total 11 / updated 0 / failed 1\` and \`total 1 / updated 0 /
  failed 0\`: the same "deficit" as boundary 3, but meaning "work accepted,
  nothing delivered yet" rather than "rows the patch had nothing to do for". A
  migration that copies \`updated\` into a progress column inherits both
  meanings. In this job \`failed=1\` is \`fx-alpha-inbox-3\`, the row 7a's intent
  already owned — its selection row is \`changed=0\`, in the same encoding the
  flags job uses for a row it had nothing to do for.
- **\`pending_flags_push\` is \`NULL\`, not \`0\`, on an untouched row.** The
  column is only ever written on the transition into pending, so "no pending
  push" and "a pending push was settled" are the same value; only
  \`pending_flags_base_json\` distinguishes them. Any predicate must use
  \`COALESCE(pending_flags_push, 0)\` — the projection SQL in \`batch-jobs.ts\`
  does, and a migration that tests \`= 0\` outright will miss every pending row.
  The fixture carries all three states, so the distinction is testable rather
  than asserted: **two** rows where \`pending_flags_base_json\` differs from
  \`flags_json\` (\`fx-alpha-inbox-2\`, 7b's, and \`fx-alpha-sent-1\`, boundary 1's
  claim source), **one** where the two are equal (\`fx-alpha-inbox-8\` — a marker
  whose push already settled, so it must NOT be re-pushed), and **twelve** with
  the column \`NULL\`.

### Other deliberate shapes

- **Inconsistent folder counters, and one impossible pair.** The stored
  \`folders.total\` disagrees with the messages the folder actually holds in
  **six folders**: \`acc-alpha/Archive\` 2 vs 7, \`acc-alpha/INBOX\` 6 vs 2,
  \`acc-alpha/Sent\` 3 vs 1, \`acc-beta/INBOX\` 0 vs 2, \`acc-beta/Sent\` 3 vs 0,
  \`acc-beta/Trash\` 1 vs 0. On top of that, \`acc-beta\`/INBOX carries
  \`unseen=1\` with \`total=0\` — a pair no derivation can ever produce, made
  reachable in the legacy columns by the clamped \`DECREASE\` plus the unclamped
  \`INCREASE\` (T5). The exporter applies that pair **after the last writer** and
  asserts it, because the build's own flags and move commits nudge these columns
  and the seeded value did not survive; it also prints the \`total\` drift it
  found, so a later seed edit cannot quietly wash the inconsistency out. Batch 3
  removes both columns, and this is the database it must be validated against.
  Note the drift the exporter *asserts* is \`total\` only — the \`unseen\` values
  here are a seeded impossible pair, not a reconciled set, and nothing in this
  fixture claims to be the truth about \`unseen\`.
- **\`data_migrations\` is not empty and \`schema_meta\` exists.** Five applied ids
  (\`app_settings_intensity_check_0_100\`, \`app_settings_sound_check_v2\`,
  \`batch_jobs_move_kind\`, \`message-fts-v2\`,
  \`operation_queue_flags_push_kind\`) and \`schema_version = 1\`. A migration
  must read these and **not** re-apply them; a fixture with empty bookkeeping
  would let a re-run pass as a first run.
- **A terminal queue row inside the TTL**, kept as the control that shows the 24h
  prune deleted jobE's rows by predicate rather than by a blanket delete.
- **A failed push row** (\`operation_queue\` \`status='failed'\` with an
  \`error_message\`). Note that **\`batch_jobs.status='failed'\` is unreachable**:
  the CHECK constraint allows it, but no code writes it — the only \`'failed'\` in
  \`batch-jobs.ts\` is the projection reading \`operation_queue\`'s. There is
  therefore no failed *job* row here, and a migration must not expect one.
- **A pre-encryption message.** \`fx-alpha-inbox-4\` has \`encrypted_payload IS
  NULL\`, \`payload_version=0\`, \`payload_metadata_ready IS NULL\`;
  \`message-storage.ts\`'s \`legacyPayload\` is its reader, and the FTS index above
  was built through it.
- **A snoozed message**, a message with attachments, a Sent row with
  \`all_mail_archived=1\`, and the archive row a move job's no-op branch counts as
  already-done.
- **Empty tables are still dumped on discovery.** \`app_settings\`, \`contacts\`,
  \`filter_rules\`, \`mail_templates\`, \`calendar_events\`, \`bimi_logo_cache\`,
  \`outbound_attachment_drafts\` and the auto-reply tables carry no rows here and
  need no entry in any list.

## What this snapshot does NOT prove

- It is a *shape* fixture, not a scale fixture: 15 messages, not 51 000. Batch
  3's 50k performance harness is a separate artifact.
- \`outbound_attachments.storage_name\` names a file that is **not** shipped — the
  encrypted blob lived in the builder's temp directory. Any path that tries to
  read the attachment's bytes will fail, by design.
- Nothing here proves the migration re-derives anything. It stores the legacy
  state a migration must read; what the migration does with it is the
  migration's test.
`;

async function main(): Promise<void> {
  const existing = fs.existsSync(outputDirectory)
    ? fs.readdirSync(outputDirectory).filter((entry) => entry !== "README.md")
    : [];
  if (existing.length && !force) {
    process.stderr.write(
      `The fixture already exists at ${path.relative(projectRoot, outputDirectory)} (${existing.join(", ")}).\n`
      + "It is the frozen pre-batch-2 baseline; refusing to overwrite it.\n"
      + "Pass --force only to replace the baseline, and only from a pre-batch-2 revision.\n",
    );
    process.exitCode = 1;
    return;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nami-legacy-fixture-"));
  const db = await withFixedClock(() => buildDatabase(path.join(temporaryRoot, "nami-mail.db"), path.join(temporaryRoot, "outbound")));
  try {
    const integrity = statement(db, "PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`The built database failed integrity_check: ${integrity.integrity_check}`);
    }
    const violations = statement(db, "PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error(`The built database has ${violations.length} foreign-key violation(s).`);
    const schema = dumpSchema(db);
    const rows = dumpRows(db);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, "schema.sql"), schema);
    fs.writeFileSync(path.join(outputDirectory, "rows.sql"), rows);
    fs.writeFileSync(path.join(outputDirectory, "README.md"), README);
    // `Buffer.byteLength`, not `.length`: these dumps carry em-dashes, so the
    // string length undercounts the file by 2 bytes in the schema and 30 in the
    // rows, and a size that disagrees with `wc -c` reads like a nondeterministic
    // dump when it is in fact byte-stable.
    process.stdout.write(`schema.sql: ${Buffer.byteLength(schema)} bytes\nrows.sql: ${Buffer.byteLength(rows)} bytes\n`);
    process.stdout.write(`fixture written to ${path.relative(projectRoot, outputDirectory)}\n`);
  } finally {
    db.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
