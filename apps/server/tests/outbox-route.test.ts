import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
const { scheduleSentSubmissionVerification } = vi.hoisted(() => ({ scheduleSentSubmissionVerification: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, sendMail };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, scheduleSentSubmissionVerification };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

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

    const first = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      ok: true,
      deliveryStatus: "unknown_delivery",
      submission: { deliveryStatus: "unknown_delivery", errorCode },
    });
    expect(first.body).not.toContain(secret);
    const firstBody = first.json() as { messageId: string; submission: { id: string } };
    expect(scheduleSentSubmissionVerification).toHaveBeenCalledWith(
      db,
      expect.any(Buffer),
      firstBody.submission.id,
      undefined,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal), onDeferred: expect.any(Function) }),
    );

    const duplicate = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({
      messageId: firstBody.messageId,
      deliveryStatus: "unknown_delivery",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const lookup = await app.inject({ method: "GET", url: `/api/submissions/${firstBody.submission.id}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      ok: true,
      submission: { id: firstBody.submission.id, messageId: firstBody.messageId, deliveryStatus: "unknown_delivery" },
    });
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

    const first = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      messageId: string;
      deliveryStatus: string;
      submission: { id: string; subject: string; recipients: string[]; [key: string]: unknown };
    };
    expect(firstBody.deliveryStatus).toBe("submitted");
    expect(firstBody.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(firstBody.submission).toMatchObject({
      subject: "Encrypted status summary",
      recipients: ["recipient-summary-canary@example.com", "cc-summary-canary@example.com"],
    });
    expect(firstBody.submission).not.toHaveProperty("text");
    expect(firstBody.submission).not.toHaveProperty("html");
    expect(first.body).not.toContain("BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    expect(first.body).not.toContain("HTML-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    const stored = JSON.stringify(db.prepare("SELECT * FROM outbound_submissions WHERE id = ?").get(firstBody.submission.id));
    expect(stored).not.toContain("recipient-summary-canary@example.com");
    expect(stored).not.toContain("cc-summary-canary@example.com");
    expect(stored).not.toContain("Encrypted status summary");
    expect(stored).not.toContain("BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "account-1" }),
      expect.any(Buffer),
      expect.objectContaining({ messageId: firstBody.messageId }),
      undefined,
    );
    expect(scheduleSentSubmissionVerification).toHaveBeenCalledWith(
      db,
      expect.any(Buffer),
      firstBody.submission.id,
      undefined,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal), onDeferred: expect.any(Function) }),
    );

    const duplicate = await app.inject({ method: "POST", url: "/api/messages/send", payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      messageId: firstBody.messageId,
      deliveryStatus: "submitted",
      submission: { id: firstBody.submission.id },
    });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const records = await app.inject({ method: "GET", url: "/api/submissions?accountId=account-1" });
    expect(records.statusCode).toBe(200);
    expect(records.json()).toMatchObject({
      items: [expect.objectContaining({
        id: firstBody.submission.id,
        messageId: firstBody.messageId,
        subject: "Encrypted status summary",
        recipients: ["recipient-summary-canary@example.com", "cc-summary-canary@example.com"],
        deliveryStatus: "submitted",
      })],
    });
    expect(records.body).not.toContain("BODY-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
    expect(records.body).not.toContain("HTML-MUST-NOT-APPEAR-IN-OUTBOX-DTO");
  });
});
