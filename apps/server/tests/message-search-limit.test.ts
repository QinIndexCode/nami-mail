import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { MAX_ENCRYPTED_SEARCH_CANDIDATES } from "../src/message-storage.js";

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

describe("encrypted message search bounds", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it("returns an explicit error instead of silently truncating more than 5000 candidates", async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 19) });
    const insert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, sent_at, flags_json, has_attachments,
        size, created_at, encrypted_payload, payload_version
      ) VALUES (?, 'account-1', 'INBOX', ?, ?, '[]', 0, 0, ?, NULL, 0)
    `);
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let index = 1; index <= MAX_ENCRYPTED_SEARCH_CANDIDATES + 1; index += 1) {
        insert.run(`message-${index}`, index, now, now);
      }
    })();

    const response = await app.inject({ method: "GET", url: "/api/messages?q=needle" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      code: "search_scope_too_large",
      message: "搜索范围过大，请先选择一个邮箱或文件夹后再搜索。",
    });
  });
});
