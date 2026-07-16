import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

describe("local API", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey:Buffer.alloc(32, 7) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("reports a healthy local service", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: "nami-mail" });
  });

  it("starts with no accounts and never exposes credentials", async () => {
    const response = await app.inject({ method: "GET", url: "/api/accounts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(response.body).not.toContain("password");
  });

  it("returns provider-specific setup guidance without adding form fields", async () => {
    const response = await app.inject({ method: "GET", url: "/api/providers" });
    const providers = response.json() as Array<Record<string, unknown>>;
    const gmail = providers.find((provider) => provider.id === "gmail");

    expect(response.statusCode).toBe(200);
    expect(gmail?.credentialName).toBe("16 位应用专用密码");
    expect(gmail?.setupSteps).toHaveLength(3);
    expect(gmail?.helpUrl).toMatch(/^https:\/\//);
  });

  it("rejects malformed account input before any network connection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { email: "not-an-email", password: "secret" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false });
  });

  it("returns JSON for unknown API routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, message: "接口不存在。" });
  });

  it("keeps the unified inbox scoped to inbox folders while exposing explicit folders", async () => {
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 1, 1);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Sent", "Sent", "\\Sent", 1, 0);
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMessage.run("message-inbox", "account-1", "INBOX", 1, "Inbox message", "Demo", "demo@example.com", "[]", new Date().toISOString(), "inbox", "inbox", "", "[]", 0, 10, new Date().toISOString());
    insertMessage.run("message-sent", "account-1", "Sent", 1, "Sent message", "Demo", "demo@example.com", "[]", new Date().toISOString(), "sent", "sent", "", '["\\\\Seen"]', 0, 10, new Date().toISOString());

    const inbox = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1" });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().items).toHaveLength(1);
    expect(inbox.json().items[0].mailbox).toBe("INBOX");

    const sent = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&folder=Sent" });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().items).toHaveLength(1);
    expect(sent.json().items[0].mailbox).toBe("Sent");

    const search = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&q=Inbox" });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ total: 1, page: 1 });
    expect(search.json().items[0].id).toBe("message-inbox");

    const stats = await app.inject({ method: "GET", url: "/api/stats" });
    expect(stats.json()).toMatchObject({ accounts: 1, messages: 1, unread: 1 });
  });
});
