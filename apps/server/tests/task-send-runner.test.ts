import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

/**
 * The provider is the only collaborator replaced -- the same boundary the flags
 * runner test draws, for the same reason. `sendMail` is the socket; the ledger,
 * the attachment store, the draft discard, the sealing envelope, the scheduler
 * and the database are the production objects. Mocking `startSubmission` or
 * `markSubmissionSubmitted` would pin the legacy executor's shape and prove
 * nothing about this port.
 */
const { sendMail, imapClientForAccount } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  imapClientForAccount: vi.fn(),
}));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, sendMail, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { createOutboundAttachment } from "../src/outbound-attachments.js";
import { prepareSubmission, submissionForId } from "../src/outbox.js";
import { createSendRunner, acceptPreparedSendTask, type SendTaskDeps } from "../src/tasks/kinds/send.js";
import { createTaskRegistry } from "../src/tasks/registry.js";
import { startTaskScheduler, TASK_RUN_TIMEOUT_MS } from "../src/tasks/scheduler.js";
import { openTaskPayload, recordTask, reportTaskProgress, taskItems, taskRow } from "../src/tasks/store.js";
import type { TaskRow, TaskSpec } from "../src/tasks/types.js";
import type { AccountRecord } from "../src/types.js";

/**
 * The `send` kind: what the runner decides from the ledger's status, what each
 * failure it can meet means, and which rows it refuses outright.
 *
 * The judgement table is the port's whole substance, so each row of it has a
 * test that fails for its own reason:
 *
 *   1. `pending` is attempted, and the mail that goes out is the LEDGER's
 *      request -- the task carries no payload at all;
 *   2. `failed` is attempted again, which is what the interactive route's manual
 *      retry depends on;
 *   3. `submitted` and `confirmed` are idempotent: the double-dispatch net, where
 *      a second claim must not become a second email;
 *   4. `submitting` is never an SMTP attempt: a fresh claim waits out a live
 *      owner, while a claim older than the scheduler's run timeout is converted
 *      to `unknown_delivery` rather than left to exhaust the ladder into
 *      `failed`;
 *   5. `unknown_delivery` is terminal with no socket, because a retry could
 *      deliver the mail twice;
 *
 * and the three error mappings, which differ only in who retries: a vanished
 * attachment is terminal and truthful, a pre-acceptance failure (by code OR by
 * SMTP command) is retryable, and everything else is an ambiguous delivery that
 * must never be retried automatically.
 */

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const DIRECTORY = "/tmp/nami-outbound-test";
const ACCOUNT_EMAIL = "demo@example.com";

// ---------------------------------------------------------------------------
// The socket.
// ---------------------------------------------------------------------------

const lock = { release: vi.fn() };
const messageDelete = vi.fn(async () => true);
const client = {
  usable: true,
  connect: vi.fn(async () => undefined),
  getMailboxLock: vi.fn(async () => lock),
  messageDelete,
  logout: vi.fn(async () => undefined),
};

/** One thrown SMTP failure, spelled the way the mail layer classifies them. */
function smtpFailure(extra: Record<string, unknown>): Error {
  return Object.assign(new Error("smtp failure"), extra);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function insertAccount(db: DatabaseHandle, id = ACCOUNT, email = ACCOUNT_EMAIL): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

type RequestOverrides = Partial<{
  to: string[];
  cc: string[];
  inReplyTo: string;
  references: string[];
  subject: string;
  text: string;
  html: string;
  discardDraftId: string;
  attachmentTokens: string[];
}>;

function fixture(overrides: RequestOverrides = {}): { db: DatabaseHandle; submissionId: string } {
  const db = openDatabase(":memory:");
  insertAccount(db);
  const { submission } = prepareSubmission(db, MASTER_KEY, {
    accountId: ACCOUNT,
    accountEmail: ACCOUNT_EMAIL,
    request: { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [], ...overrides },
  });
  return { db, submissionId: submission.id };
}

function sendTask(db: DatabaseHandle, submissionId: string | undefined, extra: Partial<TaskSpec> = {}): string {
  return recordTask(db, MASTER_KEY, {
    accountId: ACCOUNT,
    kind: "send",
    total: 1,
    ...(submissionId ? { submissionId } : {}),
    ...extra,
  } satisfies TaskSpec);
}

/**
 * The runner deps, with the verification pass supplied by default.
 *
 * `scheduleSentVerification` is a required field, so a helper that omitted it
 * would leave the runner throwing a `TypeError` *after* the mail went out --
 * which is not a delivery verdict at all, and the scheduler would quietly spend
 * a second attempt on a send that had already succeeded. Tests that assert on
 * the pass pass their own recorder.
 */
const depsFor = (db: DatabaseHandle, extra: Partial<SendTaskDeps> = {}): SendTaskDeps => ({
  db,
  masterKey: MASTER_KEY,
  outboundAttachmentDirectory: DIRECTORY,
  scheduleSentVerification: () => undefined,
  ...extra,
});

/** Moves the ledger to a state without going through SMTP. */
function setLedger(db: DatabaseHandle, submissionId: string, status: string, errorCode: string | null = null): void {
  db.prepare("UPDATE outbound_submissions SET status = ?, error_code = ? WHERE id = ?").run(status, errorCode, submissionId);
}

const ledgerStatus = (db: DatabaseHandle, submissionId: string): string =>
  (db.prepare("SELECT status FROM outbound_submissions WHERE id = ?").get(submissionId) as { status: string }).status;

const ledgerError = (db: DatabaseHandle, submissionId: string): { error_code: string | null } =>
  db.prepare("SELECT error_code FROM outbound_submissions WHERE id = ?").get(submissionId) as { error_code: string | null };

type Deltas = Array<{ updated?: number; failed?: number }>;

/**
 * One attempt, driven the way the scheduler drives it: real row, real absent
 * payload. Returns the raw throw so a test can watch a retryable failure, which
 * the scheduler would turn into another attempt.
 */
async function attempt(deps: SendTaskDeps, taskId: string, deltas: Deltas): Promise<unknown> {
  const runner = createSendRunner(deps);
  const task = taskRow(deps.db, taskId) as TaskRow;
  try {
    await runner({
      task,
      payload: openTaskPayload(MASTER_KEY, task),
      items: taskItems(deps.db, taskId),
      report: (delta) => {
        deltas.push(delta);
        reportTaskProgress(deps.db, taskId, delta, Date.now());
      },
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The real scheduler: registry, chain, retry ladder (1ms), terminal hook. */
async function drain(
  deps: SendTaskDeps,
  taskId: string,
  extra: Partial<TaskSpec> = {},
): Promise<Array<{ id: string; status: string }>> {
  if (extra.maxAttempts) {
    deps.db.prepare("UPDATE tasks SET max_attempts = ? WHERE id = ?").run(extra.maxAttempts, taskId);
  }
  const registry = createTaskRegistry();
  registry.register("send", createSendRunner(deps));
  const settled: Array<{ id: string; status: string }> = [];
  const scheduler = startTaskScheduler({
    db: deps.db,
    masterKey: MASTER_KEY,
    registry,
    hooks: { onTaskSettled: (task: TaskRow) => settled.push({ id: task.id, status: task.status }) },
    dueTickMs: 60_000,
    retryBaseMs: 1,
    retryMaxMs: 1,
  });
  scheduler.start(taskId);
  await scheduler.drain();
  await scheduler.stop();
  return settled;
}

let db: DatabaseHandle;

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: "<provider-id@example.com>" });
  imapClientForAccount.mockImplementation(async () => client);
});

afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
});

describe("task send runner: the ledger status is the judgement table", () => {
  it("sends the ledger's request for a pending submission, and carries no payload of its own", async () => {
    const world = fixture({ inReplyTo: "<parent@example.com>", references: ["<grandparent@example.com>"] });
    db = world.db;
    const taskId = sendTask(db, world.submissionId);

    // The task's shape before it runs: no ciphertext at all. `openTaskPayload`
    // returning undefined is what "no payload" means here, and it is why a send
    // task's `items` are empty -- there is no message row to materialize, the
    // optimistic Sent row is the acceptance's business (contract §4.3).
    const row = taskRow(db, taskId) as TaskRow;
    expect(row).toMatchObject({ kind: "send", scope: "single", status: "pending", total: 1, updated: 0, failed: 0 });
    expect(row.payload_ciphertext).toBeNull();
    expect(openTaskPayload(MASTER_KEY, row)).toBeUndefined();
    expect(taskItems(db, taskId)).toEqual([]);

    const verified: string[] = [];
    const deps = depsFor(db, { scheduleSentVerification: (id) => verified.push(id) });
    expect(await drain(deps, taskId)).toEqual([{ id: taskId, status: "completed" }]);

    const submission = submissionForId(db, MASTER_KEY, world.submissionId);
    // The author of the wire message is the LEDGER, not the task: the recipient,
    // the body and above all the stable RFC Message-ID all come from the sealed
    // request, which is the one thing that makes a redelivery the same email.
    expect(sendMail).toHaveBeenCalledTimes(1);
    const wire = sendMail.mock.calls[0]![2] as Record<string, unknown>;
    expect(wire).toMatchObject({
      to: ["friend@example.com"],
      subject: "Hello",
      text: "Body",
      messageId: submission?.messageId,
      inReplyTo: "<parent@example.com>",
      references: ["<grandparent@example.com>", "<parent@example.com>"],
    });
    // The two request fields that mean something to the ledger and nothing to
    // the wire. A loose match cannot see them arrive, and each one arriving
    // would be a real change in behaviour: `discardDraftId` would make the send
    // depend on a local draft, and a token list would make it carry files it was
    // never asked for.
    expect(wire).not.toHaveProperty("attachmentTokens");
    expect(wire).not.toHaveProperty("discardDraftId");
    expect(wire.attachments).toEqual([]);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
    expect(verified).toEqual([world.submissionId]);
    // The deciding attempt counted, and the arithmetic closes: 1 = 1 + 0.
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", total: 1, updated: 1, failed: 0 });
  });

  it("attempts a failed submission again, which is what the manual retry relies on", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // The state the interactive route leaves behind after a diagnosable failure.
    setLedger(db, world.submissionId, "failed", "smtp_auth_failed");

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
  });

  it("does not send a second copy of a submitted or confirmed submission", async () => {
    for (const status of ["submitted", "confirmed"]) {
      const world = fixture();
      db = world.db;
      const taskId = sendTask(db, world.submissionId);
      setLedger(db, world.submissionId, status);

      expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

      expect(sendMail).not.toHaveBeenCalled();
      expect(ledgerStatus(db, world.submissionId)).toBe(status);
      // Counted, and that is the remainder rule rather than a claim about who
      // sent it: this task's unit of work IS done -- by another attempt (whose
      // count is on that attempt's own row) or by an earlier run of this task
      // that died between recording the send and counting it. Reporting the
      // remainder is what closes the second shape; reporting nothing would leave
      // a task whose work is finished sitting at 0/1 forever.
      expect(taskRow(db, taskId)).toMatchObject({ total: 1, updated: 1, failed: 0 });
      db.close();
      vi.clearAllMocks();
      sendMail.mockResolvedValue({ messageId: "<provider-id@example.com>" });
    }
  });

  it("waits out a fresh submitting submission instead of starting a second SMTP attempt", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    setLedger(db, world.submissionId, "submitting");

    const deltas: Deltas = [];
    const thrown = await attempt(depsFor(db), taskId, deltas);
    expect(thrown).toBeInstanceOf(Error);
    // Not a TaskAbortError: the scheduler must retry it, because the claim this
    // status describes is exactly the one this attempt did not make.
    expect((thrown as Error).name).not.toBe("TaskAbortError");
    expect(sendMail).not.toHaveBeenCalled();
    expect(deltas).toEqual([]);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitting");

    // Spelled out through the ladder: with the attempt budget spent it ends
    // failed, still without ever touching the socket. That is acceptable here
    // because the claim is fresh -- its owner is the one that will record the
    // outcome -- so the task's failure is not the mail's last word.
    expect(await drain(depsFor(db), taskId, { maxAttempts: 1 })).toEqual([{ id: taskId, status: "failed" }]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("converts a stale submitting claim to unknown_delivery instead of failing the task", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // Older than the scheduler's run timeout plus the retry ceiling: no live
    // executor can still own this claim, so waiting cannot learn anything new.
    db.prepare("UPDATE outbound_submissions SET status = 'submitting', updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), world.submissionId);

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "unknown_delivery" }]);

    // The truthful verdict: the attempt vanished without recording an outcome,
    // and the mail may have left. `failed` would invite a resend.
    expect(sendMail).not.toHaveBeenCalled();
    expect(ledgerStatus(db, world.submissionId)).toBe("unknown_delivery");
    expect(ledgerError(db, world.submissionId).error_code).toBe("submission_interrupted");
    expect(taskRow(db, taskId)).toMatchObject({ status: "unknown_delivery", total: 1, updated: 0, failed: 1 });
  });

  it("turns its own SMTP timeout into unknown_delivery before the scheduler abandons the run", async () => {
    vi.useFakeTimers();
    try {
      const world = fixture();
      db = world.db;
      const taskId = sendTask(db, world.submissionId);
      // A socket that never answers. The runner must not wait for the scheduler's
      // timeout, because the scheduler leaves the ledger `submitting` when it gives
      // up on a runner it cannot cancel.
      sendMail.mockImplementation(() => new Promise(() => {}));

      const deltas: Deltas = [];
      const pending = attempt(depsFor(db), taskId, deltas);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TASK_RUN_TIMEOUT_MS);

      const thrown = await pending;
      expect(thrown).toMatchObject({ name: "TaskAbortError", status: "unknown_delivery", code: "smtp_attempt_unconfirmed" });
      expect(deltas).toEqual([{ failed: 1 }]);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(ledgerStatus(db, world.submissionId)).toBe("unknown_delivery");
      // Not a code the renderer classifies as a retryable timeout: the mail may
      // already be out, so the advice must be "check Sent", not "try again".
      expect(ledgerError(db, world.submissionId).error_code).toBe("smtp_attempt_unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles its own verdict while the scheduler is still waiting, not after it gives up", async () => {
    vi.useFakeTimers();
    try {
      const world = fixture();
      db = world.db;
      const taskId = sendTask(db, world.submissionId);
      sendMail.mockImplementation(() => new Promise(() => {}));

      // The real scheduler owns this run, so its 300s abandonment timer is live
      // too. The runner's deadline sits inside that budget; if the internal
      // timeout were removed (or placed past 300s), the scheduler would abandon
      // attempt one and the task would settle on a retry instead of on the
      // runner's own verdict. The size of the 10s reserve is not observable here
      // -- both timers writing at the same instant still leave one attempt --
      // so this pins the ordering, not the margin.
      const pending = drain(depsFor(db), taskId);
      await vi.advanceTimersByTimeAsync(TASK_RUN_TIMEOUT_MS);

      expect(await pending).toEqual([{ id: taskId, status: "unknown_delivery" }]);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(ledgerStatus(db, world.submissionId)).toBe("unknown_delivery");
      // One attempt: the runner settled the row itself rather than letting the
      // scheduler's timeout turn this into a retry.
      expect(taskRow(db, taskId)).toMatchObject({ status: "unknown_delivery", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a second executor while the first owns the claim", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    let finish: (result: { messageId: string }) => void = () => undefined;
    sendMail.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    // The first attempt is suspended inside the socket, so the ledger reads
    // `submitting`. The second one must back off and touch nothing: the live
    // owner is the only attempt allowed to decide this mail's outcome.
    const first = attempt(depsFor(db), taskId, []);
    const second = await attempt(depsFor(db), taskId, []);
    expect(second).toMatchObject({ message: expect.stringContaining("already owned by another attempt") });
    expect(ledgerStatus(db, world.submissionId)).toBe("submitting");

    finish({ messageId: "<provider-id@example.com>" });
    expect(await first).toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
  });

  it("ends an unknown_delivery submission terminally, without touching the socket", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    setLedger(db, world.submissionId, "unknown_delivery", "submission_interrupted");

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "unknown_delivery" }]);

    // The whole point of the status: the mail may have left, so a second attempt
    // could deliver it twice.
    expect(sendMail).not.toHaveBeenCalled();
    expect(ledgerStatus(db, world.submissionId)).toBe("unknown_delivery");
    // This is a terminal decision, so it is counted -- the attempt that produced
    // the state (or the startup recovery pass, which is not a task at all) never
    // got to.
    expect(taskRow(db, taskId)).toMatchObject({ status: "unknown_delivery", total: 1, updated: 0, failed: 1, error_code: "submission_interrupted" });
  });
});

describe("task send runner: what each failure means", () => {
  it("fails terminally and truthfully when an attachment can no longer be resolved", async () => {
    const world = fixture({ attachmentTokens: ["not-a-real-token"] });
    db = world.db;
    const taskId = sendTask(db, world.submissionId);

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "failed" }]);

    // Never `unknown_delivery`, and never a reason to send without the file:
    // nothing was transferred, so this is diagnosable rather than ambiguous.
    expect(sendMail).not.toHaveBeenCalled();
    expect(ledgerStatus(db, world.submissionId)).toBe("failed");
    expect(ledgerError(db, world.submissionId)).toEqual({ error_code: "attachment_unavailable" });
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "attachment_unavailable", total: 1, updated: 0, failed: 1, attempt_count: 1 });
  });

  it("retries a known pre-acceptance failure named by its mail error code", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // `smtp_auth_failed` is on `isKnownPreAcceptanceFailure`'s list: the mail
    // never transferred, so a retry cannot duplicate it.
    sendMail.mockRejectedValueOnce(smtpFailure({ code: "smtp_auth_failed" }));

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", attempt_count: 2, total: 1, updated: 1, failed: 0 });
    // The failed first attempt was recorded as truthful, then overwritten by the
    // success -- the ledger is not left claiming a failure the retry disproved.
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
  });

  it("retries a pre-acceptance failure named only by the SMTP command", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // No useful code: the classification has to come from the command the server
    // rejected, which is the second half of `isKnownPreAcceptanceFailure`.
    sendMail.mockRejectedValueOnce(smtpFailure({ code: "unknown", command: "DATA" }));

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", attempt_count: 2, updated: 1, failed: 0 });
  });

  it("ends an ambiguous SMTP failure as unknown_delivery rather than retrying it", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    sendMail.mockRejectedValue(smtpFailure({ code: "timeout" }));

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "unknown_delivery" }]);

    // Exactly one attempt: the mail may have been accepted just before the
    // connection went away, so the ladder must not try again.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("unknown_delivery");
    expect(ledgerError(db, world.submissionId)).toEqual({ error_code: "timeout" });
    expect(taskRow(db, taskId)).toMatchObject({ status: "unknown_delivery", total: 1, updated: 0, failed: 1 });
  });

  it("treats a CONN failure as ambiguous, which is why that command is excluded", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // A socket timeout or reset is reported under `CONN` even when the final
    // delivery response was lost, so the command list must not claim this one
    // was never transferred.
    sendMail.mockRejectedValue(smtpFailure({ code: "unknown", command: "CONN" }));

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "unknown_delivery" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("keeps the delivery verdict when the draft cleanup fails", async () => {
    const world = fixture({ discardDraftId: "draft-that-no-longer-exists" });
    db = world.db;
    const taskId = sendTask(db, world.submissionId);

    expect(await drain(depsFor(db, { agentEvents: undefined }), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    // SMTP accepted the message; a draft that cannot be discarded is the next
    // sync's business and must not change the terminal delivery status.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", updated: 1, failed: 0 });
  });

  it("fails terminally when the attachment's stored bytes no longer open", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-send-"));
    db = openDatabase(":memory:");
    insertAccount(db);
    const attachment = createOutboundAttachment(db, directory, MASTER_KEY, {
      accountId: ACCOUNT,
      filename: "report.pdf",
      contentType: "application/pdf",
      content: Buffer.from("quarterly numbers"),
    });
    const { submission } = prepareSubmission(db, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      request: { to: ["friend@example.com"], subject: "Hello", text: "Body", attachmentTokens: [attachment.token] },
    });
    const taskId = sendTask(db, submission.id);
    // Same length, so the record's size guard passes and the failure lands
    // exactly where the classification matters: the cipher cannot open the file,
    // and nothing else can tell. This is the case the single-try legacy shape
    // answered as "the mail may be out, check Sent" for a mail that never left.
    const root = fs.realpathSync(directory);
    const [stored] = fs.readdirSync(root);
    const filePath = path.resolve(root, stored as string);
    if (!filePath.startsWith(root + path.sep)) throw new Error("The attachment store wrote outside its own directory.");
    fs.writeFileSync(filePath, Buffer.alloc(fs.statSync(filePath).size));

    try {
      expect(await drain(depsFor(db, { outboundAttachmentDirectory: directory }), taskId)).toEqual([{ id: taskId, status: "failed" }]);

      expect(sendMail).not.toHaveBeenCalled();
      expect(ledgerStatus(db, submission.id)).toBe("failed");
      expect(ledgerError(db, submission.id)).toEqual({ error_code: "attachment_unavailable" });
      expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "attachment_unavailable", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ends terminally when the ledger's sealed payload cannot be opened", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // Deterministic: it will not decrypt on attempt two either, so this must be
    // answered once instead of spending eight attempts and ten minutes on it.
    // The read that meets it is `submissionForId`, which decrypts to build the
    // shape a renderer renders -- so the guard has to wrap that read, not just
    // the request read that follows it.
    db.prepare("UPDATE outbound_submissions SET request_json = ? WHERE id = ?").run("nami-v1.not-an-envelope", world.submissionId);

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "failed" }]);

    const row = taskRow(db, taskId) as TaskRow;
    expect(row).toMatchObject({ status: "failed", error_code: "unreadable_submission", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    // Not a delivery verdict either: this attempt never claimed the ledger, so the
    // row keeps the status it had. `submitting` describes a send attempt, and
    // there was none.
    expect(ledgerStatus(db, world.submissionId)).toBe("pending");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("records a retryable failure on the task row, and the successful retry clears it", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    const seen: Array<{ status: string; error_code: string | null; error_message: string | null }> = [];
    // Read from inside the socket call: that is the only moment the row is both
    // mid-ladder and observable, because the successful attempt's settle is what
    // clears the trace.
    sendMail.mockImplementation(async () => {
      const row = taskRow(db, taskId) as TaskRow;
      seen.push({ status: row.status, error_code: row.error_code, error_message: row.error_message });
      if (seen.length === 1) throw smtpFailure({ code: "smtp_auth_failed" });
      return { messageId: "<provider-id@example.com>" };
    });

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    expect(seen).toEqual([
      { status: "running", error_code: null, error_message: null },
      // The attempt that failed reported no counts -- the attempt that decides is
      // the attempt that counts -- so this write at release time is the only
      // trace the ladder leaves. Without it, "the connection keeps dropping" is
      // invisible until the budget runs out.
      //
      // The text is our own advice for the code, not the transport's
      // `"smtp failure"` (contract §十七 (9)): this column is renderable --
      // `taskProgress` and the batch snapshot both read it -- so the raw message
      // cannot land here, while the code stays ours rather than the transport's
      // spelling. The provider's credential hint is part of the sentence, and
      // spelling the whole thing out is what makes a dropped hint (a silent
      // downgrade to the generic wording) a failure rather than a shrug.
      {
        status: "running",
        error_code: "smtp_auth_failed",
        error_message: "发件服务器拒绝了登录凭据。 使用该邮箱服务商提供的密码或客户端授权码",
      },
    ]);
    // On a terminal row the pair is the verdict, not the history: the settle that
    // recorded `completed` cleared it.
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", error_code: null, error_message: null, updated: 1, failed: 0 });
  });

  it("does not count the same unit twice when a resumed attempt meets a sent submission", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // The shape a crash between recording the send and counting it leaves behind.
    setLedger(db, world.submissionId, "submitted");
    reportTaskProgress(db, taskId, { updated: 1 }, Date.now());

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    // `report` adds, so an unconditional report of the unit would leave the row
    // at 2/1 -- a count no consumer can read as anything. The remainder is what
    // keeps the replay of an already-counted task at exactly the unit.
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", total: 1, updated: 1, failed: 0 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("keeps a sent mail's task completed when recording the send fails", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // A real failing write, injected where the failure lives rather than by
    // mocking the ledger away: this is the window between SMTP accepting the mail
    // and the ledger saying so.
    db.prepare("CREATE TRIGGER zz_refuse_submitted BEFORE UPDATE OF status ON outbound_submissions WHEN NEW.status = 'submitted' BEGIN SELECT RAISE(ABORT, 'ledger write refused'); END").run();

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "completed" }]);

    // Exactly one SMTP call. The mail went out, so the task must not end `failed`:
    // `failed` is the one terminal status that asks the settle hook to put things
    // back, and that hook retracts the optimistic Sent row -- the version of this
    // failure that hides a message the transport accepted. The ledger is moved to
    // `unknown_delivery` instead -- the confirmable, non-retryable state -- so
    // verification can still find the mail and no automatic retry resends it. If
    // that write fails too, startup recovery converts the `submitting` row.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("unknown_delivery");
    expect(ledgerError(db, world.submissionId).error_code).toBe("submission_record_failed");
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", attempt_count: 1, total: 1, updated: 1, failed: 0 });
  });
});

describe("task send runner: rows it cannot execute", () => {
  it("fails a task with no submission id on the first sighting", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, undefined);

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "failed" }]);

    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "no_submission", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("fails a task whose ledger row was deleted, because the delete nulls its submission id", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    db.prepare("DELETE FROM outbound_submissions WHERE id = ?").run(world.submissionId);

    // This is the shape a real deletion produces: the foreign key is ON
    // (`db.ts:79`), so `ON DELETE SET NULL` clears the column and the runner
    // meets a task with no submission id -- the first test's branch, reached by
    // a different route. The message is asserted because the code alone cannot
    // tell the two apart.
    expect(taskRow(db, taskId)).toMatchObject({ submission_id: null });

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "failed" }]);

    // No attempt can produce the row again, so the eight backoff rounds the
    // legacy queue would have spent on it buy nothing.
    const row = taskRow(db, taskId) as TaskRow;
    expect(row).toMatchObject({ status: "failed", error_code: "no_submission", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    expect(row.error_message).toContain("carries no submission id");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("fails a task holding a submission id that is not in the ledger", async () => {
    const world = fixture();
    db = world.db;
    const taskId = sendTask(db, world.submissionId);
    // The `!submission` guard is reachable only where the reference does not
    // hold: a database created with the constraint off, a row pruned by a path
    // that did not cascade, an id written by an older build. Taking the
    // constraint out of the way is how the test reaches it at all -- with the
    // constraint ON, this same delete nulls the column and lands in the branch
    // above, which is why the two are pinned separately.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM outbound_submissions WHERE id = ?").run(world.submissionId);
    db.pragma("foreign_keys = ON");
    expect(taskRow(db, taskId)).toMatchObject({ submission_id: world.submissionId });

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "failed" }]);

    const row = taskRow(db, taskId) as TaskRow;
    expect(row).toMatchObject({ status: "failed", error_code: "no_submission", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    expect(row.error_message).toContain(`No outbound submission "${world.submissionId}"`);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("fails a task whose ledger row belongs to another account", async () => {
    const world = fixture();
    db = world.db;
    insertAccount(db, "acc-2", "second@example.com");
    const taskId = sendTask(db, world.submissionId, { accountId: "acc-2" });

    expect(await drain(depsFor(db), taskId)).toEqual([{ id: taskId, status: "failed" }]);

    const row = taskRow(db, taskId) as TaskRow;
    expect(row).toMatchObject({ status: "failed", error_code: "account_mismatch", attempt_count: 1, total: 1, updated: 0, failed: 1 });
    // The credentials that would be spent are the ledger's; the FIFO chain, the
    // write slots and the retry budget are the task's. Sending under a mismatch
    // would spend one account's credentials on another account's queue, so the
    // only safe answer is to stop and let the recording bug surface.
    expect(sendMail).not.toHaveBeenCalled();
    expect(ledgerStatus(db, world.submissionId)).toBe("pending");
  });
});

describe("task send acceptance from an already-prepared submission", () => {
  const acceptDeps = (target: DatabaseHandle) => ({
    db: target,
    masterKey: MASTER_KEY,
    scheduler: { start: () => undefined },
  });

  const account = (target: DatabaseHandle): AccountRecord =>
    target.prepare("SELECT * FROM accounts WHERE id = ?").get(ACCOUNT) as AccountRecord;

  const pendingSentRows = (target: DatabaseHandle, submissionId: string): number =>
    (target.prepare("SELECT COUNT(*) AS n FROM messages WHERE pending_send = ?").get(submissionId) as { n: number }).n;

  const taskCount = (target: DatabaseHandle, submissionId: string): number =>
    (target.prepare("SELECT COUNT(*) AS n FROM tasks WHERE submission_id = ?").get(submissionId) as { n: number }).n;

  /** `writePendingSentRow` no-ops without a Sent mailbox, so every row assertion needs one. */
  const addSentFolder = (target: DatabaseHandle): void => {
    target.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
      .run(ACCOUNT, "Sent", "Sent", "\\Sent");
  };

  it("commits the optimistic Sent row and a task keyed by the submission, then sends it", async () => {
    const world = fixture();
    db = world.db;
    addSentFolder(db);

    const accepted = acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });

    expect(accepted).toMatchObject({ created: true, taskId: world.submissionId });
    // The key is the submission id, so this lane and the interactive route's
    // cannot produce two dispatches for one ledger row.
    expect(taskRow(db, world.submissionId)).toMatchObject({ kind: "send", status: "pending", due_at: null, total: 1 });
    expect(pendingSentRows(db, world.submissionId)).toBe(1);
    // Nothing has touched the socket: this is the acceptance's whole promise.
    expect(sendMail).not.toHaveBeenCalled();

    expect(await drain(depsFor(db), world.submissionId)).toEqual([{ id: world.submissionId, status: "completed" }]);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
  });

  it("answers a replay without committing a second task or Sent row", () => {
    const world = fixture();
    db = world.db;
    addSentFolder(db);

    const first = acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });
    const second = acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });

    expect(second).toMatchObject({ created: false, taskId: first.taskId });
    expect(taskCount(db, world.submissionId)).toBe(1);
    expect(pendingSentRows(db, world.submissionId)).toBe(1);
  });

  it("commits nothing once the ledger has reached a terminal status", () => {
    for (const status of ["submitted", "confirmed", "unknown_delivery", "submitting"]) {
      const world = fixture();
      db = world.db;
      addSentFolder(db);
      setLedger(db, world.submissionId, status);

      const accepted = acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });

      expect(accepted).toMatchObject({ created: false, taskId: null });
      expect(taskCount(db, world.submissionId)).toBe(0);
      expect(pendingSentRows(db, world.submissionId)).toBe(0);
      db.close();
      vi.clearAllMocks();
      sendMail.mockResolvedValue({ messageId: "<provider-id@example.com>" });
    }
  });

  it("accepts a definitively failed submission, because that is what a retry is for", async () => {
    const world = fixture();
    db = world.db;
    setLedger(db, world.submissionId, "failed", "smtp_auth_failed");

    const accepted = acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });
    expect(accepted.created).toBe(true);

    expect(await drain(depsFor(db), world.submissionId)).toEqual([{ id: world.submissionId, status: "completed" }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ledgerStatus(db, world.submissionId)).toBe("submitted");
  });

  it("parks a scheduled submission without an optimistic Sent row", () => {
    const db2 = openDatabase(":memory:");
    db = db2;
    insertAccount(db2);
    addSentFolder(db2);
    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const { submission } = prepareSubmission(db2, MASTER_KEY, {
      accountId: ACCOUNT,
      accountEmail: ACCOUNT_EMAIL,
      request: { to: ["friend@example.com"], subject: "Later", text: "Body", attachmentTokens: [] },
      sendAt,
    });

    acceptPreparedSendTask(acceptDeps(db2), { account: account(db2), submissionId: submission.id });

    expect(taskRow(db2, submission.id)?.due_at).toBe(Date.parse(sendAt));
    // The mail has not left, so a Sent row now would be a false claim.
    expect(pendingSentRows(db2, submission.id)).toBe(0);
  });

  it("does not append a second Sent row when one already stands for the submission", () => {
    const world = fixture();
    db = world.db;
    addSentFolder(db);
    acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });
    // The task is gone (pruned, or a database written before this acceptance
    // existed) but its Sent row is still the claim the user was shown.
    db.prepare("DELETE FROM tasks WHERE submission_id = ?").run(world.submissionId);

    const accepted = acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: world.submissionId });

    expect(accepted.created).toBe(true);
    expect(pendingSentRows(db, world.submissionId)).toBe(1);
  });

  it("refuses a submission that belongs to another account", () => {
    const world = fixture();
    db = world.db;
    insertAccount(db, "acc-2", "second@example.com");

    expect(() => acceptPreparedSendTask(acceptDeps(db), { account: account(db), submissionId: "missing" }))
      .toThrow('No outbound submission "missing".');
    expect(() => acceptPreparedSendTask(acceptDeps(db), { account: { ...account(db), id: "acc-2" }, submissionId: world.submissionId }))
      .toThrow("belongs to another account");
    expect(taskCount(db, world.submissionId)).toBe(0);
  });
});
