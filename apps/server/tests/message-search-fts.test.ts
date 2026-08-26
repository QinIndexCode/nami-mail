import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { deleteMessageFts, indexMessageFts } from "../src/message-search.js";
import { messagePayloadForRow, protectedMessageColumns, type MessageStorageRow } from "../src/message-storage.js";

const MASTER_KEY = Buffer.alloc(32, 19);

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, `${id}@example.com`, "custom", "Demo", "encrypted",
    "imap.example.com", 993, 1, "smtp.example.com", 465, 1,
    "email", "connected", new Date().toISOString(),
  );
}

/** Inserts a production-shaped row: encrypted payload plus an FTS index row. */
function insertIndexedMessage(
  db: DatabaseHandle,
  id: string,
  accountId: string,
  mailbox: string,
  uid: number,
  payload: { subject: string; fromName: string; fromAddress: string; textBody: string },
): void {
  const now = new Date().toISOString();
  const protectedColumns = protectedMessageColumns(MASTER_KEY, id, accountId, {
    messageId: `<${id}@example.com>`,
    subject: payload.subject,
    fromName: payload.fromName,
    fromAddress: payload.fromAddress,
    to: [],
    cc: [],
    inReplyTo: null,
    references: [],
    snippet: payload.textBody.slice(0, 220),
    textBody: payload.textBody,
    htmlBody: "",
    attachments: null,
  });
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, sent_at, flags_json, has_attachments,
      size, created_at, encrypted_payload, payload_version
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
  `).run(id, accountId, mailbox, uid, now, "[]", now, protectedColumns.encryptedPayload, protectedColumns.payloadVersion);
  indexMessageFts(db, id, payload);
}

describe("message FTS search", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it("matches substrings and tokens across subject, sender, and body", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "m1", "account-1", "INBOX", 1, {
      subject: "Quarterly report",
      fromName: "Alice Chen",
      fromAddress: "alice@example.com",
      textBody: "Attached the Q3 numbers.",
    });
    insertIndexedMessage(db, "m2", "account-1", "INBOX", 2, {
      subject: "Lunch plan",
      fromName: "Bob",
      fromAddress: "bob@example.com",
      textBody: "How about Wednesday noon?",
    });

    // Substring inside a word.
    const subjectHit = await app.inject({ method: "GET", url: "/api/messages?q=uarter" });
    expect(subjectHit.statusCode).toBe(200);
    expect(subjectHit.json().total).toBe(1);
    expect(subjectHit.json().items[0].id).toBe("m1");

    // Sender address match.
    const senderHit = await app.inject({ method: "GET", url: "/api/messages?q=alice%40example" });
    expect(senderHit.statusCode).toBe(200);
    expect(senderHit.json().total).toBe(1);

    // Body token match (case-insensitive substring).
    const bodyHit = await app.inject({ method: "GET", url: "/api/messages?q=WEDNESDAY" });
    expect(bodyHit.statusCode).toBe(200);
    expect(bodyHit.json().total).toBe(1);
    expect(bodyHit.json().items[0].id).toBe("m2");

    // No match.
    const miss = await app.inject({ method: "GET", url: "/api/messages?q=zebra" });
    expect(miss.statusCode).toBe(200);
    expect(miss.json().total).toBe(0);
  });

  it("matches two-character CJK queries", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "zh1", "account-1", "INBOX", 1, {
      subject: "中文邮件标题",
      fromName: "测试",
      fromAddress: "sender@example.com",
      textBody: "这是一封中文正文邮件",
    });
    insertIndexedMessage(db, "zh2", "account-1", "INBOX", 2, {
      subject: "English subject",
      fromName: "测试",
      fromAddress: "sender@example.com",
      textBody: "No Chinese body here",
    });

    const hit = await app.inject({ method: "GET", url: "/api/messages?q=%E4%B8%AD%E6%96%87" });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().total).toBe(1);
    expect(hit.json().items[0].id).toBe("zh1");

    const senderHit = await app.inject({ method: "GET", url: "/api/messages?q=%E6%B5%8B%E8%AF%95" });
    expect(senderHit.statusCode).toBe(200);
    expect(senderHit.json().total).toBe(2);
  });

  it("treats LIKE wildcards literally instead of as patterns", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "pct", "account-1", "INBOX", 1, {
      subject: "Project 100% done",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });
    insertIndexedMessage(db, "under", "account-1", "INBOX", 2, {
      subject: "code_branch merge",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });

    const percentHit = await app.inject({ method: "GET", url: "/api/messages?q=100%25" });
    expect(percentHit.statusCode).toBe(200);
    expect(percentHit.json().total).toBe(1);
    expect(percentHit.json().items[0].id).toBe("pct");

    const underscoreHit = await app.inject({ method: "GET", url: "/api/messages?q=code_branch" });
    expect(underscoreHit.statusCode).toBe(200);
    expect(underscoreHit.json().total).toBe(1);
    expect(underscoreHit.json().items[0].id).toBe("under");

    // A bare percent must not behave as "match anything": it only hits the
    // message that actually contains a literal "%".
    const percentAlone = await app.inject({ method: "GET", url: "/api/messages?q=%25" });
    expect(percentAlone.statusCode).toBe(200);
    expect(percentAlone.json().total).toBe(1);
    expect(percentAlone.json().items[0].id).toBe("pct");
  });

  it("combines the FTS predicate with account and folder filters", async () => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "a1-inbox", "account-1", "INBOX", 1, {
      subject: "Shared keyword",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });
    insertIndexedMessage(db, "a1-archive", "account-1", "Archive", 2, {
      subject: "Shared keyword",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });
    insertIndexedMessage(db, "a2-inbox", "account-2", "INBOX", 1, {
      subject: "Shared keyword",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });

    const scoped = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&q=Shared" });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().total).toBe(1);
    expect(scoped.json().items[0].id).toBe("a1-inbox");

    const folderScoped = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&folder=Archive&q=Shared" });
    expect(folderScoped.statusCode).toBe(200);
    expect(folderScoped.json().total).toBe(1);
    expect(folderScoped.json().items[0].id).toBe("a1-archive");
  });

  it("searches every account and mailbox with scope=all, ignoring view restrictions", async () => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "a1-archive", "account-1", "Archive", 1, {
      subject: "Annual review",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });
    insertIndexedMessage(db, "a2-inbox", "account-2", "INBOX", 1, {
      subject: "Annual review",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });
    // Not in the unified inbox, so a scoped search must never see it.
    insertIndexedMessage(db, "a2-projects", "account-2", "Projects", 2, {
      subject: "Annual review",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });

    // The plain search is restricted to the unified inbox of the all-accounts
    // view (Archive and Projects are not inboxes).
    const scoped = await app.inject({ method: "GET", url: "/api/messages?q=Annual" });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().total).toBe(1);
    expect(scoped.json().items[0].id).toBe("a2-inbox");

    // scope=all reaches every account and mailbox regardless of view flags.
    const global = await app.inject({ method: "GET", url: "/api/messages?q=Annual&scope=all" });
    expect(global.statusCode).toBe(200);
    expect(global.json().total).toBe(3);
    expect(new Set(global.json().items.map((item: { id: string }) => item.id))).toEqual(
      new Set(["a1-archive", "a2-inbox", "a2-projects"]),
    );

    // View/account restrictions are meaningless under scope=all; passing them
    // along does not narrow the result.
    const globalWithRestrictions = await app.inject({
      method: "GET",
      url: "/api/messages?accountId=account-1&folder=INBOX&q=Annual&scope=all",
    });
    expect(globalWithRestrictions.statusCode).toBe(200);
    expect(globalWithRestrictions.json().total).toBe(3);

    // Without q, scope=all is ignored so the endpoint never becomes an
    // unbounded full-database listing.
    const noQuery = await app.inject({ method: "GET", url: "/api/messages?scope=all" });
    expect(noQuery.statusCode).toBe(200);
    const inboxOnly = await app.inject({ method: "GET", url: "/api/messages" });
    expect(noQuery.json().total).toBe(inboxOnly.json().total);
    expect(noQuery.json().total).toBe(1);
  });

  it("keeps the index consistent when messages are removed", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "keep", "account-1", "INBOX", 1, {
      subject: "Keep me",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });
    insertIndexedMessage(db, "gone", "account-1", "INBOX", 2, {
      subject: "Remove me",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "body",
    });

    db.prepare("DELETE FROM messages WHERE id = ?").run("gone");
    deleteMessageFts(db, "gone");

    const afterDelete = await app.inject({ method: "GET", url: "/api/messages?q=Remove" });
    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.json().total).toBe(0);

    const kept = await app.inject({ method: "GET", url: "/api/messages?q=Keep" });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().total).toBe(1);
    expect(kept.json().items[0].id).toBe("keep");
  });

  it("re-indexes updated payload text so old content stops matching", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: MASTER_KEY });
    insertIndexedMessage(db, "updated", "account-1", "INBOX", 1, {
      subject: "Old title",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "old body",
    });

    const oldMatch = await app.inject({ method: "GET", url: "/api/messages?q=Old%20title" });
    expect(oldMatch.json().total).toBe(1);

    indexMessageFts(db, "updated", {
      subject: "New title",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "new body",
    });

    const newMatch = await app.inject({ method: "GET", url: "/api/messages?q=New%20title" });
    expect(newMatch.statusCode).toBe(200);
    expect(newMatch.json().total).toBe(1);
    expect(newMatch.json().items[0].id).toBe("updated");

    const stale = await app.inject({ method: "GET", url: "/api/messages?q=Old%20title" });
    expect(stale.json().total).toBe(0);
  });

  it("rebuilds the index from decrypted payloads for legacy rows", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: MASTER_KEY });
    // A legacy row has no encrypted payload; messagePayloadForRow falls back
    // to the plaintext columns, so a rebuild still indexes it.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments,
        size, created_at, encrypted_payload, payload_version
      ) VALUES (?, 'account-1', 'INBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, ?, NULL, 0)
    `).run("legacy-1", 1, "Legacy subject", "Old", "old@example.com", "[]", now, "legacy", "legacy body", "", now);

    const { rebuildMessageFtsIndex, ftsIndexedMessageCount } = await import("../src/message-search.js");
    expect(ftsIndexedMessageCount(db)).toBe(0);
    expect(rebuildMessageFtsIndex(db, MASTER_KEY)).toBe(1);
    expect(ftsIndexedMessageCount(db)).toBe(1);

    const hit = await app.inject({ method: "GET", url: "/api/messages?q=Legacy" });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().total).toBe(1);
    expect(hit.json().items[0].id).toBe("legacy-1");
    expect(hit.json().items[0].subject).toBe("Legacy subject");
  });

  it("preserves the encrypted payload contract while indexing", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    insertIndexedMessage(db, "encrypted-1", "account-1", "INBOX", 1, {
      subject: "Sensitive plan",
      fromName: "S",
      fromAddress: "s@example.com",
      textBody: "secret body",
    });
    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get("encrypted-1") as MessageStorageRow;
    // The stored payload must stay encrypted; plaintext only exists in the
    // FTS mirror, never in the messages row.
    expect(String(row.encrypted_payload)).not.toContain("Sensitive plan");
    const payload = messagePayloadForRow(row, MASTER_KEY);
    expect(payload.subject).toBe("Sensitive plan");
    expect(payload.textBody).toBe("secret body");
  });
});
