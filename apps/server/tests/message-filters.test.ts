import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMessageListSql,
  type MessageListFilterQuery,
} from "../src/message-filters.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { indexMessageFts } from "../src/message-search.js";

// Runs the SQL produced by buildMessageListSql against the real schema so a
// regression in either the filters or the parameter order fails loudly.
function listIds(db: DatabaseHandle, query: MessageListFilterQuery): string[] {
  const selection = buildMessageListSql(query);
  const rows = db.prepare(`SELECT m.id ${selection.join} ${selection.where} ORDER BY m.sent_at`).all(...selection.params) as { id: string }[];
  return rows.map((row) => row.id);
}

let uidSequence = 0;

function insertMessage(
  db: DatabaseHandle,
  message: {
    id: string; mailbox: string; sentAt: string; kinds: string[]; hasAttachments: boolean; subject?: string;
  },
): void {
  uidSequence += 1;
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments,
      attachment_kinds_json, size, created_at, encrypted_payload, payload_version
    ) VALUES (?, 'account-1', ?, ?, ?, 'Sender', 'sender@example.com', '[]', ?, '', '', '', '[]', ?, ?, 0, ?, NULL, 0)
  `).run(
    message.id,
    message.mailbox,
    uidSequence,
    message.subject ?? "",
    message.sentAt,
    message.hasAttachments ? 1 : 0,
    JSON.stringify(message.kinds),
    message.sentAt,
  );
}

describe("buildMessageListSql", () => {
  let db: DatabaseHandle;

  afterEach(() => {
    db?.close();
  });

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES ('account-1', 'sender@example.com', 'custom', 'Demo', 'encrypted',
        'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
    `).run(new Date().toISOString());
    insertMessage(db, {
      id: "photo-mail", mailbox: "INBOX", sentAt: "2026-07-10T09:00:00.000Z",
      kinds: ["image"], hasAttachments: true,
    });
    insertMessage(db, {
      id: "pdf-mail", mailbox: "INBOX", sentAt: "2026-07-20T09:00:00.000Z",
      kinds: ["pdf"], hasAttachments: true,
    });
    insertMessage(db, {
      id: "mixed-mail", mailbox: "INBOX", sentAt: "2026-08-01T09:00:00.000Z",
      kinds: ["image", "spreadsheet"], hasAttachments: true,
    });
    insertMessage(db, {
      id: "plain-mail", mailbox: "INBOX", sentAt: "2026-08-05T09:00:00.000Z",
      kinds: [], hasAttachments: false,
    });
  });

  it("refines an inbox listing by attachment kind", () => {
    expect(listIds(db, { accountId: "account-1", attachmentKind: "image" })).toEqual(["photo-mail", "mixed-mail"]);
    expect(listIds(db, { accountId: "account-1", attachmentKind: "pdf" })).toEqual(["pdf-mail"]);
    expect(listIds(db, { accountId: "account-1", attachmentKind: "spreadsheet" })).toEqual(["mixed-mail"]);
  });

  it("a quoted token prevents one kind from matching another's substring", () => {
    // "code" must not match a "spreadsheet"? No — tokens sit between quotes in
    // JSON text; assert the LIKE parameter itself so a sloppy pattern change
    // is caught before any data can be misclassified.
    const selection = buildMessageListSql({ accountId: "account-1", attachmentKind: "code" });
    expect(selection.params).toContain('%"code"%');
  });

  it("applies inclusive after and exclusive before bounds", () => {
    expect(listIds(db, { accountId: "account-1", after: "2026-07-20T09:00:00.000Z" })).toEqual(["pdf-mail", "mixed-mail", "plain-mail"]);
    expect(listIds(db, { accountId: "account-1", before: "2026-07-20T09:00:00.000Z" })).toEqual(["photo-mail"]);
    expect(listIds(db, { accountId: "account-1", after: "2026-07-20T00:00:00.000Z", before: "2026-08-01T00:00:00.000Z" })).toEqual(["pdf-mail"]);
  });

  it("combined kind and date bounds narrow the same listing", () => {
    expect(listIds(db, {
      accountId: "account-1", attachmentKind: "image",
      after: "2026-07-15T00:00:00.000Z",
    })).toEqual(["mixed-mail"]);
  });

  it("falls back to created_at when sent_at is missing", () => {
    // COALESCE(sent_at, created_at): rows without sent_at fall back to their
    // insertion time. Assert the fallback path, not the literal formula.
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments,
        attachment_kinds_json, size, created_at, encrypted_payload, payload_version
      ) VALUES ('no-sent-at', 'account-1', 'INBOX', 99, '', 'Sender', 'sender@example.com', '[]',
        NULL, '', '', '', '[]', 0, '["pdf"]', 0, '2026-08-10T00:00:00.000Z', NULL, 0)
    `).run();
    expect(listIds(db, { accountId: "account-1", after: "2026-08-10T00:00:00.000Z" })).toEqual(["no-sent-at"]);
  });

  it("applies kind refinement inside a global search", () => {
    insertMessage(db, {
      id: "needle-image", mailbox: "Archive", sentAt: "2026-08-02T09:00:00.000Z",
      kinds: ["image"], hasAttachments: true, subject: "quarterly needle",
    });
    insertMessage(db, {
      id: "needle-pdf", mailbox: "Archive", sentAt: "2026-08-03T09:00:00.000Z",
      kinds: ["pdf"], hasAttachments: true, subject: "quarterly needle",
    });
    // Direct INSERTs bypass the sync write path, so mirror them into the FTS
    // index just like indexMessageFts does for synced mail.
    for (const id of ["needle-image", "needle-pdf"]) {
      indexMessageFts(db, id, {
        subject: "quarterly needle",
        fromName: "Sender",
        fromAddress: "sender@example.com",
        textBody: "quarterly needle",
      });
    }
    expect(listIds(db, { q: "needle", scope: "all", attachmentKind: "image" })).toEqual(["needle-image"]);
    expect(listIds(db, { q: "needle", scope: "all", after: "2026-08-03T00:00:00.000Z" })).toEqual(["needle-pdf"]);
  });

  it("global search without a query keeps standard view precedence", () => {
    // scope=all with no q is not a search: the inbox restriction still applies.
    expect(listIds(db, { scope: "all" })).toEqual(["photo-mail", "pdf-mail", "mixed-mail", "plain-mail"]);
  });
});