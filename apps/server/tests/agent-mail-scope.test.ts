import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const { saveDraft } = vi.hoisted(() => ({ saveDraft: vi.fn() }));

vi.mock("../src/drafts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/drafts.js")>();
  return { ...actual, saveDraft };
});

import type { MailApplicationContext, MailListQuery } from "../src/agent/mail-application-service.js";
import { SqliteMailApplicationService } from "../src/agent/sqlite-mail-application-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function caller() {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments"] as const,
    accountScope: { mode: "selected" as const, accountIds: ["account-1"] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(allowedMessageIds?: readonly string[]): MailApplicationContext {
  return {
    requestId: "26b48831-2356-4618-80d8-22b55c91f457",
    caller: caller(),
    accountIds: ["account-1"],
    ...(allowedMessageIds === undefined ? {} : { allowedMessageIds }),
  };
}

function listQuery(limit = 20): MailListQuery {
  return { accountIds: ["account-1"], limit };
}

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES ('account-1', 'demo@example.test', 'custom', 'Demo', 'encrypted',
      'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(timestamp);
}

type FixtureMessage = {
  id: string;
  uid: number;
  messageId: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: readonly string[];
  attachments?: readonly { partId: string; filename: string; contentType: string; size: number; disposition: "attachment" | "inline" }[];
};

function insertMessage(db: DatabaseHandle, message: FixtureMessage): void {
  const attachments = message.attachments ?? [];
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', ?, ?, ?, 'Sender', 'sender@example.test',
      '[{"name":"Recipient","address":"recipient@example.test"}]', '[]', ?, ?, ?, ?, ?,
      '<p>mail body</p>', '[]', ?, ?, 1, ?)
  `).run(
    message.id,
    message.uid,
    message.messageId,
    message.subject,
    message.inReplyTo ?? null,
    JSON.stringify(message.references ?? []),
    `2026-07-27T12:00:0${message.uid}.000Z`,
    message.subject,
    message.text,
    attachments.length ? 1 : 0,
    JSON.stringify(attachments),
    timestamp,
  );
}

describe("SqliteMailApplicationService message scope", () => {
  it("returns local draft ids and fails closed when an update only partially completes", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    try {
      insertAccount(db);
      const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20 });
      const input = {
        accountId: "account-1",
        to: [{ address: "recipient@example.test" }],
        subject: "Draft subject",
        text: "Draft body",
      };
      saveDraft.mockResolvedValueOnce({
        id: "local-draft-1",
        destination: "Drafts",
        messageId: "<draft-1@example.test>",
        serverConfirmed: true,
      });

      await expect(service.createDraft(context(), input)).resolves.toMatchObject({ id: "local-draft-1" });

      saveDraft.mockResolvedValueOnce({
        id: "local-draft-2",
        destination: "Drafts",
        messageId: "<draft-2@example.test>",
        serverConfirmed: true,
        replaceWarning: "The old draft could not be removed.",
      });
      await expect(service.updateDraft(context(), { ...input, draftId: "local-draft-1" }))
        .rejects.toMatchObject({ code: "draft_operation_outcome_unknown" });
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("treats supplied message ids as an exact boundary for every message read", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    try {
      insertAccount(db);
      insertMessage(db, {
        id: "message-1",
        uid: 1,
        messageId: "<thread-root@example.test>",
        subject: "Allowed root",
        text: "ALLOWED_ROOT",
        attachments: [{ partId: "allowed-attachment", filename: "allowed.txt", contentType: "text/plain", size: 1, disposition: "attachment" }],
      });
      insertMessage(db, {
        id: "message-2",
        uid: 2,
        messageId: "<thread-reply@example.test>",
        inReplyTo: "<thread-root@example.test>",
        references: ["<thread-root@example.test>"],
        subject: "Allowed reply",
        text: "ALLOWED_REPLY",
      });
      insertMessage(db, {
        id: "message-3",
        uid: 3,
        messageId: "<unloaded-thread-reply@example.test>",
        inReplyTo: "<thread-root@example.test>",
        references: ["<thread-root@example.test>"],
        subject: "SCOPE_ESCAPE_CANARY",
        text: "SCOPE_ESCAPE_CANARY",
        attachments: [{ partId: "forbidden-attachment", filename: "forbidden.txt", contentType: "text/plain", size: 1, disposition: "attachment" }],
      });
      insertMessage(db, {
        id: "message-4",
        uid: 4,
        messageId: "<other-thread@example.test>",
        subject: "Other message",
        text: "OTHER_MESSAGE",
      });
      const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20 });

      const currentMessage = context(["message-1"]);
      const currentMessageList = await service.listMessages(currentMessage, listQuery());
      expect(currentMessageList.items.map((message) => message.id)).toEqual(["message-1"]);
      expect((await service.getMessage(currentMessage, "message-1"))?.textBody).toBe("ALLOWED_ROOT");
      expect(await service.getThread(currentMessage, "<thread-root@example.test>")).toHaveLength(1);
      expect(await service.listAttachments(currentMessage, "message-1")).toMatchObject([
        { partId: "allowed-attachment", filename: "allowed.txt" },
      ]);
       await expect(service.getMessage(currentMessage, "message-3")).rejects.toMatchObject({ code: "scope_denied" });
       await expect(service.listAttachments(currentMessage, "message-3")).rejects.toMatchObject({ code: "scope_denied" });
       await expect(service.updateDraft(currentMessage, {
         draftId: "message-3",
         accountId: "account-1",
         to: [{ address: "recipient@example.test" }],
         subject: "Scope check",
         text: "Draft body",
       })).rejects.toMatchObject({ code: "scope_denied" });
       await expect(service.deleteDraft(currentMessage, "account-1", "message-3")).rejects.toMatchObject({ code: "scope_denied" });

       const currentThread = context(["message-1", "message-2"]);
      const currentThreadList = await service.listMessages(currentThread, listQuery());
      expect(currentThreadList.items.map((message) => message.id).sort()).toEqual(["message-1", "message-2"]);
      const thread = await service.getThread(currentThread, "<thread-root@example.test>");
      expect(thread.map((message) => message.id).sort()).toEqual(["message-1", "message-2"]);
      expect(JSON.stringify(thread)).not.toContain("SCOPE_ESCAPE_CANARY");

      const emptyScope = context([]);
      expect(await service.listMessages(emptyScope, listQuery())).toEqual({ items: [] });
      expect(await service.getThread(emptyScope, "<thread-root@example.test>")).toEqual([]);
      await expect(service.getMessage(emptyScope, "message-1")).rejects.toMatchObject({ code: "scope_denied" });

      const accountScoped = await service.listMessages(context(), listQuery());
      expect(accountScoped.items.map((message) => message.id).sort()).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "message-4",
      ]);
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });
});
