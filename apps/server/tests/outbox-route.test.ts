import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";
import type * as syncSentVerifyModule from "../src/sync-sent-verify.js";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
const { scheduleSentSubmissionVerification } = vi.hoisted(() => ({ scheduleSentSubmissionVerification: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, sendMail };
});

vi.mock("../src/sync-sent-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof syncSentVerifyModule>();
  return { ...actual, scheduleSentSubmissionVerification };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { waitForSendTask } from "./helpers/send-settlement.js";

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "account-1", "sender@example.com", "custom", "Demo", "encrypted",
    "imap.example.com", 993, 1, "smtp.example.com", 465, 1,
    "email", "connected", new Date().toISOString(),
  );
}

const messagePayload = {
  accountId: "account-1",
  to: ["recipient@example.com"],
  subject: "Delivery status",
  text: "A durable send request.",
};

describe("outbox send route", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 8) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it.each([
    ["ETIMEDOUT", "socket timed out", "timeout"],
    ["ECONNRESET", "socket hang up", "connection_failed"],
  ])("does not re-send a Nodemailer %s CONN failure whose delivery result is unknown", async (code, message, errorCode) => {
    const secret = "do-not-persist-this-secret";
    sendMail.mockRejectedValueOnce(Object.assign(new Error(`${message} password=${secret}`), { code, command: "CONN" }));
    const payload = { ...messagePayload, idempotencyKey: `sub_${code.toLowerCase()}_once` };

    // The acceptance transfers nothing, so it answers with a durable pending
    // record and the id of the task that will own the socket.
    const accepted = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = accepted.json() as { messageId: string; taskId?: string; submission: { id: string } };
    expect(acceptedBody).toMatchObject({ ok: true, deliveryStatus: "pending", status: "pending" });
    expect(acceptedBody.taskId).toBeTruthy();
    expect(accepted.body).not.toContain(secret);

    // A CONN failure is deliberately outside the pre-acceptance list: the socket
    // dropped in a way that is indistinguishable from a lost final response, so
    // the mail may already be out. That makes the attempt terminal -- a retry
    // could deliver it twice -- which is exactly why this status exists.
    await expect(waitForSendTask(db, acceptedBody.taskId!)).resolves.toEqual({ status: "unknown_delivery", errorCode });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const lookup = await app.inject({ method: "GET", url: `/api/submissions/${acceptedBody.submission.id}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      ok: true,
      submission: { id: acceptedBody.submission.id, messageId: acceptedBody.messageId, deliveryStatus: "unknown_delivery", errorCode },
    });
    // The raw SMTP text never reaches the durable record, so a status read can
    // never spill a credential.
    expect(lookup.body).not.toContain(secret);

    // The duplicate must not become a second email: the terminal status is the
    // answer, and the verifier is armed so the user's "check Sent" can finish.
    const duplicate = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({
      messageId: acceptedBody.messageId,
      deliveryStatus: "unknown_delivery",
    });
    expect(duplicate.body).not.toContain(secret);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(scheduleSentSubmissionVerification).toHaveBeenCalledWith(
      db,
      expect.any(Buffer),
      acceptedBody.submission.id,
      undefined,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal), onDeferred: expect.any(Function) }),
    );
    const stored = JSON.stringify(db.prepare("SELECT * FROM outbound_submissions WHERE id = ?").get(acceptedBody.submission.id));
    expect(stored).not.toContain(secret);
  });

  it("uses the durable RFC Message-ID for SMTP and returns the accepted record on a duplicate POST", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "<provider-accepted@example.test>" });
    const payload = {
      ...messagePayload,
      to: ["recipient-summary-canary@example.com"],
      cc: ["cc-summary-canary@example.com"],
      subject: "Encrypted status summary",
      text: "BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO",
      html: "<p>HTML-MUST-NOT-APPEAR-IN-OUTBOX-DTO</p>",
      idempotencyKey: "sub_accepted_once",
    };

    const accepted = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = accepted.json() as {
      messageId: string;
      taskId?: string;
      deliveryStatus: string;
      submission: { id: string; subject: string; recipients: string[]; [key: string]: unknown };
    };
    expect(acceptedBody).toMatchObject({ deliveryStatus: "pending", status: "pending" });
    expect(acceptedBody.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(acceptedBody.submission).toMatchObject({
      subject: "Encrypted status summary",
      recipients: ["recipient-summary-canary@example.com", "cc-summary-canary@example.com"],
    });
    expect(acceptedBody.submission).not.toHaveProperty("text");
    expect(acceptedBody.submission).not.toHaveProperty("html");
    expect(accepted.body).not.toContain("BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    expect(accepted.body).not.toContain("HTML-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    const stored = JSON.stringify(db.prepare("SELECT * FROM outbound_submissions WHERE id = ?").get(acceptedBody.submission.id));
    expect(stored).not.toContain("recipient-summary-canary@example.com");
    expect(stored).not.toContain("cc-summary-canary@example.com");
    expect(stored).not.toContain("Encrypted status summary");
    expect(stored).not.toContain("BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO");

    // The task is what hands the mail to SMTP, and the id it hands over is the
    // one the acceptance had already committed -- the whole point of the durable
    // Message-ID: the Sent copy the provider stores is findable by it later.
    await expect(waitForSendTask(db, acceptedBody.taskId!)).resolves.toEqual({ status: "completed", errorCode: null });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "account-1" }),
      expect.any(Buffer),
      expect.objectContaining({ messageId: acceptedBody.messageId }),
      undefined,
    );
    expect(scheduleSentSubmissionVerification).toHaveBeenCalledWith(
      db,
      expect.any(Buffer),
      acceptedBody.submission.id,
      undefined,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal), onDeferred: expect.any(Function) }),
    );

    const duplicate = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      messageId: acceptedBody.messageId,
      deliveryStatus: "submitted",
      submission: { id: acceptedBody.submission.id },
    });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const records = await app.inject({ method: "GET", url: "/api/submissions?accountId=account-1" });
    expect(records.statusCode).toBe(200);
    expect(records.json()).toMatchObject({
      items: [expect.objectContaining({
        id: acceptedBody.submission.id,
        messageId: acceptedBody.messageId,
        subject: "Encrypted status summary",
        recipients: ["recipient-summary-canary@example.com", "cc-summary-canary@example.com"],
        deliveryStatus: "submitted",
      })],
    });
    expect(records.body).not.toContain("BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    expect(records.body).not.toContain("HTML-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
  });
});

