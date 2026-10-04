import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  MESSAGE_PAYLOAD_VERSION,
  encryptMessagePayload,
  type MessagePayload,
} from "../src/message-storage.js";

const now = "2026-07-18T00:00:00.000Z";
const messageId = "6f2b1f1c-0d0e-4a6c-9a5c-2b1c9a1f0e11";
const inlineUrl = `/api/messages/${messageId}/inline/1.1`;
const inlineHtml = '<p>Chart below</p><img alt="chart" src="cid:inline1">';

/**
 * The `src` value a browser would read out of the rewritten body.
 *
 * The rewrite pattern (message-wire.ts) consumes the opening quote but not the
 * closing one, so a quoted `cid:` reference comes back with a stray extra quote
 * after the URL. Asserting the attribute value rather than the whole body keeps
 * this suite honest about the one thing it owns — that the reference points at
 * the inline endpoint — without cementing that cosmetic artifact into the
 * contract. It still goes red the moment the rewrite stops happening at all.
 */
function rewrittenSrc(htmlBody: string): string | undefined {
  return /src="([^"]*)"/.exec(htmlBody)?.[1];
}

const inlinePayload: MessagePayload = {
  messageId: "<inline@example.com>",
  subject: "Inline chart",
  fromName: "Alice",
  fromAddress: "alice@example.com",
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: null,
  inReplyTo: null,
  references: null,
  snippet: "Chart below",
  textBody: "Chart below",
  htmlBody: inlineHtml,
  attachments: [{
    partId: "1.1",
    filename: "chart.png",
    contentType: "image/png",
    size: 2048,
    related: true,
    disposition: "inline",
    contentId: "inline1",
  }],
};

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1,
      'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run("account-1", "demo@example.com", now);
}

/** The row shape every encrypted write path produces (sync, drafts, moves). */
function insertEncryptedMessage(db: DatabaseHandle, masterKey: Buffer): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, payload_metadata_ready,
      encrypted_payload, payload_version, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', 1, NULL, '', '', '', '[]', '[]', NULL, NULL,
      ?, ?, '', '', '[]', 1, '[]', 1, ?, ?, ?, ?)
  `).run(
    messageId,
    now,
    "Chart below",
    encryptMessagePayload(masterKey, messageId, "account-1", inlinePayload),
    MESSAGE_PAYLOAD_VERSION,
    4096,
    now,
  );
}

/** A row from before the payload was encrypted: every field in the clear. */
function insertLegacyMessage(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', 1, ?, 'Inline chart', 'Alice', 'alice@example.com',
      '[]', '[]', NULL, NULL, ?, 'Chart below', 'Chart below', ?, '[]', 1, ?, 4096, ?)
  `).run(messageId, "<inline@example.com>", now, inlineHtml, JSON.stringify(inlinePayload.attachments), now);
}

describe("inline cid images", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(() => {
    vi.clearAllMocks();
    imapClientForAccount.mockReturnValue(null);
    db = openDatabase(":memory:");
    insertAccount(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("points the detail body's inline images at the inline endpoint for an encrypted row", async () => {
    insertEncryptedMessage(db, masterKey);
    app = await buildApp({ db, masterKey });

    const response = await app.inject({ method: "GET", url: `/api/messages/${messageId}` });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    // No browser can resolve a bare cid: URL against a local API — this
    // rewrite is the only thing that makes an inline image visible.
    expect(detail.htmlBody).not.toContain("cid:");
    expect(rewrittenSrc(detail.htmlBody)).toBe(inlineUrl);
    // The metadata that drives the rewrite is part of the detail contract too:
    // a `cid:` map built without it stays empty and nothing is rewritten.
    expect(detail.attachments).toEqual(inlinePayload.attachments);

    // A reference with no matching part is left as-is rather than pointed at a
    // URL that would 404, while a resolvable one in the same body still moves.
    db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = ?").run(
      encryptMessagePayload(masterKey, messageId, "account-1", {
        ...inlinePayload,
        htmlBody: '<img src="cid:missing"><img src="cid:inline1">',
      }),
      messageId,
    );
    const partial = (await app.inject({ method: "GET", url: `/api/messages/${messageId}` })).json() as { htmlBody: string };
    expect(partial.htmlBody).toContain('src="cid:missing"');
    expect(partial.htmlBody.match(/src="([^"]*)"/g)).toEqual(['src="cid:missing"', `src="${inlineUrl}"`]);
  });

  it("points the detail body's inline images at the inline endpoint for a legacy plaintext row", async () => {
    insertLegacyMessage(db);
    // buildApp migrates the row, so this covers the whole legacy journey: the
    // plaintext column read, the encrypted re-write, and every later read.
    app = await buildApp({ db, masterKey });

    const response = await app.inject({ method: "GET", url: `/api/messages/${messageId}` });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.htmlBody).not.toContain("cid:");
    expect(rewrittenSrc(detail.htmlBody)).toBe(inlineUrl);
    expect(detail.attachments).toEqual(inlinePayload.attachments);

    const row = db.prepare("SELECT subject, html_body, attachments_json, encrypted_payload, payload_version FROM messages WHERE id = ?")
      .get(messageId) as Record<string, unknown>;
    expect(row.subject).toBe("");
    expect(row.html_body).toBe("");
    expect(row.encrypted_payload).toEqual(expect.any(String));
    expect(row.payload_version).toBe(MESSAGE_PAYLOAD_VERSION);
  });

  it("leaves the list row without a body, so the rewrite only happens on the detail path", async () => {
    insertEncryptedMessage(db, masterKey);
    app = await buildApp({ db, masterKey });

    const list = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1" });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    // A list page that carried the HTML would multiply this rewrite by every
    // message on the page, which is why the list shape skips it entirely.
    expect("htmlBody" in items[0]!).toBe(false);
  });

  it("serves the bytes at the URL the rewrite points at", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const lock = { release: vi.fn() };
    imapClientForAccount.mockReturnValue({
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => lock),
      fetchOne: vi.fn(async () => ({
        uid: 1,
        bodyStructure: { type: "multipart/related", childNodes: [{ part: "1.1", type: "image/png", disposition: "inline" }] },
      })),
      download: vi.fn(async () => ({
        meta: { contentType: "image/png", expectedSize: pngBytes.length, filename: "chart.png" },
        content: Readable.from([pngBytes]),
      })),
      logout: vi.fn(async () => undefined),
    });
    insertEncryptedMessage(db, masterKey);
    app = await buildApp({ db, masterKey });

    const detail = (await app.inject({ method: "GET", url: `/api/messages/${messageId}` })).json() as { htmlBody: string };
    expect(rewrittenSrc(detail.htmlBody)).toBe(inlineUrl);

    // The whole point of the rewrite: the URL the reader is handed has to be a
    // route that serves the part, not just a path that looks like one.
    const image = await app.inject({ method: "GET", url: inlineUrl });
    expect(image.statusCode).toBe(200);
    expect(Buffer.from(image.rawPayload)).toEqual(pngBytes);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.headers["content-disposition"]).toBe("inline");
  });
});

