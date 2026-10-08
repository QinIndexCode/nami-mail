import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  normalizeScheduledTimesMigration,
  prepareSubmission,
  submissionForId,
  submissionRequestForId,
} from "../src/outbox.js";
import { toUtcIsoTimestamp } from "../src/utc-time.js";

const now = new Date().toISOString();

describe("toUtcIsoTimestamp (R05)", () => {
  it("normalizes offsets, negative offsets, cross-day and fractional precision", () => {
    expect(toUtcIsoTimestamp("2026-01-01T09:00:00+08:00")).toBe("2026-01-01T01:00:00.000Z");
    expect(toUtcIsoTimestamp("2026-01-01T09:00:00-05:00")).toBe("2026-01-01T14:00:00.000Z");
    // Crosses the day boundary backwards into UTC.
    expect(toUtcIsoTimestamp("2026-01-01T23:30:00-05:00")).toBe("2026-01-02T04:30:00.000Z");
    // Fractional precision is a spelling difference, not a different instant.
    expect(toUtcIsoTimestamp("2026-01-01T09:00:00.5+08:00")).toBe("2026-01-01T01:00:00.500Z");
    expect(toUtcIsoTimestamp("2026-01-01T09:00:00.500+08:00")).toBe("2026-01-01T01:00:00.500Z");
  });

  it("keeps Z form and rejects unparseable values", () => {
    expect(toUtcIsoTimestamp("2026-01-01T01:00:00.000Z")).toBe("2026-01-01T01:00:00.000Z");
    expect(toUtcIsoTimestamp("not-a-date")).toBeNull();
  });
});

describe("normalizeScheduledTimesMigration (R05)", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);

  function insertAccount(): void {
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
  }

  function insertMessage(id: string, uid: number): void {
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at, snoozed_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "account-1", "INBOX", uid, "Subject", "Demo", "demo@example.com", "[]", now, "", "", "", "[]", 0, 0, now, null);
  }

  function preparePending(idempotencyKey: string, sendAt: string): string {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "demo@example.com",
      idempotencyKey,
      sendAt,
      request: { to: ["recipient@example.com"], subject: "Later", text: "Body", attachmentTokens: [] },
    });
    return prepared.submission.id;
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount();
  });

  afterEach(() => {
    db.close();
  });

  it("rewrites legacy offset send_at values and keeps NULLs", () => {
    const offsetTask = preparePending("idem-offset", "2026-01-01T01:00:00.000Z");
    db.prepare("UPDATE outbound_submissions SET send_at = ? WHERE id = ?").run("2026-01-01T09:00:00+08:00", offsetTask);
    // A null send_at (interactive submission) must stay null.
    const interactive = preparePending("idem-null", "2026-01-01T02:00:00.000Z");
    db.prepare("UPDATE outbound_submissions SET send_at = NULL WHERE id = ?").run(interactive);

    const outcome = normalizeScheduledTimesMigration(db, masterKey);

    expect(outcome.sendAts).toBe(1);
    expect(submissionForId(db, masterKey, offsetTask)?.sendAt).toBe("2026-01-01T01:00:00.000Z");
    expect(submissionForId(db, masterKey, interactive)?.sendAt).toBeNull();
  });

  it("marks an unparseable send_at failed with a diagnosable code, ciphertext still readable", () => {
    const doomed = preparePending("idem-invalid", "2026-01-01T01:00:00.000Z");
    db.prepare("UPDATE outbound_submissions SET send_at = 'not-a-date' WHERE id = ?").run(doomed);

    const outcome = normalizeScheduledTimesMigration(db, masterKey);

    expect(outcome.invalid).toBe(1);
    const row = db.prepare("SELECT status, error_code FROM outbound_submissions WHERE id = ?").get(doomed) as {
      status: string;
      error_code: string | null;
    };
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("invalid_scheduled_time");
    // The AAD-bound envelope (account + task id) is untouched by the plaintext
    // column rewrite: the durable request is still decryptable.
    const request = submissionRequestForId(db, masterKey, doomed);
    expect(request).toMatchObject({ subject: "Later", text: "Body" });
  });

  it("normalizes legacy snoozed times, releases unparseable ones, and is idempotent", () => {
    insertMessage("message-1", 1);
    insertMessage("message-2", 2);
    insertMessage("message-3", 3);
    // Legacy offset, legacy unparseable, and an already-UTC value.
    db.prepare("UPDATE messages SET snoozed_until = '2026-01-01T09:00:00+08:00' WHERE id = 'message-1'").run();
    db.prepare("UPDATE messages SET snoozed_until = 'garbage' WHERE id = 'message-2'").run();
    db.prepare("UPDATE messages SET snoozed_until = '2026-01-01T01:00:00.000Z' WHERE id = 'message-3'").run();

    const first = normalizeScheduledTimesMigration(db, masterKey);
    expect(first.snoozed).toBe(1);
    expect(first.invalid).toBe(1);
    expect(db.prepare("SELECT snoozed_until FROM messages WHERE id = 'message-1'").get()).toMatchObject({
      snoozed_until: "2026-01-01T01:00:00.000Z",
    });
    // The unparseable marker is released (NULL): the message returns to the inbox.
    expect(db.prepare("SELECT snoozed_until FROM messages WHERE id = 'message-2'").get()).toMatchObject({
      snoozed_until: null,
    });
    // The already-UTC value was untouched.
    expect(db.prepare("SELECT snoozed_until FROM messages WHERE id = 'message-3'").get()).toMatchObject({
      snoozed_until: "2026-01-01T01:00:00.000Z",
    });

    // Second startup: the marker short-circuits, nothing is rewritten twice.
    const second = normalizeScheduledTimesMigration(db, masterKey);
    expect(second).toEqual({ sendAts: 0, snoozed: 0, invalid: 0 });
  });

  it("skips already-UTC values on the first run", () => {
    const task = preparePending("idem-utc", "2026-01-01T01:00:00.000Z");
    const outcome = normalizeScheduledTimesMigration(db, masterKey);
    expect(outcome.sendAts).toBe(0);
    expect(submissionForId(db, masterKey, task)?.sendAt).toBe("2026-01-01T01:00:00.000Z");
  });
});
