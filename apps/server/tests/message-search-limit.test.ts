import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { indexMessageFts } from "../src/message-search.js";

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

describe("encrypted message search scale", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  // Inserting 5001 encrypted messages plus FTS rows takes ~2.5s alone; the
  // 5s default is too tight when the full suite runs in parallel.
  it("searches more than 5000 messages without the previous candidate cap", { timeout: 30_000 }, async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 19) });
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments,
        size, created_at, encrypted_payload, payload_version
      ) VALUES (?, 'account-1', 'INBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, ?, NULL, 0)
    `);
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let index = 1; index <= 5_001; index += 1) {
        const subject = index === 2_500 ? "quarterly report needle" : `bulk message ${index}`;
        insert.run(`message-${index}`, index, subject, "Sender", "sender@example.com", "[]", now, subject, subject, "", now);
        // The direct INSERT bypasses the sync write path, so mirror it into
        // the FTS index just like indexMessageFts does for synced mail.
        indexMessageFts(db, `message-${index}`, {
          subject,
          fromName: "Sender",
          fromAddress: "sender@example.com",
          textBody: subject,
        });
      }
    })();

    const response = await app.inject({ method: "GET", url: "/api/messages?q=needle" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, page: 1 });
    expect(response.json().items[0]).toMatchObject({ id: "message-2500" });

    const missing = await app.inject({ method: "GET", url: "/api/messages?q=absent-term" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ total: 0 });
  });
});
