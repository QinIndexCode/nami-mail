import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const now = "2026-07-20T00:00:00.000Z";

function insertDraft(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "account-1", "demo@example.com", "custom", "Demo", "encrypted",
    "imap.example.com", 993, 1, "smtp.example.com", 465, 1,
    "email", "connected", now,
  );
  db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
    .run("account-1", "Drafts", "Drafts", "\\Drafts", 1, 0);
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "draft-1", "account-1", "Drafts", 73, "<draft-1@nami.local>", "Saved draft", "", "demo@example.com", "[]",
    now, "", "Draft body", "", JSON.stringify(["\\Draft"]), 0, 0, now,
  );
}

describe("draft discard API", () => {
  let app: FastifyInstance | undefined;
  let db: DatabaseHandle | undefined;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    messageDelete: vi.fn(async () => true),
    logout: vi.fn(async () => undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertDraft(db);
    imapClientForAccount.mockReturnValue(client);
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 7) });
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  it("deletes a saved draft only after IMAP confirms the deletion", async () => {
    const response = await app!.inject({ method: "DELETE", url: "/api/messages/draft-1/draft" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(client.messageDelete).toHaveBeenCalledWith(73, { uid: true });
    expect(db!.prepare("SELECT id FROM messages WHERE id = ?").get("draft-1")).toBeUndefined();
  });

  it("keeps the local draft when IMAP cannot confirm deletion", async () => {
    client.messageDelete.mockResolvedValueOnce(false);

    const response = await app!.inject({ method: "DELETE", url: "/api/messages/draft-1/draft" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ ok: false });
    expect(db!.prepare("SELECT id FROM messages WHERE id = ?").get("draft-1")).toEqual({ id: "draft-1" });
  });
});
