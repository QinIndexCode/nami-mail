import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  MAX_ENCRYPTED_SEARCH_CANDIDATES,
  encryptMessagePayload,
  ensureAttachmentMetadata,
  messagePayloadForRow,
  messagePayloadMatchesQuery,
  migrateMessageStorage,
  payloadByteEstimate,
  type MessagePayload,
  type MessageStorageRow,
} from "../src/message-storage.js";

const temporaryDirectories: string[] = [];

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1,
      'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.com`, new Date().toISOString());
}

function insertLegacyMessage(db: DatabaseHandle, canary: string, id = "message-1", uid = 1): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', ?, '<message@example.com>', ?, 'Alice',
      'alice@example.com', '[{"name":"Bob","address":"bob@example.com"}]', '[]',
      '<parent@example.com>', '["<root@example.com>"]', '2026-07-20T00:00:00.000Z', ?, ?, ?,
      '["\\Seen"]', 1,
      '[{"partId":"2","filename":"secret.pdf","contentType":"application/pdf","size":7,"related":false,"disposition":"attachment"}]',
      1024, '2026-07-20T00:00:00.000Z')
  `).run(id, uid, `Subject ${canary}`, `Snippet ${canary}`, `Body ${canary}`, `<p>${canary}</p>`);
}

function insertBulkLegacyMessage(db: DatabaseHandle, index: number): void {
  const id = `bulk-${String(index).padStart(3, "0")}`;
  const canary = `bulk-canary-${index}`;
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', ?, ?, ?, 'Alice',
      'alice@example.com', '[{"name":"Bob","address":"bob@example.com"}]', '[]',
      '<parent@example.com>', '["<root@example.com>"]', '2026-07-20T00:00:00.000Z', ?, ?, ?,
      '["\\Seen"]', 1,
      '[{"partId":"2","filename":"secret.pdf","contentType":"application/pdf","size":7,"related":false,"disposition":"attachment"}]',
      1024, '2026-07-20T00:00:00.000Z')
  `).run(id, index + 1, `<${id}@example.com>`, `Subject ${canary}`, `Snippet ${canary}`, `Body ${canary}`, `<p>${canary}</p>`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted message storage", () => {
  it("migrates legacy rows, clears plaintext columns, and remains reentrant", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "migration-canary");

    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 1, vacuumed: true, unreadable: [] });
    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;
    expect(row).toMatchObject({
      message_id: null,
      subject: "",
      from_name: "",
      from_address: "",
      to_json: "[]",
      text_body: "",
      html_body: "",
      attachments_json: "[]",
      payload_version: 1,
    });
    expect(String(row.encrypted_payload)).not.toContain("migration-canary");
    expect(messagePayloadForRow(row, key)).toMatchObject({
      messageId: "<message@example.com>",
      subject: "Subject migration-canary",
      fromAddress: "alice@example.com",
      textBody: "Body migration-canary",
      attachments: [expect.objectContaining({ filename: "secret.pdf" })],
    });

    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 0, vacuumed: false, unreadable: [] });
    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();
    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 0, vacuumed: true, unreadable: [] });
    db.close();
  });

  it("backfills the attachment flag and kinds from visible attachments only", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        cc_json, in_reply_to, references_json, sent_at, snippet, text_body, html_body,
        flags_json, has_attachments, attachments_json, size, created_at
      ) VALUES (?, 'account-1', 'INBOX', ?, '', 'Alice', 'alice@example.com', '[]',
        '[]', NULL, '[]', '2026-07-20T00:00:00.000Z', '', '', '', '[]', ?, ?, 1,
        '2026-07-20T00:00:00.000Z')
    `);
    // The bug's shape: a newsletter whose only part mailparser calls an
    // attachment is its inline wordmark. The old writer counted it, so the list
    // showed a paperclip for a message that opens with no attachment section.
    insert.run("inline-only", 1, 1, JSON.stringify([
      { partId: "2.2", filename: "wordmark.png", contentType: "image/png", size: 915, related: true, disposition: "inline" },
    ]));
    insert.run("real-file", 2, 1, JSON.stringify([
      { partId: "2", filename: "invoice.pdf", contentType: "application/pdf", size: 7, related: false, disposition: "attachment" },
    ]));
    // The inverse: a row that never got the flag although it has a real file.
    insert.run("missed-flag", 3, 0, JSON.stringify([
      { partId: "2", filename: "photo.jpg", contentType: "image/jpeg", size: 9, related: false, disposition: "attachment" },
    ]));

    migrateMessageStorage(db, key);
    expect(ensureAttachmentMetadata(db, key)).toEqual({ backfilled: 3, unclassified: 0 });

    expect(db.prepare("SELECT id, has_attachments, attachment_kinds_json FROM messages ORDER BY id").all()).toEqual([
      { id: "inline-only", has_attachments: 0, attachment_kinds_json: "[]" },
      { id: "missed-flag", has_attachments: 1, attachment_kinds_json: '["image"]' },
      { id: "real-file", has_attachments: 1, attachment_kinds_json: '["pdf"]' },
    ]);

    // The marker makes the sweep one-time; clearing it re-runs the same result.
    expect(ensureAttachmentMetadata(db, key)).toEqual({ backfilled: 0, unclassified: 0 });
    db.prepare("DELETE FROM data_migrations WHERE id = 'attachment-metadata-v1'").run();
    expect(ensureAttachmentMetadata(db, key)).toEqual({ backfilled: 3, unclassified: 0 });
    db.close();
  });

  it("counts the rows it cannot classify instead of silently keeping their flags", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "readable");
    insertLegacyMessage(db, "undecryptable", "message-2", 2);
    migrateMessageStorage(db, key);
    // A stale flag on the row whose payload is about to become unreadable: if the
    // sweep could classify it, the envelope's own `secret.pdf` would set it to 1.
    db.prepare("UPDATE messages SET has_attachments = 0, attachment_kinds_json = '[]' WHERE id = 'message-2'").run();
    // Flip one character of the envelope. That is what a database restored under a
    // different master key looks like: the row still exists, its payload no longer
    // authenticates.
    const envelope = (
      db.prepare("SELECT encrypted_payload FROM messages WHERE id = 'message-2'").get() as { encrypted_payload: string }
    ).encrypted_payload;
    const flipped = `${envelope.slice(0, -6)}${envelope.at(-6) === "A" ? "B" : "A"}${envelope.slice(-5)}`;
    db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = 'message-2'").run(flipped);

    // The readable row is classified from its payload; the other one is counted
    // rather than skipped, because a silent skip would let `has_attachments` and
    // the derived metadata disagree by an unknown amount.
    expect(ensureAttachmentMetadata(db, key)).toEqual({ backfilled: 1, unclassified: 1 });
    expect(db.prepare("SELECT id, has_attachments, attachment_kinds_json FROM messages ORDER BY id").all()).toEqual([
      { id: "message-1", has_attachments: 1, attachment_kinds_json: '["pdf"]' },
      { id: "message-2", has_attachments: 0, attachment_kinds_json: "[]" },
    ]);

    // The marker is still written: one permanently unreadable row must not cost a
    // whole-table decrypt on every start. The count above is the only trace.
    expect(ensureAttachmentMetadata(db, key)).toEqual({ backfilled: 0, unclassified: 0 });
    db.close();
  });

  it("rejects a wrong key and authenticated-payload tampering", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "tamper-canary");
    migrateMessageStorage(db, key);
    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;

    expect(() => messagePayloadForRow(row, randomBytes(32))).toThrow();
    const encrypted = String(row.encrypted_payload);
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    row.encrypted_payload = `${encrypted.slice(0, -1)}${replacement}`;
    expect(() => messagePayloadForRow(row, key)).toThrow();
    db.close();
  });

  it("serves repeated payload reads from the in-process cache and invalidates on re-encryption", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "cache-canary");
    migrateMessageStorage(db, key);
    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;

    const first = messagePayloadForRow(row, key);
    const second = messagePayloadForRow(row, key);
    expect(second).toBe(first);
    expect(second.subject).toBe("Subject cache-canary");

    // Any re-encryption produces a new ciphertext, so the fingerprint part of
    // the cache key must force a fresh decrypt instead of a stale hit.
    const reencrypted = {
      ...row,
      encrypted_payload: encryptMessagePayload(key, row.id, row.account_id, first),
    } as MessageStorageRow;
    const refreshed = messagePayloadForRow(reencrypted, key);
    expect(refreshed).not.toBe(first);
    expect(refreshed.subject).toBe(first.subject);
    db.close();
  });

  it("keeps the cache budget measured without serializing the payload again", () => {
    const payload: MessagePayload = {
      messageId: "<budget@example.com>",
      subject: "Quarterly report",
      fromName: "Alice",
      fromAddress: "alice@example.com",
      to: [{ name: "Bob", address: "bob@example.com" }],
      cc: null,
      inReplyTo: null,
      references: ["<root@example.com>", "<parent@example.com>"],
      snippet: "Numbers for the quarter, 100% attached.",
      textBody: "Numbers for the quarter.\nSecond line.\n".repeat(200),
      htmlBody: `<p>${"<b>100%</b> up".repeat(200)}</p>`,
      attachments: [{
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 1024,
        related: false,
        disposition: "attachment",
      }],
    };
    const exact = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const estimate = payloadByteEstimate(payload);
    // The estimate replaced an exact `JSON.stringify` measurement, so it has
    // to stay in the same ballpark: it is allowed to drift either way, but a
    // drift that large would mean the 64MB budget no longer describes memory.
    expect(estimate).toBeGreaterThan(exact / 2);
    expect(estimate).toBeLessThan(exact * 2);
    // Every retained field is metered, byte for byte.
    expect(payloadByteEstimate({ ...payload, htmlBody: `${payload.htmlBody}!` })).toBe(estimate + 1);
    expect(payloadByteEstimate({ ...payload, textBody: `${payload.textBody}邮` })).toBe(estimate + 3);
    expect(payloadByteEstimate({ ...payload, attachments: [] }))
      .toBeLessThan(estimate - ("report.pdf".length + "application/pdf".length + "2".length));
  });

  it("does not retain a payload larger than the whole cache budget", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "oversized-canary");
    migrateMessageStorage(db, key);
    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;
    const oversized = {
      ...messagePayloadForRow(row, key),
      // Larger than the 64MB budget: caching it would flush the whole cache
      // on every fill, so it is deliberately left uncached.
      htmlBody: "<p>head</p>",
    };
    oversized.htmlBody = "h".repeat(65 * 1024 * 1024);
    const encrypted = encryptMessagePayload(key, row.id, row.account_id, oversized);
    const oversizedRow = { ...row, encrypted_payload: encrypted } as MessageStorageRow;

    expect(payloadByteEstimate(oversized)).toBeGreaterThan(64 * 1024 * 1024);
    const first = messagePayloadForRow(oversizedRow, key);
    const second = messagePayloadForRow(oversizedRow, key);
    expect(second).not.toBe(first);
    expect(second.htmlBody.length).toBe(oversized.htmlBody.length);
    db.close();
  });

  it("preserves literal substring search semantics within a bounded candidate set", () => {
    expect(MAX_ENCRYPTED_SEARCH_CANDIDATES).toBeGreaterThan(0);
    const payload = {
      messageId: null,
      subject: "Quarterly 100% report",
      fromName: "Alice",
      fromAddress: "ALICE@example.com",
      to: [],
      cc: [],
      inReplyTo: null,
      references: [],
      snippet: "",
      textBody: "Project_Code remains literal",
      htmlBody: "",
      attachments: [],
    };
    expect(messagePayloadMatchesQuery(payload, "quarterly")).toBe(true);
    expect(messagePayloadMatchesQuery(payload, "100%")).toBe(true);
    expect(messagePayloadMatchesQuery(payload, "project_code")).toBe(true);
    expect(messagePayloadMatchesQuery(payload, "missing")).toBe(false);
  });

  it("removes a long plaintext canary from the SQLite file during physical migration", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-message-encryption-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    const canary = "NAMI-PLAINTEXT-CANARY-9f2d61d2-4ad6-46be-bd68-DO-NOT-PERSIST";
    const db = openDatabase(databasePath);
    insertAccount(db);
    insertLegacyMessage(db, canary);
    migrateMessageStorage(db, randomBytes(32));
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    const persisted = fs.readdirSync(directory)
      .filter((name) => name.startsWith("nami-mail.db"))
      .map((name) => fs.readFileSync(path.join(directory, name)));
    expect(Buffer.concat(persisted).includes(Buffer.from(canary))).toBe(false);
  });

  it("skips the decryptability sweep on routine startups once the migration marker exists", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "skip-sweep-canary");
    migrateMessageStorage(db, key);

    const encrypted = String(db.prepare("SELECT encrypted_payload FROM messages WHERE id = 'message-1'")
      .get() as { encrypted_payload: string });
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = 'message-1'")
      .run(`${encrypted.slice(0, -1)}${replacement}`);

    // Marker present and nothing migrated: startup no longer decrypts the
    // mailbox, so the corrupted row does not fail the migration check (and
    // vacuumed stays false because the sweep never counted the row).
    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 0, vacuumed: false, unreadable: [] });

    // The degradation is bounded: the corruption still surfaces on first read.
    const tampered = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;
    expect(() => messagePayloadForRow(tampered, key)).toThrow();
    db.close();
  });

  it("forces the full decryptability sweep when the migration marker is missing", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "forced-sweep-canary");
    migrateMessageStorage(db, key);

    const encrypted = String(db.prepare("SELECT encrypted_payload FROM messages WHERE id = 'message-1'")
      .get() as { encrypted_payload: string });
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = 'message-1'")
      .run(`${encrypted.slice(0, -1)}${replacement}`);

    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();
    expect(() => migrateMessageStorage(db, key)).toThrow();
    db.close();
  });

  it("names the damaged rows when the decryptability sweep refuses to start", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "named-canary");
    migrateMessageStorage(db, key);
    const row = db.prepare("SELECT encrypted_payload FROM messages WHERE id = 'message-1'")
      .get() as { encrypted_payload: string };
    const replacement = row.encrypted_payload.endsWith("A") ? "B" : "A";
    db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = 'message-1'")
      .run(`${row.encrypted_payload.slice(0, -1)}${replacement}`);
    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();

    // A stack trace with no id left the operator unable to tell "one damaged
    // message" from "the wrong key": the message has to say which rows.
    expect(() => migrateMessageStorage(db, key)).toThrow(/message-1/u);
    expect(() => migrateMessageStorage(db, key)).toThrow(/1 of 1 stored message payload/u);
    db.close();
  });
  it("streams the decryptability sweep in pages that cover every row", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    const total = 450; // Spans three pages under VERIFICATION_PAGE_SIZE (200).
    for (let index = 0; index < total; index += 1) {
      insertBulkLegacyMessage(db, index);
    }
    expect(migrateMessageStorage(db, key)).toEqual({ migrated: total, vacuumed: true, unreadable: [] });

    const minimalPayload: MessagePayload = {
      messageId: null,
      subject: "",
      fromName: "",
      fromAddress: "",
      to: [],
      cc: null,
      inReplyTo: null,
      references: null,
      snippet: "",
      textBody: "",
      htmlBody: "",
      attachments: null,
    };
    const tamperLastCharacter = (id: string): void => {
      const row = db.prepare("SELECT encrypted_payload FROM messages WHERE id = ?").get(id) as { encrypted_payload: string };
      const replacement = row.encrypted_payload.endsWith("A") ? "B" : "A";
      db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = ?")
        .run(`${row.encrypted_payload.slice(0, -1)}${replacement}`, id);
    };
    const repair = (id: string): void => {
      db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = ?").run(
        encryptMessagePayload(key, id, "account-1", minimalPayload),
        id,
      );
    };

    // The final page's last row is only reached when every page advanced.
    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();
    tamperLastCharacter("bulk-449");
    expect(() => migrateMessageStorage(db, key)).toThrow();
    repair("bulk-449");

    // A corrupted row inside a later page is caught before the sweep ends.
    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();
    tamperLastCharacter("bulk-200");
    expect(() => migrateMessageStorage(db, key)).toThrow();
    repair("bulk-200");

    // After repairs, a forced sweep completes and writes the marker again.
    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();
    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 0, vacuumed: true, unreadable: [] });
    db.close();
  }, 30_000);

  // Inline images are only renderable if the read path hands `contentId` back:
  // the wire layer maps a `cid:` HTML reference to a part through exactly this
  // field. Rebuilding each stored attachment field by field used to drop it,
  // which turned every inline image in the reader into a broken image.
  describe("attachment content ids survive the read path", () => {
    const inlineHtml = '<p>Chart below</p><img src="cid:inline1">';

    it("keeps contentId on the encrypted payload and omits it when absent", () => {
      const db = openDatabase(":memory:");
      const key = randomBytes(32);
      insertAccount(db);
      const payload: MessagePayload = {
        messageId: "<inline@example.com>",
        subject: "Inline chart",
        fromName: "Alice",
        fromAddress: "alice@example.com",
        to: [],
        cc: null,
        inReplyTo: null,
        references: null,
        snippet: "",
        textBody: "",
        htmlBody: inlineHtml,
        attachments: [
          {
            partId: "2.1",
            filename: "chart.png",
            contentType: "image/png",
            size: 2048,
            related: true,
            disposition: "inline",
            contentId: "inline1",
          },
          { partId: "2.2", filename: "notes.pdf", contentType: "application/pdf", size: 9, related: false, disposition: "attachment" },
        ],
      };
      db.prepare(`
        INSERT INTO messages (id, account_id, mailbox, uid, flags_json, size, created_at, encrypted_payload, payload_version)
        VALUES ('message-1', 'account-1', 'INBOX', 1, '[]', 4096, '2026-07-20T00:00:00.000Z', ?, ?)
      `).run(encryptMessagePayload(key, "message-1", "account-1", payload), 1);

      const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;
      const stored = messagePayloadForRow(row, key);
      expect(stored.htmlBody).toBe(inlineHtml);
      expect(stored.attachments).toEqual(payload.attachments);
      expect(stored.attachments?.[0]?.contentId).toBe("inline1");
      // "Present or absent", not "present and empty": an empty or non-string
      // value would put a junk key in the wire layer's cid map.
      expect(stored.attachments?.[1]).not.toHaveProperty("contentId");

      // Same normalization, hostile shapes included.
      const mangled = {
        ...row,
        id: "message-2",
        encrypted_payload: encryptMessagePayload(key, "message-2", "account-1", {
          ...payload,
          attachments: [
            { partId: "3.1", contentId: "" },
            { partId: "3.2", contentId: 42 },
            { partId: "3.3", contentId: "kept" },
          ],
        } as unknown as MessagePayload),
      } as MessageStorageRow;
      expect(messagePayloadForRow(mangled, key).attachments).toEqual([
        { partId: "3.1", filename: "", contentType: "application/octet-stream", size: 0, related: false, disposition: "attachment" },
        { partId: "3.2", filename: "", contentType: "application/octet-stream", size: 0, related: false, disposition: "attachment" },
        { partId: "3.3", filename: "", contentType: "application/octet-stream", size: 0, related: false, disposition: "attachment", contentId: "kept" },
      ]);
      db.close();
    });

    it("keeps contentId on a legacy plaintext row and through its migration", () => {
      const db = openDatabase(":memory:");
      const key = randomBytes(32);
      insertAccount(db);
      insertLegacyMessage(db, "inline-canary");
      db.prepare(`
        UPDATE messages SET html_body = ?, attachments_json = ? WHERE id = 'message-1'
      `).run(inlineHtml, JSON.stringify([{
        partId: "2.1",
        filename: "chart.png",
        contentType: "image/png",
        size: 2048,
        related: true,
        disposition: "inline",
        contentId: "inline1",
      }]));

      const legacy = messagePayloadForRow(db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow, key);
      expect(legacy.htmlBody).toBe(inlineHtml);
      expect(legacy.attachments?.[0]?.contentId).toBe("inline1");

      // The migration re-encrypts what the legacy reader produced, so a drop
      // in either place would survive into every later read.
      expect(migrateMessageStorage(db, key).migrated).toBe(1);
      const migrated = messagePayloadForRow(db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow, key);
      expect(migrated.attachments?.[0]?.contentId).toBe("inline1");
      db.close();
    });

    it("meters contentId bytes in the retained-memory estimate", () => {
      const base: MessagePayload = {
        messageId: null,
        subject: "Inline chart",
        fromName: "",
        fromAddress: "",
        to: [],
        cc: null,
        inReplyTo: null,
        references: null,
        snippet: "",
        textBody: "",
        htmlBody: "",
        attachments: [{
          partId: "2.1",
          filename: "chart.png",
          contentType: "image/png",
          size: 2048,
          related: true,
          disposition: "inline",
        }],
      };
      // The payload object really holds this string once the read path keeps
      // it, so the cache budget has to pay for it.
      expect(payloadByteEstimate({ ...base, attachments: [{ ...base.attachments![0]!, contentId: "inline1" }] }))
        .toBe(payloadByteEstimate(base) + "inline1".length);
    });
  });
});
