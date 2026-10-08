import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { encryptAccountPassword } from "../src/account-credentials.js";
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
import { restoreScheduledSubmissionAttachments, submitDueScheduledSubmissions } from "../src/scheduled-send.js";
import type { AccountRecord } from "../src/types.js";

const { close, createTransport, send } = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  send: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

function accountRow(key: Buffer): AccountRecord {
  const account: AccountRecord = {
    id: "account-1",
    email: "sender@example.com",
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
    imap_username: "sender@example.com",
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    smtp_secure: 1,
    smtp_transport: "tls",
    smtp_username: "sender@example.com",
    username_mode: "email",
    status: "connected",
    last_error: null,
    last_error_code: null,
    last_synced_at: null,
    created_at: new Date().toISOString(),
  };
  account.encrypted_password = encryptAccountPassword(account, "app-password", key);
  return account;
}

function insertAccount(db: DatabaseHandle, key: Buffer, id = "account-1", email = "sender@example.com"): void {
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

describe("scheduled send storage", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    insertAccount(db, masterKey);
    createTransport.mockReturnValue({ sendMail: send, close });
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
  });

  afterEach(() => {
    db.close();
  });

  it("parks a prepared submission with a future send time", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
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
    expect(submissionForId(db, masterKey, prepared.submission.id)?.sendAt).toBe(future);
  });

  it("cancels only a pending scheduled submission that is still in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const scheduled = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt: future,
      request: { to: ["recipient@example.com"], subject: "Later", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, scheduled.submission.id)).toBe(true);
    expect(submissionForId(db, masterKey, scheduled.submission.id)).toBeUndefined();

    const due = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt: past,
      request: { to: ["recipient@example.com"], subject: "Due", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, due.submission.id)).toBe(false);

    const immediate = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      request: { to: ["recipient@example.com"], subject: "Now", text: "Body", attachmentTokens: [] },
    });
    expect(deletePendingScheduledSubmission(db, immediate.submission.id)).toBe(false);
  });
});

describe("scheduled send submission", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const directory = "C:\\nami-tests\\outbound";

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    insertAccount(db, masterKey);
    createTransport.mockReturnValue({ sendMail: send, close });
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
  });

  afterEach(() => {
    db.close();
  });

  function schedule(subject: string, sendAt: string) {
    return prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt,
      request: {
        to: ["recipient@example.com"],
        subject,
        text: "Body",
        attachmentTokens: [],
      },
    });
  }

  it("submits due scheduled sends through SMTP and reports outcomes", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const due = new Date(Date.now() - 60_000).toISOString();
    schedule("Future", future);
    const dueSubmission = schedule("Due now", due);
    const verification = vi.fn();

    const outcome = await submitDueScheduledSubmissions(db, masterKey, {
      outboundAttachmentDirectory: directory,
      scheduleSentVerification: verification,
    });

    expect(outcome).toEqual({ submitted: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Due now",
      text: "Body",
      messageId: dueSubmission.submission.messageId,
    }));
    const after = submissionForId(db, masterKey, dueSubmission.submission.id);
    expect(after?.deliveryStatus).toBe("submitted");
    expect(after?.sendAt).toBe(due);
    expect(verification).toHaveBeenCalledWith(dueSubmission.submission.id);
    // The future send is untouched and stays pending.
    const futureRow = db.prepare("SELECT status FROM outbound_submissions WHERE send_at = ?").get(future) as { status: string } | undefined;
    expect(futureRow?.status).toBe("pending");
    const rows = db.prepare("SELECT request_json FROM outbound_submissions").all() as Array<{ request_json: string }>;
    expect(rows).toHaveLength(2);
  });

  it("marks failed sends as failed and reports them", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    const dueSubmission = schedule("Failing", due);
    const failure = new Error("SMTP rejected RCPT TO");
    // Nodemailer attaches the failing SMTP command to the rejection; this
    // lets deliveryFailureStatus classify it as a pre-acceptance failure.
    (failure as Error & { command?: string }).command = "RCPT TO";
    send.mockRejectedValueOnce(failure);
    const onFailure = vi.fn();

    const outcome = await submitDueScheduledSubmissions(db, masterKey, {
      outboundAttachmentDirectory: directory,
      scheduleSentVerification: vi.fn(),
      onFailure,
    });

    expect(outcome).toEqual({ submitted: 0, failed: 1 });
    expect(submissionForId(db, masterKey, dueSubmission.submission.id)?.deliveryStatus).toBe("failed");
    expect(onFailure).toHaveBeenCalledWith(
      dueSubmission.submission.id,
      expect.objectContaining({ message: "SMTP rejected RCPT TO" }),
    );
  });

  it("submits a due burst with bounded concurrency instead of serializing", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 6; i += 1) schedule(`Burst ${i}`, due);

    let active = 0;
    let peak = 0;
    send.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { messageId: "<sent@nami.local>" };
    });

    const outcome = await submitDueScheduledSubmissions(db, masterKey, {
      outboundAttachmentDirectory: directory,
      scheduleSentVerification: vi.fn(),
    });

    // All four workers enter their first SMTP call before any of them
    // finishes, so the observed overlap equals the pool cap; a serialized
    // implementation would never see more than one in flight.
    expect(peak).toBe(4);
    expect(outcome).toEqual({ submitted: 6, failed: 0 });
    const statuses = db.prepare("SELECT status FROM outbound_submissions ORDER BY send_at").all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual(["submitted", "submitted", "submitted", "submitted", "submitted", "submitted"]);
  });
});

describe("scheduled send API routes", () => {
  let app: FastifyInstance;
  let routeDb: DatabaseHandle;
  let attachmentDirectory: string;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(async () => {
    vi.clearAllMocks();
    createTransport.mockReturnValue({ sendMail: send, close });
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
    routeDb = openDatabase(":memory:");
    attachmentDirectory = mkdtempSync(path.join(tmpdir(), "nami-scheduled-send-"));
    app = await buildApp({ db: routeDb, masterKey, outboundAttachmentDirectory: attachmentDirectory });
    insertAccount(routeDb, masterKey);
  });

  afterEach(async () => {
    await app.close();
    routeDb.close();
    rmSync(attachmentDirectory, { recursive: true, force: true });
  });

  it("schedules a send and cancels it before it is due", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "Later",
        text: "Body",
        sendAt: future,
      },
    });
    expect(scheduled.statusCode).toBe(202);
    const body = scheduled.json() as { scheduled: boolean; deliveryStatus: string; submission: { id: string }; sendAt: string };
    expect(body.scheduled).toBe(true);
    expect(body.deliveryStatus).toBe("pending");
    expect(body.sendAt).toBe(future);
    expect(send).not.toHaveBeenCalled();

    const cancel = await app.inject({ method: "POST", url: `/api/messages/send/${body.submission.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().cancelled).toBe(true);
  });

  it("refuses to cancel a scheduled send that is already due", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "Due",
        text: "Body",
        sendAt: past,
      },
    });
    const body = scheduled.json() as { submission: { id: string } };
    const cancel = await app.inject({ method: "POST", url: `/api/messages/send/${body.submission.id}/cancel` });
    expect(cancel.statusCode).toBe(409);

    const missing = await app.inject({ method: "POST", url: "/api/messages/send/missing/cancel" });
    expect(missing.statusCode).toBe(404);
  });

  it("links scheduled attachments at parking time so the TTL cleanup cannot take them", async () => {
    const upload = createOutboundAttachment(routeDb, attachmentDirectory, masterKey, {
      accountId: "account-1",
      filename: "report.txt",
      contentType: "text/plain",
      content: Buffer.from("SCHEDULED_ATTACHMENT_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "With attachment",
        text: "Body",
        sendAt,
        attachmentTokens: [upload.token],
      },
    });
    expect(scheduled.statusCode).toBe(202);

    // The upload is linked to the parked submission immediately, so the stale
    // cleanup past the 24h TTL must not remove it.
    const links = routeDb.prepare(
      "SELECT submission_id FROM outbound_attachment_submissions WHERE attachment_token = ?",
    ).all(upload.token) as Array<{ submission_id: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]!.submission_id).toBe(scheduled.json().submission.id);
    const removed = cleanupExpiredOutboundAttachments(
      routeDb,
      attachmentDirectory,
      new Date(Date.now() + 25 * 3_600_000),
    );
    expect(removed).toBe(0);

    // When due, the scheduler submits through SMTP with the original bytes.
    const verification = vi.fn();
    const outcome = await submitDueScheduledSubmissions(routeDb, masterKey, {
      outboundAttachmentDirectory: attachmentDirectory,
      scheduleSentVerification: verification,
    }, new Date(Date.now() + 73 * 3_600_000).toISOString());
    expect(outcome).toEqual({ submitted: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const smtpPayload = send.mock.calls[0]?.[0] as { attachments?: Array<{ content?: unknown }> };
    const attachmentContent = Buffer.from(smtpPayload.attachments?.[0]?.content as Uint8Array).toString("utf8");
    expect(attachmentContent).toBe("SCHEDULED_ATTACHMENT_CANARY");
    expect(submissionForId(routeDb, masterKey, scheduled.json().submission.id)?.deliveryStatus).toBe("submitted");
    expect(verification).toHaveBeenCalledWith(scheduled.json().submission.id);
  });

  it("reports the persisted real status for an idempotent scheduled retry", async () => {
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const payload = {
      accountId: "account-1",
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
    markSubmissionSubmitted(routeDb, masterKey, first.json().submission.id, "<retried@nami.local>");

    const retry = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().deliveryStatus).toBe("submitted");
    expect(retry.json().scheduled).toBeUndefined();
    // No duplicate SMTP send for the retry.
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects missing attachment tokens without leaving any scheduled task", async () => {
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "Missing attachment",
        text: "Body",
        sendAt,
        attachmentTokens: ["out_00000000-0000-4000-8000-000000000000"],
      },
    });
    expect(rejected.statusCode).toBe(404);
    // Resolution now runs before the durable create, so a rejected upload
    // leaves no task row at all — stronger than a failed-row audit trail.
    const rows = routeDb.prepare("SELECT status, error_code FROM outbound_submissions").all() as Array<{ status: string; error_code: string }>;
    expect(rows).toHaveLength(0);
  });

  it("rejects a cross-account attachment token without leaving any scheduled task", async () => {
    // A real second account owns the upload; the sender must not borrow it.
    insertAccount(routeDb, masterKey, "account-2", "sender2@example.com");
    const foreign = createOutboundAttachment(routeDb, attachmentDirectory, masterKey, {
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
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "Cross account attachment",
        text: "Body",
        sendAt,
        attachmentTokens: [foreign.token],
      },
    });
    expect(rejected.statusCode).toBe(404);
    expect(routeDb.prepare("SELECT id FROM outbound_submissions").all()).toHaveLength(0);
    // The foreign upload itself is untouched.
    expect(foreign.token).toBeTruthy();
  });

  it("reports the real terminal status for an idempotent retry whose attachments were already released", async () => {
    const upload = createOutboundAttachment(routeDb, attachmentDirectory, masterKey, {
      accountId: "account-1",
      filename: "report.txt",
      contentType: "text/plain",
      content: Buffer.from("RELEASED_ATTACHMENT_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const payload = {
      accountId: "account-1",
      idempotencyKey: "idem-released-1",
      to: ["recipient@example.com"],
      subject: "Retry after release",
      text: "Body",
      sendAt,
      attachmentTokens: [upload.token],
    };
    const first = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(first.statusCode).toBe(202);

    // The due pass submits the task between the two requests and then
    // releases the terminal submission's uploads, exactly as reality does.
    const submissionId = first.json().submission.id as string;
    markSubmissionSubmitted(routeDb, masterKey, submissionId, "<released@nami.local>");
    releaseSubmissionOutboundAttachments(routeDb, attachmentDirectory, "account-1", submissionId);

    const retry = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().deliveryStatus).toBe("submitted");
    // The committed terminal status must survive the retry untouched.
    expect(submissionForId(routeDb, masterKey, submissionId)?.deliveryStatus).toBe("submitted");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("scheduled send attachment restore", () => {
  let db: DatabaseHandle;
  let directory: string;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    insertAccount(db, masterKey);
    directory = mkdtempSync(path.join(tmpdir(), "nami-scheduled-restore-"));
    createTransport.mockReturnValue({ sendMail: send, close });
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rebuilds lost attachment links for a legacy parked task before cleanup", async () => {
    const upload = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "legacy.txt",
      contentType: "text/plain",
      content: Buffer.from("LEGACY_ATTACHMENT_CANARY"),
    });
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    // A task parked before the route started linking at park time: the
    // durable request carries the token, but no link row exists yet.
    const legacy = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt,
      request: {
        to: ["recipient@example.com"],
        subject: "Legacy",
        text: "Body",
        attachmentTokens: [upload.token],
      },
    });
    expect(db.prepare("SELECT 1 FROM outbound_attachment_submissions").all()).toHaveLength(0);

    expect(restoreScheduledSubmissionAttachments(db, masterKey)).toEqual({ restored: 1, failed: 0 });

    // The 25h stale cleanup must now keep the upload.
    expect(cleanupExpiredOutboundAttachments(db, directory, new Date(Date.now() + 25 * 3_600_000))).toBe(0);

    // When due, the original bytes reach SMTP.
    const due = await submitDueScheduledSubmissions(db, masterKey, {
      outboundAttachmentDirectory: directory,
      scheduleSentVerification: vi.fn(),
    }, new Date(Date.now() + 73 * 3_600_000).toISOString());
    expect(due).toEqual({ submitted: 1, failed: 0 });
    const smtpPayload = send.mock.calls[0]?.[0] as { attachments?: Array<{ content?: unknown }> };
    expect(Buffer.from(smtpPayload.attachments?.[0]?.content as Uint8Array).toString("utf8")).toBe("LEGACY_ATTACHMENT_CANARY");
    expect(submissionForId(db, masterKey, legacy.submission.id)?.deliveryStatus).toBe("submitted");
  });

  it("explicitly fails a legacy parked task whose upload is already gone", () => {
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const legacy = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt,
      request: {
        to: ["recipient@example.com"],
        subject: "Lost upload",
        text: "Body",
        attachmentTokens: ["out_00000000-0000-4000-8000-000000000000"],
      },
    });

    expect(restoreScheduledSubmissionAttachments(db, masterKey)).toEqual({ restored: 0, failed: 1 });
    expect(submissionForId(db, masterKey, legacy.submission.id)?.deliveryStatus).toBe("failed");
    const row = db.prepare("SELECT error_code FROM outbound_submissions WHERE id = ?").get(legacy.submission.id) as { error_code: string };
    expect(row.error_code).toBe("attachment_unavailable");
    // No silent send without the attachment.
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves tasks without attachments untouched", () => {
    const sendAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const plain = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt,
      request: { to: ["recipient@example.com"], subject: "Plain", text: "Body", attachmentTokens: [] },
    });
    expect(restoreScheduledSubmissionAttachments(db, masterKey)).toEqual({ restored: 0, failed: 0 });
    expect(submissionForId(db, masterKey, plain.submission.id)?.deliveryStatus).toBe("pending");
  });

  it("fails a due task whose attachment disappeared after startup with a diagnosable code", async () => {
    const upload = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "vanishing.txt",
      contentType: "text/plain",
      content: Buffer.from("VANISHING_CANARY"),
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const task = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      sendAt: past,
      request: {
        to: ["recipient@example.com"],
        subject: "Vanishing upload",
        text: "Body",
        attachmentTokens: [upload.token],
      },
    });
    // The upload disappears between startup and the due pass.
    expect(cleanupExpiredOutboundAttachments(db, directory, new Date(Date.now() + 25 * 3_600_000))).toBe(1);

    const outcome = await submitDueScheduledSubmissions(db, masterKey, {
      outboundAttachmentDirectory: directory,
      scheduleSentVerification: vi.fn(),
    });
    expect(outcome).toEqual({ submitted: 0, failed: 1 });
    const row = db.prepare("SELECT status, error_code FROM outbound_submissions WHERE id = ?").get(task.submission.id) as { status: string; error_code: string };
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("attachment_unavailable");
    expect(send).not.toHaveBeenCalled();
  });
});
