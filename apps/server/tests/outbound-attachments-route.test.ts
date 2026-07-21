import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, saveDraft, downloadMessageAttachment } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  saveDraft: vi.fn(),
  downloadMessageAttachment: vi.fn(),
}));
const { scheduleSentSubmissionVerification } = vi.hoisted(() => ({ scheduleSentSubmissionVerification: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, sendMail };
});

vi.mock("../src/drafts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/drafts.js")>();
  return { ...actual, saveDraft };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, scheduleSentSubmissionVerification };
});

vi.mock("../src/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/attachments.js")>();
  return { ...actual, downloadMessageAttachment };
});

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

describe("outbound attachment API", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let directory: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccount(db);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-outbound-route-"));
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 7),
      outboundAttachmentDirectory: directory,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function upload(filename = "notes.txt") {
    const response = await app.inject({
      method: "POST",
      url: "/api/outbound-attachments?accountId=account-1",
      headers: {
        "content-type": "application/octet-stream",
        "x-nami-file-name": encodeURIComponent(filename),
        "x-nami-file-content-type": encodeURIComponent("text/plain"),
      },
      payload: Buffer.from("outbound contents"),
    });
    expect(response.statusCode).toBe(201);
    return response.json().attachment as { token: string; filename: string };
  }

  it("accepts raw binary only through the tokenized upload API and rejects unsafe names", async () => {
    const attachment = await upload("team notes.txt");
    expect(attachment).toMatchObject({ token: expect.stringMatching(/^out_[0-9a-f-]{36}$/), filename: "team notes.txt" });
    expect(JSON.stringify(attachment)).not.toContain(directory);

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/outbound-attachments?accountId=account-1",
      headers: {
        "content-type": "application/octet-stream",
        "x-nami-file-name": encodeURIComponent("run.cmd"),
        "x-nami-file-content-type": encodeURIComponent("text/plain"),
      },
      payload: Buffer.from("cmd"),
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json()).toEqual({ ok: false, message: "不允许添加可执行或脚本文件。" });
  });

  it("hands resolved content to SMTP, cleans a successful unsaved send, and rejects hidden BCC input", async () => {
    const attachment = await upload();
    sendMail.mockResolvedValue({ messageId: "<sent@nami.local>" });

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "Attachment",
        text: "See attachment",
        attachmentTokens: [attachment.token],
      },
    });

    expect(sent.statusCode).toBe(200);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "account-1" }),
      expect.any(Buffer),
      expect.objectContaining({
        attachments: [expect.objectContaining({ filename: "notes.txt", content: Buffer.from("outbound contents") })],
      }),
      undefined,
    );
    expect(db.prepare("SELECT token FROM outbound_attachments WHERE token = ?").get(attachment.token)).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);

    const bcc = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "No hidden recipients",
        text: "Body",
        bcc: ["hidden@example.com"],
      },
    });
    expect(bcc.statusCode).toBe(400);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("persists a saved draft attachment association without exposing a local file path", async () => {
    const attachment = await upload("draft-reference.txt");
    saveDraft.mockResolvedValue({ destination: "Drafts", messageId: "<draft@nami.local>" });

    const saved = await app.inject({
      method: "POST",
      url: "/api/messages/drafts",
      payload: {
        accountId: "account-1",
        to: ["recipient@example.com"],
        subject: "Draft with attachment",
        text: "Draft body",
        attachmentTokens: [attachment.token],
      },
    });
    expect(saved.statusCode).toBe(201);
    expect(saveDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Buffer),
      expect.objectContaining({ id: "account-1" }),
      expect.objectContaining({ attachments: [expect.objectContaining({ filename: "draft-reference.txt" })] }),
      { replaceDraftId: undefined },
      undefined,
    );

    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Drafts", "Drafts", "\\Drafts", 1, 0);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, message_id, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "draft-row", "account-1", "Drafts", 1, "<draft@nami.local>", "Draft with attachment", "", "sender@example.com", "[]",
      now, "", "Draft body", "", '["\\Draft"]', 1, 0, now,
    );
    const listed = await app.inject({ method: "GET", url: "/api/messages/draft-row/outbound-attachments" });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [expect.objectContaining({ token: attachment.token, filename: "draft-reference.txt" })],
    });
    expect(listed.body).not.toContain(directory);
  });

  it("imports an existing provider draft attachment into a durable local token before editing", async () => {
    const now = new Date().toISOString();
    const metadata = {
      partId: "2",
      filename: "provider-note.txt",
      contentType: "text/plain",
      size: 18,
      related: false,
      disposition: "attachment",
    } as const;
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Drafts", "Drafts", "\\Drafts", 1, 0);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, message_id, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, attachments_json, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "provider-draft", "account-1", "Drafts", 4, "<provider-draft@nami.local>", "Provider draft", "", "sender@example.com", "[]",
      now, "", "Draft body", "", '["\\Draft"]', 1, JSON.stringify([metadata]), metadata.size, now,
    );
    downloadMessageAttachment.mockResolvedValue({ attachment: metadata, content: Readable.from([Buffer.from("provider attachment")]) });

    const imported = await app.inject({ method: "POST", url: "/api/messages/provider-draft/outbound-attachments/import", payload: {} });
    const items = imported.json().items as Array<{ token: string; filename: string }>;

    expect(imported.statusCode).toBe(200);
    expect(items).toEqual([expect.objectContaining({ token: expect.stringMatching(/^out_[0-9a-f-]{36}$/), filename: "provider-note.txt" })]);
    expect(downloadMessageAttachment).toHaveBeenCalledWith(expect.anything(), expect.any(Buffer), "provider-draft", "2", undefined);
    const listed = await app.inject({ method: "GET", url: "/api/messages/provider-draft/outbound-attachments" });
    expect(listed.json()).toEqual({ items: [expect.objectContaining({ token: items[0]?.token, filename: "provider-note.txt" })] });
  });
});
