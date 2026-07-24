import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  SubmissionConflictError,
  confirmSubmissionsInSent,
  deliveryFailureStatus,
  markSubmissionSubmitted,
  markSubmissionUnknownDelivery,
  migrateOutboundSubmissionStorage,
  prepareSubmission,
  recoverInterruptedSubmissions,
  setSubmissionPostSubmitWarning,
  startSubmission,
  submissionForId,
  submissionRequestForId,
} from "../src/outbox.js";

const request = {
  to: ["recipient@example.com"],
  subject: "Status update",
  text: "The latest details are attached.",
  attachmentTokens: [],
};
const migrationTestTimeoutMs = 30_000;

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

describe("durable outbound submissions", () => {
  let db: DatabaseHandle;
  let masterKey: Buffer;
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
  });

  afterEach(() => {
    db.close();
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ["ETIMEDOUT", "socket timed out"],
    ["ECONNRESET", "socket hang up"],
  ])("keeps Nodemailer %s CONN failures in the unknown-delivery state", (code, message) => {
    const error = Object.assign(new Error(message), { code, command: "CONN" });
    expect(deliveryFailureStatus(error)).toBe("unknown_delivery");
  });

  it.each([
    Object.assign(new Error("Stored account credential could not be authenticated."), { code: "local_data_invalid" }),
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", command: "CONN" }),
    Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND", command: "CONN" }),
    Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED", command: "CONN" }),
    Object.assign(new Error("Invalid login"), { code: "EAUTH", command: "AUTH" }),
    Object.assign(new Error("Mailbox unavailable"), { responseCode: 550, command: "RCPT TO" }),
  ])("keeps an explicit pre-acceptance failure safely retryable", (error) => {
    expect(deliveryFailureStatus(error)).toBe("failed");
  });

  it("reuses one RFC Message-ID for an idempotent request and never restarts an unknown delivery", () => {
    const first = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_repeatable",
      request,
    });
    expect(first.created).toBe(true);
    expect(first.submission.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);

    expect(startSubmission(db, masterKey, first.submission.id)).toMatchObject({ shouldAttempt: true });
    markSubmissionUnknownDelivery(db, masterKey, first.submission.id, "timeout", "Delivery could not be confirmed.");

    const repeated = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_repeatable",
      request,
    });
    expect(repeated).toMatchObject({ created: false });
    expect(repeated.submission.messageId).toBe(first.submission.messageId);
    expect(startSubmission(db, masterKey, first.submission.id)).toMatchObject({ shouldAttempt: false });
  });

  it("rejects reusing an idempotency key for different content", () => {
    prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_conflict",
      request,
    });

    expect(() => prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_conflict",
      request: { ...request, text: "Different message body" },
    })).toThrow(SubmissionConflictError);
  });

  it("recovers a process-interrupted SMTP attempt as unknown delivery", () => {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_interrupted",
      request,
    });
    startSubmission(db, masterKey, prepared.submission.id);

    expect(recoverInterruptedSubmissions(db, masterKey)).toBe(1);
    expect(submissionForId(db, masterKey, prepared.submission.id)).toMatchObject({
      deliveryStatus: "unknown_delivery",
      errorCode: "submission_interrupted",
    });
  });

  it("confirms SMTP-accepted submissions only after the exact Message-ID appears in Sent", () => {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_sent_confirmation",
      request,
    });
    markSubmissionSubmitted(db, masterKey, prepared.submission.id, prepared.submission.messageId);
    expect(confirmSubmissionsInSent(db, masterKey, "account-1")).toBe(0);

    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Sent", "Sent", "\\Sent", 1, 0);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, message_id, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "sent-1", "account-1", "Sent", 1, prepared.submission.messageId, "Status update", "", "sender@example.com", "[]",
      now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );

    expect(confirmSubmissionsInSent(db, masterKey, "account-1")).toBe(1);
    expect(submissionForId(db, masterKey, prepared.submission.id)).toMatchObject({ deliveryStatus: "confirmed" });
  });

  it("clears an earlier uncertain-delivery diagnostic after Sent independently confirms the exact message", () => {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_unknown_then_sent",
      request,
    });
    markSubmissionUnknownDelivery(db, masterKey, prepared.submission.id, "timeout", "SMTP response was lost.");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Sent", "Sent", "\\Sent", 1, 0);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, message_id, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "sent-unknown", "account-1", "Sent", 2, prepared.submission.messageId, "Status update", "", "sender@example.com", "[]",
      now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );

    expect(confirmSubmissionsInSent(db, masterKey, "account-1")).toBe(1);
    expect(submissionForId(db, masterKey, prepared.submission.id)).toMatchObject({
      deliveryStatus: "confirmed",
      errorCode: null,
      errorMessage: null,
      confirmedAt: expect.any(String),
    });
  });

  it("encrypts request, Message-ID, provider diagnostics, and warnings while preserving the DTO", () => {
    const sensitiveRequest = {
      ...request,
      to: ["recipient-canary@example.com"],
      subject: "SUBJECT-CANARY-2f5e4c2d",
      text: "BODY-CANARY-7a19d9f5",
    };
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_encrypted",
      request: sensitiveRequest,
    });
    markSubmissionUnknownDelivery(
      db,
      masterKey,
      prepared.submission.id,
      "smtp_rejected",
      "Recipient recipient-canary@example.com was rejected",
    );
    setSubmissionPostSubmitWarning(db, masterKey, prepared.submission.id, "Draft SUBJECT-CANARY-2f5e4c2d could not be removed");

    const row = db.prepare("SELECT * FROM outbound_submissions WHERE id = ?").get(prepared.submission.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      error_message: null,
      provider_message_id: null,
      post_submit_warning: null,
      crypto_version: 1,
    });
    expect(String(row.request_json)).toMatch(/^nami-v1\./);
    expect(String(row.encrypted_details)).toMatch(/^nami-v1\./);
    expect(String(row.request_fingerprint)).toMatch(/^h1\./);
    expect(String(row.rfc_message_id)).toMatch(/^h1\./);
    const stored = JSON.stringify(row);
    for (const canary of [
      "recipient-canary@example.com",
      "SUBJECT-CANARY-2f5e4c2d",
      "BODY-CANARY-7a19d9f5",
    ]) expect(stored).not.toContain(canary);

    expect(submissionRequestForId(db, masterKey, prepared.submission.id)).toEqual({
      ...sensitiveRequest,
      cc: [],
      references: [],
    });
    expect(submissionForId(db, masterKey, prepared.submission.id)).toMatchObject({
      messageId: prepared.submission.messageId,
      errorMessage: "Recipient recipient-canary@example.com was rejected",
      postSubmitWarning: "Draft SUBJECT-CANARY-2f5e4c2d could not be removed",
    });
    expect(() => submissionForId(db, randomBytes(32), prepared.submission.id)).toThrow();

    const encryptedDetails = String(row.encrypted_details);
    const tamperedEnvelope = Buffer.from(encryptedDetails.slice("nami-v1.".length), "base64url");
    tamperedEnvelope[tamperedEnvelope.length - 1] = tamperedEnvelope[tamperedEnvelope.length - 1]! ^ 1;
    db.prepare("UPDATE outbound_submissions SET encrypted_details = ? WHERE id = ?")
      .run(`nami-v1.${tamperedEnvelope.toString("base64url")}`, prepared.submission.id);
    expect(() => submissionForId(db, masterKey, prepared.submission.id)).toThrow();
  });

  it("migrates legacy plaintext rows and upgrades their SHA-256 fingerprint without breaking idempotency", () => {
    const legacyMessageId = "<legacy-outbox@example.com>";
    const requestJson = JSON.stringify({
      to: request.to,
      cc: [],
      inReplyTo: null,
      references: [],
      subject: request.subject,
      text: request.text,
      html: null,
      discardDraftId: null,
      attachmentTokens: [],
    });
    const legacyFingerprint = createHash("sha256").update(requestJson, "utf8").digest("hex");
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO outbound_submissions (
        id, account_id, idempotency_key, request_fingerprint, rfc_message_id, request_json,
        status, error_code, error_message, provider_message_id, post_submit_warning,
        submitted_at, confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "11111111-1111-4111-8111-111111111111", "account-1", "sub_legacy", legacyFingerprint,
      legacyMessageId, requestJson, "failed", "smtp_rejected", "recipient@example.com rejected",
      "provider-message-canary", "draft warning canary", null, null, now, now,
    );

    expect(migrateOutboundSubmissionStorage(db, masterKey)).toEqual({ migrated: 1, vacuumed: true });
    const row = db.prepare("SELECT * FROM outbound_submissions WHERE id = ?")
      .get("11111111-1111-4111-8111-111111111111") as Record<string, unknown>;
    expect(row).toMatchObject({ error_message: null, provider_message_id: null, post_submit_warning: null, crypto_version: 1 });
    expect(String(row.request_fingerprint)).toMatch(/^h1\./);
    expect(String(row.request_fingerprint)).not.toBe(legacyFingerprint);
    expect(String(row.rfc_message_id)).not.toContain(legacyMessageId);
    expect(migrateOutboundSubmissionStorage(db, masterKey)).toEqual({ migrated: 0, vacuumed: false });

    const repeated = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_legacy",
      request,
    });
    expect(repeated).toMatchObject({ created: false, submission: { messageId: legacyMessageId } });
    expect(() => prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "sender@example.com",
      idempotencyKey: "sub_legacy",
      request: { ...request, subject: "different" },
    })).toThrow(SubmissionConflictError);
  });

  // VACUUM and WAL checkpointing can exceed Vitest's default timeout on constrained Windows runners.
  it("physically removes outbound plaintext canaries from SQLite and WAL during migration", { timeout: 30_000 }, () => {
    db.close();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-outbox-encryption-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    db = openDatabase(databasePath);
    insertAccount(db);
    const canaries = {
      recipient: "NAMI-OUTBOX-RECIPIENT-72d6f29a@example.com",
      subject: "NAMI-OUTBOX-SUBJECT-b1ed69d2-91ca-42ac-ae72-DO-NOT-PERSIST",
      body: "NAMI-OUTBOX-BODY-f7692408-dbb4-43c8-bb30-DO-NOT-PERSIST",
      error: "NAMI-OUTBOX-ERROR-34aa67c4@example.com",
      warning: "NAMI-OUTBOX-WARNING-d2b91a73-64b8-476d-DO-NOT-PERSIST",
    };
    const requestJson = JSON.stringify({
      to: [canaries.recipient], cc: [], inReplyTo: null, references: [], subject: canaries.subject,
      text: canaries.body, html: null, discardDraftId: null, attachmentTokens: [],
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO outbound_submissions (
        id, account_id, idempotency_key, request_fingerprint, rfc_message_id, request_json,
        status, error_code, error_message, provider_message_id, post_submit_warning,
        submitted_at, confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "22222222-2222-4222-8222-222222222222", "account-1", "sub_disk_canary",
      createHash("sha256").update(requestJson).digest("hex"), "<disk-canary@example.com>", requestJson,
      "failed", "smtp_rejected", canaries.error, "provider-disk-canary", canaries.warning,
      null, null, now, now,
    );

    expect(migrateOutboundSubmissionStorage(db, masterKey)).toEqual({ migrated: 1, vacuumed: true });
    db.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = Buffer.concat([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => fs.readFileSync(filePath)));
    const disk = bytes.toString("utf8");
    for (const canary of Object.values(canaries)) expect(disk).not.toContain(canary);
  }, migrationTestTimeoutMs);
});
