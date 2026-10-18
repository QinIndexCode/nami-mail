import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as mailModule from "../src/mail.js";

/**
 * The provider is the only collaborator replaced -- the same boundary the send
 * runner's own test draws, for the same reason. `sendMail` is the socket; the
 * ledger, the attachment store, the scheduler, the sealing envelope and the
 * database are the production objects.
 *
 * This file used to mock `nodemailer` instead, because it drove the legacy due
 * pass, which dialed the transport itself. Nothing here does that any more: a
 * scheduled send is a `send` task whose whole dispatch runs inside the task
 * layer, and the task layer's seam is `mail.js`. Mocking the transport would
 * leave the interesting half running for real -- the runner's classification of
 * a refusal into retryable/terminal and the safe wording it records.
 */
const { sendMail, imapClientForAccount } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  imapClientForAccount: vi.fn(),
}));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, sendMail, imapClientForAccount };
});

import { encryptAccountPassword } from "../src/account-credentials.js";
import { accountById } from "../src/account-store.js";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  cleanupExpiredOutboundAttachments,
  createOutboundAttachment,
  releaseSubmissionOutboundAttachments,
} from "../src/outbound-attachments.js";
import {
  deletePendingScheduledSubmission,
  markSubmissionSubmitted,
  prepareSubmission,
  submissionForId,
} from "../src/outbox.js";
import { restoreScheduledSubmissionAttachments } from "../src/scheduled-send.js";
import {
  acceptSendTask,
  createSendRunner,
  createTaskHooks,
  createTaskRegistry,
  recordTask,
  startTaskScheduler,
  type CommitTaskDeps,
  type TaskRow,
} from "../src/tasks/index.js";
import type { AccountRecord } from "../src/types.js";

/**
 * What the scheduler holds a parked send on, and what the cancel guard reads:
 * one instant, spelled the same on both sides. Every test below that cares about
 * *when* a mail leaves injects this clock rather than moving the stored time,
 * because `due_at` and `send_at` are compared with `scheduledDueAt`'s ruler and
 * the route's guard respectively -- so a test that edited the row would be
 * testing its own arithmetic instead of the gate.
 */
const ACCOUNT = "account-1";
const ACCOUNT_EMAIL = "sender@example.com";
const MASTER_KEY = Buffer.alloc(32, 7);

function accountRow(key: Buffer): AccountRecord {
  const account: AccountRecord = {
    id: ACCOUNT,
    email: ACCOUNT_EMAIL,
    provider: "custom",
    provider_name: "Demo",
    encrypted_password: "pending",
    auth_method: "password",
    provider_subject: null,
    tenant_id: null,
    granted_scopes: null,
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_secure: 1,
    imap_transport: "tls",
    imap_username: ACCOUNT_EMAIL,
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    smtp_secure: 1,
    smtp_transport: "tls",
    smtp_username: ACCOUNT_EMAIL,
    username_mode: "email",
    signature: "",
    status: "connected",
    last_sync_warning_code: null,
    last_error: null,
    last_error_code: null,
    last_synced_at: null,
    created_at: new Date().toISOString(),
  };
  account.encrypted_password = encryptAccountPassword(account, "app-password", key);
  return account;
}

function insertAccount(db: DatabaseHandle, key: Buffer, id = ACCOUNT, email = ACCOUNT_EMAIL): void {
  const account = accountRow(key);
  account.id = id;
  account.email = email;
  account.imap_username = email;
  account.smtp_username = email;
  account.encrypted_password = encryptAccountPassword(account, "app-password", key);
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password, auth_method,
      imap_host, imap_port, imap_secure, imap_transport, imap_username,
      smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account.id, account.email, account.provider, account.provider_name, account.encrypted_password, account.auth_method,
    account.imap_host, account.imap_port, account.imap_secure, account.imap_transport, account.imap_username,
    account.smtp_host, account.smtp_port, account.smtp_secure, account.smtp_transport, account.smtp_username,
    account.username_mode, account.status, account.created_at,
  );
}

/** The account as the write paths read it: the acceptance takes a record, not an id. */
function accountFor(db: DatabaseHandle, id = ACCOUNT): AccountRecord {
  const account = accountById(db, id);
  if (!account) throw new Error(`Account "${id}" is not in the fixture.`);
  return account;
}

/** A Sent mailbox, so `writePendingSentRow` has somewhere to put its row. */
function insertSentFolder(db: DatabaseHandle, accountId = ACCOUNT): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(accountId, "[Gmail]/Sent Mail", "Sent", "\\Sent");
}

/** One thrown SMTP failure, spelled the way the mail layer classifies them. */
function smtpFailure(extra: Record<string, unknown>): Error {
  return Object.assign(new Error("smtp failure"), { mailPhase: "smtp", ...extra });
}

/** The task an acceptance committed, read as the row a test can assert on. */
type TaskLike = {
  id: string;
  kind: string;
  status: string;
  account_id: string;
  due_at: number | null;
  next_attempt_at: number | null;
  submission_id: string | null;
  attempt_count: number;
  max_attempts: number;
  total: number;
  updated: number;
  failed: number;
  error_code: string | null;
  error_message: string | null;
};

const taskRowOf = (db: DatabaseHandle, taskId: string): TaskLike | undefined =>
  db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskLike | undefined;

const ledgerStatus = (db: DatabaseHandle, submissionId: string): string | undefined =>
  db.prepare("SELECT status FROM outbound_submissions WHERE id = ?").pluck().get(submissionId) as string | undefined;

/**
 * The ledger's user-facing failure pair, read the way a user reads it.
 *
 * Through `submissionForId`, not a SELECT of both columns: on a protected row the
 * plaintext `error_message` column is deliberately NULL and the sentence lives in
 * the sealed details, so a raw read of that column reports `null` for a message
 * that is very much there. Reading the column would test the storage layout
 * instead of what `GET /api/submissions/:id` serves.
 */
const ledgerError = (db: DatabaseHandle, submissionId: string): { errorCode: string | null; errorMessage: string | null } => {
  const submission = submissionForId(db, MASTER_KEY, submissionId);
  if (!submission) throw new Error(`Submission "${submissionId}" is not in the ledger.`);
  return { errorCode: submission.errorCode, errorMessage: submission.errorMessage };
};

/** The optimistic Sent rows: our own writing, and the thing a parked send must not leave. */
const pendingSentRows = (db: DatabaseHandle): number =>
  Number(db.prepare("SELECT COUNT(*) FROM messages WHERE pending_send IS NOT NULL").pluck().get());

/** An acceptance whose `start()` goes nowhere, for tests that drive the scheduler themselves. */
function acceptanceDeps(db: DatabaseHandle, started: string[] = []): CommitTaskDeps {
  return { db, masterKey: MASTER_KEY, scheduler: { start: (taskId: string) => { started.push(taskId); } } };
}

/**
 * Drives task ids through the real scheduler: real registry, real account chain,
 * real retry ladder (1ms), real hooks.
 *
 * The hooks are the app's own (`createTaskHooks`), not a recorder standing in for
 * them, because a send's settlement is not over when the row goes terminal: the
 * settle hook is what retires the optimistic Sent row and closes the books on a
 * give-up (the runner deliberately reports nothing on a retryable attempt, so a
 * row whose budget runs out is finished by the hook -- `wiring.ts`). A stubbed
 * hook would leave every drain here asserting on a half-settled system, and one
 * of them would read as a gap that is not there. The recorder is composed on top,
 * so a test can still watch the terminal statuses go by.
 *
 * The clock is a parameter rather than a stubbed query, so a test can watch the
 * due gate from both sides -- one millisecond early and on the instant itself --
 * without editing the rows the gate reads. `now` defaults to the wall clock,
 * which is what a retry test needs: the ladder waits its 1ms and then re-claims
 * with a fresh `now`, so a frozen clock would leave the row parked forever.
 */
async function drainSendTasks(
  db: DatabaseHandle,
  taskIds: readonly string[],
  options: {
    now?: () => number;
    directory?: string;
    verification?: (submissionId: string) => void;
    maxAttempts?: number;
  } = {},
): Promise<Array<{ id: string; status: string }>> {
  const registry = createTaskRegistry();
  registry.register("send", createSendRunner({
    db,
    masterKey: MASTER_KEY,
    // A directory this file never creates: most sends here carry no attachment,
    // and `resolveOutboundAttachments` reads no file for an empty token set.
    outboundAttachmentDirectory: options.directory ?? path.join(tmpdir(), "nami-scheduled-send-none"),
    scheduleSentVerification: options.verification ?? (() => undefined),
  }));
  if (options.maxAttempts) {
    for (const taskId of taskIds) {
      db.prepare("UPDATE tasks SET max_attempts = ? WHERE id = ?").run(options.maxAttempts, taskId);
    }
  }
  const appHooks = createTaskHooks({ db });
  const settled: Array<{ id: string; status: string }> = [];
  const scheduler = startTaskScheduler({
    db,
    masterKey: MASTER_KEY,
    registry,
    hooks: {
      onTaskSettled: (task: TaskRow, payload: unknown) => {
        appHooks.onTaskSettled?.(task, payload);
        settled.push({ id: task.id, status: task.status });
      },
      ...(appHooks.onTaskPermanentFailure
        ? { onTaskPermanentFailure: (task: TaskRow, payload: unknown) => appHooks.onTaskPermanentFailure!(task, payload) }
        : {}),
    },
    dueTickMs: 60_000,
    retryBaseMs: 1,
    retryMaxMs: 1,
    ...(options.now ? { now: options.now } : {}),
  });
  for (const taskId of taskIds) scheduler.start(taskId);
  await scheduler.drain();
  await scheduler.stop();
  return settled;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: "<provider-id@example.com>" });
  // Nothing in this file owns an IMAP connection. The app's own Sent-verification
  // pass is the one caller that reaches for one (it is *not* mocked away: the
  // route hands it to the runner as a dependency), and its failures are contained
  // by design -- the job swallows each attempt and reports through `onDeferred`.
  imapClientForAccount.mockRejectedValue(new Error("No IMAP connection in this test."));
});

describe("scheduled send storage", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, MASTER_KEY);
  });

  afterEach(() => {
    db.close();
  });

  it("parks a prepared submission with a future send time", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const prepared = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: future,
      request: {
        to: ["recipient@example.com"],
        subject: "Later",
        text: "Body",
        attachmentTokens: [],
      },
    });
    expect(prepared.submission.deliveryStatus).toBe("pending");
    expect(prepared.submission.sendAt).toBe(future);
    expect(submissionForId(db, MASTER_KEY, prepared.submission.id)?.sendAt).toBe(future);
  });

  it("cancels only a pending scheduled submission that is still in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const scheduled = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: future,
      request: { to: ["recipient@example.com"], subject: "Later", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, scheduled.submission.id)).toBe(true);
    expect(submissionForId(db, MASTER_KEY, scheduled.submission.id)).toBeUndefined();

    const due = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: past,
      request: { to: ["recipient@example.com"], subject: "Due", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, due.submission.id)).toBe(false);

    const immediate = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      request: { to: ["recipient@example.com"], subject: "Now", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, immediate.submission.id)).toBe(false);
  });

  // R05: the due query compared send_at as a STRING against a UTC now, so an
  // offset form ("09:00+08:00") sorted before "02:00Z" and never fired. The
  // persisted value is now the same instant in UTC form -- and it is the value
  // `isoToEpochMs` reads into the task's `due_at`, so the normalization is what
  // keeps the two gates (the ledger's string compare and the scheduler's integer
  // one) from disagreeing about the same mail.
  it("stores an offset sendAt as the same instant in UTC (R05)", () => {
    const prepared = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: "2026-01-01T09:00:00+08:00",
      request: { to: ["recipient@example.com"], subject: "Offset", text: "Body", attachmentTokens: [] },
    });
    expect(prepared.submission.sendAt).toBe("2026-01-01T01:00:00.000Z");
    expect(submissionForId(db, MASTER_KEY, prepared.submission.id)?.sendAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("treats cross-day and fractional-precision offsets as their exact instants (R05)", () => {
    // Crosses the day boundary backwards into UTC.
    const crossDay = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: "2026-01-01T23:30:00-05:00",
      request: { to: ["recipient@example.com"], subject: "Cross day", text: "Body", attachmentTokens: [] },
    });
    expect(crossDay.submission.sendAt).toBe("2026-01-02T04:30:00.000Z");

    // Fractional precision is a spelling difference, not a different instant.
    const half = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: "2026-01-01T09:00:00.5+08:00",
      request: { to: ["recipient@example.com"], subject: "Half", text: "Body", attachmentTokens: [] },
    });
    const padded = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: "2026-01-01T09:00:00.500+08:00",
      request: { to: ["recipient@example.com"], subject: "Padded", text: "Body", attachmentTokens: [] },
    });
    expect(half.submission.sendAt).toBe("2026-01-01T01:00:00.500Z");
    expect(padded.submission.sendAt).toBe("2026-01-01T01:00:00.500Z");
  });

  it("cancels an offset-scheduled task by its effective instant, not its wire spelling (R05)", () => {
    // The wire spelling carries +08:00 and names the SAME instant as the Z
    // form (the offset is added to a clock 8h ahead); the cancel decision
    // compares the normalized UTC instant against now.
    const offsetSpelling = (instant: Date): string =>
      new Date(instant.getTime() + 8 * 3_600_000).toISOString().replace("Z", "+08:00");
    const future = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: offsetSpelling(new Date(Date.now() + 3_600_000)),
      request: { to: ["recipient@example.com"], subject: "Future offset", text: "Body", attachmentTokens: [] },
    });
    expect(future.submission.sendAt).not.toContain("+08:00");
    expect(deletePendingScheduledSubmission(db, future.submission.id)).toBe(true);

    const past = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt: offsetSpelling(new Date(Date.now() - 3_600_000)),
      request: { to: ["recipient@example.com"], subject: "Past offset", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, past.submission.id)).toBe(false);
  });
});

/**
 * The two halves of one acceptance, and the one thing that differs between them.
 *
 * A scheduled send is not a second kind of write: it is the same commit -- ledger
 * row, upload links, task -- with `due_at` set instead of the optimistic Sent row.
 * Both facts are asserted here rather than through the route, because the point is
 * what the acceptance *writes*, and a `start()` that goes nowhere is what keeps the
 * row observable instead of running it.
 */
describe("the send acceptance: a parked mail waits, an immediate one is already in Sent", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, MASTER_KEY);
    insertSentFolder(db);
  });

  afterEach(() => {
    db.close();
  });

  it("commits the ledger row, the task and the Sent row for an immediate send, and none of the Sent row for a parked one", () => {
    const started: string[] = [];
    const deps = acceptanceDeps(db, started);
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();

    const parked = acceptSendTask(deps, {
      account: accountFor(db),
      request: { to: ["recipient@example.com"], subject: "Later", text: "Body", attachmentTokens: [] },
      sendAt,
    });
    expect(parked.created).toBe(true);
    expect(parked.submission.sendAt).toBe(sendAt);
    // The whole reason the row is withheld: it is our own writing, and a reader
    // has to be able to tell it from the provider's copy. Parking one would put a
    // mail the provider has never seen into Sent for as long as the schedule runs.
    expect(pendingSentRows(db)).toBe(0);
    expect(taskRowOf(db, parked.taskId!)).toMatchObject({
      kind: "send",
      scope: "single",
      status: "pending",
      account_id: ACCOUNT,
      submission_id: parked.submission.id,
      due_at: Date.parse(sendAt),
      total: 1,
      attempt_count: 0,
    });
    // The task's id IS the submission id, which is what makes a second acceptance
    // a primary-key collision instead of a second dispatch -- and what lets a
    // cancellation find the task by the id the route was given.
    expect(parked.taskId).toBe(parked.submission.id);
    // Started after the commit, never inside it.
    expect(started).toEqual([parked.submission.id]);

    const immediate = acceptSendTask(deps, {
      account: accountFor(db),
      request: { to: ["recipient@example.com"], subject: "Now", text: "Body", attachmentTokens: [] },
    });
    expect(immediate.created).toBe(true);
    expect(immediate.submission.sendAt).toBeNull();
    expect(pendingSentRows(db)).toBe(1);
    expect(taskRowOf(db, immediate.taskId!)).toMatchObject({ status: "pending", due_at: null });
    expect(started).toEqual([parked.submission.id, immediate.submission.id]);

    // Still exactly one: the parked acceptance never added one, so the count comes
    // from the immediate send alone.
    expect(pendingSentRows(db)).toBe(1);
  });

  it("replays a parked acceptance without committing a second task or touching due_at", () => {
    const started: string[] = [];
    const deps = acceptanceDeps(db, started);
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const input = {
      account: accountFor(db),
      request: { to: ["recipient@example.com"], subject: "Later", text: "Body", attachmentTokens: [] },
      sendAt,
      idempotencyKey: "idem-parked-1",
    };

    const first = acceptSendTask(deps, input);
    const replay = acceptSendTask(deps, input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    // The replay reports the row the first acceptance parked, task and all --
    // which is what lets the route answer "still scheduled" without re-deriving
    // anything from the string it was handed.
    expect(replay.submission.id).toBe(first.submission.id);
    expect(replay.taskId).toBe(first.submission.id);
    expect(taskRowOf(db, first.taskId!)?.due_at).toBe(Date.parse(sendAt));
    expect(started).toEqual([first.submission.id]);
  });
});

describe("scheduled send submission", () => {
  let db: DatabaseHandle;
  let directory: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, MASTER_KEY);
    directory = fs.mkdtempSync(path.join(tmpdir(), "nami-scheduled-submit-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** A parked send, committed the way the route commits one. */
  function schedule(subject: string, sendAt: string, attachmentTokens: string[] = []) {
    return acceptSendTask(acceptanceDeps(db), {
      account: accountFor(db),
      request: { to: ["recipient@example.com"], subject, text: "Body", attachmentTokens },
      sendAt,
    });
  }

  it("sends the due mail, records the send and settles the task, leaving the future one alone", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const dueSend = schedule("Due now", due);
    const laterSend = schedule("Future", future);
    const verified: string[] = [];

    const settled = await drainSendTasks(db, [dueSend.taskId!, laterSend.taskId!], {
      directory,
      verification: (submissionId) => verified.push(submissionId),
    });

    expect(settled).toEqual([{ id: dueSend.taskId, status: "completed" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    // The author of the wire message is the LEDGER, not the task: the recipient,
    // the body and above all the stable RFC Message-ID come from the sealed
    // request, which is the one thing that makes a redelivery the same email.
    expect(sendMail.mock.calls[0]![2]).toMatchObject({
      to: ["recipient@example.com"],
      subject: "Due now",
      text: "Body",
      messageId: dueSend.submission.messageId,
    });
    expect(ledgerStatus(db, dueSend.submission.id)).toBe("submitted");
    expect(submissionForId(db, MASTER_KEY, dueSend.submission.id)?.sendAt).toBe(due);
    expect(verified).toEqual([dueSend.submission.id]);
    expect(taskRowOf(db, dueSend.taskId!)).toMatchObject({
      status: "completed",
      attempt_count: 1,
      total: 1,
      updated: 1,
      failed: 0,
    });

    // The future send is untouched, and the reason is the claim predicate rather
    // than a due-time scan that happened not to reach it: the row was never
    // claimed, so it kept `attempt_count` at zero.
    expect(taskRowOf(db, laterSend.taskId!)).toMatchObject({
      status: "pending",
      attempt_count: 0,
      due_at: Date.parse(future),
    });
    expect(ledgerStatus(db, laterSend.submission.id)).toBe("pending");
  });

  it("holds a parked send until its due instant, and claims it on that millisecond (R05)", async () => {
    // 09:00+08:00 == 01:00Z. Before normalization the stored string sorted BEFORE
    // the cutoff and the due query found nothing at all; the task's `due_at` is
    // the instant itself, so the gate is an integer comparison the offset cannot
    // fool.
    const dueAtMs = Date.parse("2026-01-01T01:00:00.000Z");
    const parked = schedule("Offset due", "2026-01-01T09:00:00+08:00");
    expect(parked.submission.sendAt).toBe("2026-01-01T01:00:00.000Z");
    expect(taskRowOf(db, parked.taskId!)?.due_at).toBe(dueAtMs);

    // One millisecond early: the claim predicate is `due_at <= now`, so the row is
    // not claimed, the socket is never touched, and the task is not even counted
    // as attempted.
    const early = await drainSendTasks(db, [parked.taskId!], { now: () => dueAtMs - 1, directory });
    expect(early).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(ledgerStatus(db, parked.submission.id)).toBe("pending");
    expect(taskRowOf(db, parked.taskId!)).toMatchObject({ status: "pending", attempt_count: 0 });

    // On the instant itself: claimed, sent, settled -- no grace period and no
    // second pass needed.
    const onTime = await drainSendTasks(db, [parked.taskId!], { now: () => dueAtMs, directory });
    expect(onTime).toEqual([{ id: parked.taskId, status: "completed" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, parked.submission.id)).toBe("submitted");
  });

  it("drains a due burst one send at a time, in the order the rows were committed", async () => {
    const dueAtMs = Date.parse(new Date(Date.now() - 60_000).toISOString());
    const parked = Array.from({ length: 6 }, (_, index) => schedule(`Burst ${index}`, new Date(dueAtMs).toISOString()));

    let active = 0;
    let peak = 0;
    sendMail.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { messageId: "<provider-id@example.com>" };
    });

    const settled = await drainSendTasks(db, parked.map((send) => send.taskId!), { now: () => dueAtMs, directory });

    // One socket at a time, which is the whole difference from the due pass this
    // replaced: that one ran four workers, so two sends of one account could be in
    // flight together. Serial is not a slow choice -- a mailbox is one queue, and
    // two writes to it compose in submission order or not at all.
    expect(peak).toBe(1);
    expect(settled).toHaveLength(6);
    expect(settled.every((task) => task.status === "completed")).toBe(true);
    // And in commit order, which is what the FIFO chain is for: the participants
    // are read back from the wire rather than from the task rows.
    expect(sendMail.mock.calls.map((call) => (call[2] as { subject: string }).subject)).toEqual([
      "Burst 0", "Burst 1", "Burst 2", "Burst 3", "Burst 4", "Burst 5",
    ]);
    for (const send of parked) {
      expect(ledgerStatus(db, send.submission.id)).toBe("submitted");
      expect(taskRowOf(db, send.taskId!)).toMatchObject({ status: "completed", updated: 1, failed: 0 });
    }
  });

  it("retries a refused send instead of giving up on it, which the due pass could not", async () => {
    const parked = schedule("Retried", new Date(Date.now() - 60_000).toISOString());
    // `RCPT TO` is on the pre-acceptance list: the mail never transferred, so
    // trying again cannot duplicate it. The due pass had no ladder at all -- it
    // handed every refusal to the user after one attempt.
    sendMail.mockRejectedValueOnce(smtpFailure({ command: "RCPT TO" }));

    const settled = await drainSendTasks(db, [parked.taskId!], { directory });

    expect(settled).toEqual([{ id: parked.taskId, status: "completed" }]);
    expect(sendMail).toHaveBeenCalledTimes(2);
    // The failed first attempt was recorded as truthful, then overwritten by the
    // success: the ledger is not left claiming a failure the retry disproved.
    expect(ledgerStatus(db, parked.submission.id)).toBe("submitted");
    expect(taskRowOf(db, parked.taskId!)).toMatchObject({
      status: "completed",
      attempt_count: 2,
      updated: 1,
      failed: 0,
      // The settle that recorded `completed` cleared the trace the release left.
      error_code: null,
      error_message: null,
    });
  });

  it("records our words for a refusal, on the ledger and on the task row", async () => {
    const parked = schedule("Refused", new Date(Date.now() - 60_000).toISOString());
    // Nodemailer attaches the failing SMTP command, and a real refusal carries the
    // server's banner and the recipient with it. Neither may reach a row a user
    // reads: what the ledger records is what `GET /api/submissions/:id` serves and
    // the send-status view renders.
    const failure = smtpFailure({ command: "RCPT TO" });
    failure.message = "SMTP rejected RCPT TO <recipient@example.com>";
    sendMail.mockRejectedValue(failure);

    // The budget is one, so a retryable refusal becomes terminal here -- which is
    // the shape a user meets when the ladder is spent, and the only one where the
    // wording survives on two rows at once.
    const settled = await drainSendTasks(db, [parked.taskId!], { directory, maxAttempts: 1 });

    expect(settled).toEqual([{ id: parked.taskId, status: "failed" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, parked.submission.id)).toBe("failed");
    expect(ledgerError(db, parked.submission.id)).toEqual({
      errorCode: "unknown",
      errorMessage: "邮件服务发生了未识别错误。请稍后重试；若持续出现，请检查服务商状态和网络设置。",
    });
    // The task row is renderable too (`taskProgress`, the batch snapshot), so the
    // safe pair has to survive there as well -- and the code has to be OURS rather
    // than the transport's spelling, which is why the runner throws an error
    // carrying the safe pair instead of rethrowing the raw one.
    //
    // `failed: 1` is the settle hook's writing, not the runner's: a retryable
    // failure reports no counts on purpose (the task still owed that mail, and
    // whether it is owed *failed* is the next attempt's to decide), so a row whose
    // budget runs out is left 0/1 by the attempt and closed by the hook that finds
    // the remainder. Both halves are production code here.
    expect(taskRowOf(db, parked.taskId!)).toMatchObject({
      status: "failed",
      error_code: "unknown",
      error_message: "邮件服务发生了未识别错误。请稍后重试；若持续出现，请检查服务商状态和网络设置。",
      attempt_count: 1,
      total: 1,
      updated: 0,
      failed: 1,
    });
    const ledgerRow = JSON.stringify(db.prepare("SELECT * FROM outbound_submissions WHERE id = ?").get(parked.submission.id));
    const taskRow = JSON.stringify(db.prepare("SELECT * FROM tasks WHERE id = ?").get(parked.taskId));
    expect(ledgerRow).not.toContain("SMTP rejected RCPT TO");
    expect(taskRow).not.toContain("SMTP rejected RCPT TO");
  });

  it("ends an ambiguous SMTP failure as unknown_delivery, without a second attempt", async () => {
    const parked = schedule("Ambiguous", new Date(Date.now() - 60_000).toISOString());
    // A socket timeout is indistinguishable from a lost final response, so the
    // mail may have left: the ladder must stop rather than deliver it twice.
    sendMail.mockRejectedValue(smtpFailure({ code: "timeout" }));

    const settled = await drainSendTasks(db, [parked.taskId!], { directory });

    expect(settled).toEqual([{ id: parked.taskId, status: "unknown_delivery" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, parked.submission.id)).toBe("unknown_delivery");
    expect(ledgerError(db, parked.submission.id)?.errorCode).toBe("timeout");
    expect(taskRowOf(db, parked.taskId!)).toMatchObject({
      status: "unknown_delivery",
      attempt_count: 1,
      total: 1,
      updated: 0,
      failed: 1,
    });
  });
});

describe("scheduled send API routes", () => {
  let app: FastifyInstance;
  let routeDb: DatabaseHandle;
  let attachmentDirectory: string;

  beforeEach(async () => {
    routeDb = openDatabase(":memory:");
    attachmentDirectory = fs.mkdtempSync(path.join(tmpdir(), "nami-scheduled-send-"));
    app = await buildApp({ db: routeDb, masterKey: MASTER_KEY, outboundAttachmentDirectory: attachmentDirectory });
    insertAccount(routeDb, MASTER_KEY);
  });

  afterEach(async () => {
    await app.close();
    routeDb.close();
    fs.rmSync(attachmentDirectory, { recursive: true, force: true });
  });

  it("schedules a send, parks a task for it, and cancels both together", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: ACCOUNT,
        to: ["recipient@example.com"],
        subject: "Later",
        text: "Body",
        sendAt: future,
      },
    });
    expect(scheduled.statusCode).toBe(202);
    const body = scheduled.json() as {
      scheduled: boolean;
      deliveryStatus: string;
      sendAt: string;
      taskId: string;
      submission: { id: string };
    };
    expect(body.scheduled).toBe(true);
    expect(body.deliveryStatus).toBe("pending");
    expect(body.sendAt).toBe(future);
    expect(sendMail).not.toHaveBeenCalled();

    // The durable half of "scheduled": one task, parked on the instant the user
    // named, holding the submission id as its own id.
    expect(body.taskId).toBe(body.submission.id);
    expect(taskRowOf(routeDb, body.taskId)).toMatchObject({
      kind: "send",
      status: "pending",
      submission_id: body.submission.id,
      due_at: Date.parse(future),
    });

    const cancel = await app.inject({ method: "POST", url: `/api/messages/send/${body.submission.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().cancelled).toBe(true);
    // Both halves of one lifetime, gone in one transaction. Keyed on the task's
    // primary key, because the ledger delete has already nulled `submission_id`
    // by the time it runs (`ON DELETE SET NULL`) -- a lookup by that column would
    // have found nothing and left a `send` task with no submission behind, which
    // an attempt can only abort as `no_submission`.
    expect(taskRowOf(routeDb, body.taskId)).toBeUndefined();
    expect(submissionForId(routeDb, MASTER_KEY, body.submission.id)).toBeUndefined();
  });

  it("refuses to cancel a send that is already due, and leaves its task alone", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: ACCOUNT,
        to: ["recipient@example.com"],
        subject: "Due",
        text: "Body",
        sendAt: past,
      },
    });
    expect(scheduled.statusCode).toBe(202);
    const submissionId = scheduled.json().submission.id as string;
    // The 202 is a snapshot taken at the acceptance, so it reports the parked
    // shape; the task it committed is already due, so the app's own scheduler
    // claims it in the same second. Either way the row stops being cancellable.
    await vi.waitFor(() => expect(ledgerStatus(routeDb, submissionId)).toBe("submitted"));
    expect(sendMail).toHaveBeenCalledTimes(1);

    const cancel = await app.inject({ method: "POST", url: `/api/messages/send/${submissionId}/cancel` });
    expect(cancel.statusCode).toBe(409);
    // A refused cancellation must not be half-applied: the task is still there.
    expect(taskRowOf(routeDb, submissionId)).toMatchObject({ submission_id: submissionId });

    const missing = await app.inject({ method: "POST", url: "/api/messages/send/missing/cancel" });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a cancellation the ledger predicate rejects, without deleting the task", async () => {
    // The guard is the ledger's own predicate (`status = 'pending' AND send_at >
    // now`), so the shape that matters is a row whose `send_at` has passed while
    // its task has not run yet. Written directly rather than reached by racing the
    // scheduler: a test that waited for the window would be testing `Date.now`.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { accountId: ACCOUNT, to: ["recipient@example.com"], subject: "Overdue", text: "Body", sendAt: future },
    });
    const submissionId = scheduled.json().submission.id as string;
    routeDb.prepare("UPDATE outbound_submissions SET send_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), submissionId);

    const cancel = await app.inject({ method: "POST", url: `/api/messages/send/${submissionId}/cancel` });
    expect(cancel.statusCode).toBe(409);
    expect(submissionForId(routeDb, MASTER_KEY, submissionId)?.deliveryStatus).toBe("pending");
    expect(taskRowOf(routeDb, submissionId)).toMatchObject({ status: "pending", submission_id: submissionId });
  });

  it("links scheduled attachments at parking time so the TTL cleanup cannot take them", async () => {
    const upload = createOutboundAttachment(routeDb, attachmentDirectory, MASTER_KEY, {
      accountId: ACCOUNT,
      filename: "report.txt",
      contentType: "text/plain",
      content: Buffer.from("SCHEDULED_ATTACHMENT_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: ACCOUNT,
        to: ["recipient@example.com"],
        subject: "With attachment",
        text: "Body",
        sendAt,
        attachmentTokens: [upload.token],
      },
    });
    expect(scheduled.statusCode).toBe(202);
    const submissionId = scheduled.json().submission.id as string;

    // The upload is linked to the parked submission immediately, so the stale
    // cleanup past the 24h TTL must not remove it.
    const links = routeDb.prepare(
      "SELECT submission_id FROM outbound_attachment_submissions WHERE attachment_token = ?",
    ).all(upload.token) as Array<{ submission_id: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]!.submission_id).toBe(submissionId);
    expect(cleanupExpiredOutboundAttachments(routeDb, attachmentDirectory, new Date(Date.now() + 25 * 3_600_000))).toBe(0);

    // When due, the task the route parked submits through SMTP with the original
    // bytes. The clock is injected past `due_at` rather than the row edited, so
    // what is under test is the gate the scheduler reads.
    const verified: string[] = [];
    const settled = await drainSendTasks(routeDb, [submissionId], {
      now: () => Date.parse(sendAt) + 3_600_000,
      directory: attachmentDirectory,
      verification: (id) => verified.push(id),
    });
    expect(settled).toEqual([{ id: submissionId, status: "completed" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const wire = sendMail.mock.calls[0]![2] as { attachments?: Array<{ content?: unknown }> };
    expect(Buffer.from(wire.attachments?.[0]?.content as Uint8Array).toString("utf8")).toBe("SCHEDULED_ATTACHMENT_CANARY");
    expect(ledgerStatus(routeDb, submissionId)).toBe("submitted");
    expect(verified).toEqual([submissionId]);
  });

  it("reports the persisted real status for an idempotent scheduled retry", async () => {
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const payload = {
      accountId: ACCOUNT,
      idempotencyKey: "idem-scheduled-1",
      to: ["recipient@example.com"],
      subject: "Retry me",
      text: "Body",
      sendAt,
    };
    const first = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(first.statusCode).toBe(202);
    expect(first.json().deliveryStatus).toBe("pending");

    // The scheduler submits the task between the two requests.
    markSubmissionSubmitted(routeDb, MASTER_KEY, first.json().submission.id, "<retried@nami.local>");

    const retry = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().deliveryStatus).toBe("submitted");
    expect(retry.json().scheduled).toBeUndefined();
    // No duplicate SMTP send for the retry.
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects missing attachment tokens without leaving any scheduled task", async () => {
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: ACCOUNT,
        to: ["recipient@example.com"],
        subject: "Missing attachment",
        text: "Body",
        sendAt,
        attachmentTokens: ["out_00000000-0000-4000-8000-000000000000"],
      },
    });
    expect(rejected.statusCode).toBe(404);
    // The acceptance validates the token set inside its own transaction, and the
    // throw rolls the whole acceptance back: the ledger row, its links and the
    // task are all gone together, so a rejected send leaves nothing to dispatch.
    expect(routeDb.prepare("SELECT id FROM outbound_submissions").all()).toHaveLength(0);
    expect(routeDb.prepare("SELECT id FROM tasks").all()).toHaveLength(0);
  });

  it("rejects a cross-account attachment token without leaving any scheduled task", async () => {
    // A real second account owns the upload; the sender must not borrow it.
    insertAccount(routeDb, MASTER_KEY, "account-2", "sender2@example.com");
    const foreign = createOutboundAttachment(routeDb, attachmentDirectory, MASTER_KEY, {
      accountId: "account-2",
      filename: "foreign.txt",
      contentType: "text/plain",
      content: Buffer.from("FOREIGN_CANARY"),
    });
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: ACCOUNT,
        to: ["recipient@example.com"],
        subject: "Cross account attachment",
        text: "Body",
        sendAt,
        attachmentTokens: [foreign.token],
      },
    });
    expect(rejected.statusCode).toBe(404);
    expect(routeDb.prepare("SELECT id FROM outbound_submissions").all()).toHaveLength(0);
    expect(routeDb.prepare("SELECT id FROM tasks").all()).toHaveLength(0);
    // The foreign upload itself is untouched.
    expect(foreign.token).toBeTruthy();
  });

  it("reports the real terminal status for an idempotent retry whose attachments were already released", async () => {
    const upload = createOutboundAttachment(routeDb, attachmentDirectory, MASTER_KEY, {
      accountId: ACCOUNT,
      filename: "report.txt",
      contentType: "text/plain",
      content: Buffer.from("RELEASED_ATTACHMENT_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const payload = {
      accountId: ACCOUNT,
      idempotencyKey: "idem-released-1",
      to: ["recipient@example.com"],
      subject: "Retry after release",
      text: "Body",
      sendAt,
      attachmentTokens: [upload.token],
    };
    const first = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(first.statusCode).toBe(202);

    // The task submits between the two requests and the terminal submission's
    // uploads are released, exactly as reality does.
    const submissionId = first.json().submission.id as string;
    markSubmissionSubmitted(routeDb, MASTER_KEY, submissionId, "<released@nami.local>");
    releaseSubmissionOutboundAttachments(routeDb, attachmentDirectory, ACCOUNT, submissionId);

    const retry = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().deliveryStatus).toBe("submitted");
    // The committed terminal status must survive the retry untouched.
    expect(submissionForId(routeDb, MASTER_KEY, submissionId)?.deliveryStatus).toBe("submitted");
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("scheduled send attachment restore", () => {
  let db: DatabaseHandle;
  let directory: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, MASTER_KEY);
    directory = fs.mkdtempSync(path.join(tmpdir(), "nami-scheduled-restore-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /**
   * The task a legacy parked row would be given by the migration's backfill:
   * `id` is the submission id and `due_at` is the same `isoToEpochMs` reading of
   * the stored `send_at` the acceptance uses. Written here because a row parked
   * by a build that predates the task layer has no task until that backfill runs,
   * and the restore pass is exactly the service that exists for those rows.
   */
  function taskForLegacyRow(submissionId: string, sendAt: string): void {
    recordTask(db, MASTER_KEY, {
      id: submissionId,
      accountId: ACCOUNT,
      kind: "send",
      total: 1,
      submissionId,
      dueAt: Date.parse(sendAt),
    });
  }

  it("rebuilds lost attachment links for a legacy parked task before cleanup", async () => {
    const upload = createOutboundAttachment(db, directory, MASTER_KEY, {
      accountId: ACCOUNT,
      filename: "legacy.txt",
      contentType: "text/plain",
      content: Buffer.from("LEGACY_ATTACHMENT_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    // A task parked before the route started linking at park time: the
    // durable request carries the token, but no link row exists yet.
    const legacy = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt,
      request: {
        to: ["recipient@example.com"],
        subject: "Legacy",
        text: "Body",
        attachmentTokens: [upload.token],
      },
    });
    expect(db.prepare("SELECT 1 FROM outbound_attachment_submissions").all()).toHaveLength(0);
    taskForLegacyRow(legacy.submission.id, sendAt);

    expect(restoreScheduledSubmissionAttachments(db, MASTER_KEY)).toEqual({ restored: 1, failed: 0 });

    // The 25h stale cleanup must now keep the upload.
    expect(cleanupExpiredOutboundAttachments(db, directory, new Date(Date.now() + 25 * 3_600_000))).toBe(0);

    // When due, the original bytes reach SMTP.
    const settled = await drainSendTasks(db, [legacy.submission.id], {
      now: () => Date.parse(sendAt) + 3_600_000,
      directory,
    });
    expect(settled).toEqual([{ id: legacy.submission.id, status: "completed" }]);
    const wire = sendMail.mock.calls[0]![2] as { attachments?: Array<{ content?: unknown }> };
    expect(Buffer.from(wire.attachments?.[0]?.content as Uint8Array).toString("utf8")).toBe("LEGACY_ATTACHMENT_CANARY");
    expect(ledgerStatus(db, legacy.submission.id)).toBe("submitted");
  });

  it("explicitly fails a legacy parked task whose upload is already gone", () => {
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const legacy = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt,
      request: {
        to: ["recipient@example.com"],
        subject: "Lost upload",
        text: "Body",
        attachmentTokens: ["out_00000000-0000-4000-8000-000000000000"],
      },
    });

    expect(restoreScheduledSubmissionAttachments(db, MASTER_KEY)).toEqual({ restored: 0, failed: 1 });
    expect(ledgerStatus(db, legacy.submission.id)).toBe("failed");
    expect(ledgerError(db, legacy.submission.id)?.errorCode).toBe("attachment_unavailable");
    // No silent send without the attachment.
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("leaves tasks without attachments untouched", () => {
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const plain = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      sendAt,
      request: { to: ["recipient@example.com"], subject: "Plain", text: "Body", attachmentTokens: [] },
    });
    expect(restoreScheduledSubmissionAttachments(db, MASTER_KEY)).toEqual({ restored: 0, failed: 0 });
    expect(ledgerStatus(db, plain.submission.id)).toBe("pending");
  });

  it("fails a due task whose attachment file disappeared after it was parked", async () => {
    const upload = createOutboundAttachment(db, directory, MASTER_KEY, {
      accountId: ACCOUNT,
      filename: "vanishing.txt",
      contentType: "text/plain",
      content: Buffer.from("VANISHING_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const parked = acceptSendTask(acceptanceDeps(db), {
      account: accountFor(db),
      request: {
        to: ["recipient@example.com"],
        subject: "Vanishing upload",
        text: "Body",
        attachmentTokens: [upload.token],
      },
      sendAt,
    });
    // The link the acceptance wrote keeps the TTL cleanup away from the upload, so
    // the file is removed where it lives -- which is the case the link cannot
    // cover anyway: a disk cleaned by hand, a restored profile, a half-copied
    // directory. The send must be refused rather than sent without the file.
    const root = fs.realpathSync(directory);
    const stored = fs.readdirSync(root);
    expect(stored).toHaveLength(1);
    fs.rmSync(path.join(root, stored[0]!), { force: true });

    const settled = await drainSendTasks(db, [parked.taskId!], {
      now: () => Date.parse(sendAt) + 60_000,
      directory,
    });

    expect(settled).toEqual([{ id: parked.taskId, status: "failed" }]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(ledgerStatus(db, parked.submission.id)).toBe("failed");
    expect(ledgerError(db, parked.submission.id)?.errorCode).toBe("attachment_unavailable");
    // Never `unknown_delivery`, and never a reason to send without the file:
    // nothing was transferred, so this is diagnosable rather than ambiguous.
    expect(taskRowOf(db, parked.taskId!)).toMatchObject({
      status: "failed",
      error_code: "attachment_unavailable",
      attempt_count: 1,
      total: 1,
      updated: 0,
      failed: 1,
    });
  });
});
