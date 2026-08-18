import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { encryptAccountPassword } from "../src/account-credentials.js";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  deletePendingScheduledSubmission,
  prepareSubmission,
  submissionForId,
} from "../src/outbox.js";
import { submitDueScheduledSubmissions } from "../src/scheduled-send.js";
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

function insertAccount(db: DatabaseHandle, key: Buffer): void {
  const account = accountRow(key);
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

  beforeEach(async () => {
    vi.clearAllMocks();
    createTransport.mockReturnValue({ sendMail: send, close });
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
    routeDb = openDatabase(":memory:");
    app = await buildApp({ db: routeDb, masterKey: Buffer.alloc(32, 7) });
    insertAccount(routeDb, Buffer.alloc(32, 7));
  });

  afterEach(async () => {
    await app.close();
    routeDb.close();
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
});
