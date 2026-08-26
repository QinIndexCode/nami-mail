import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../src/db.js";
import { openDatabase } from "../src/db.js";
import { EncryptedAutoReplyDecisionStore } from "../src/agent/auto-reply-decisions.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-07-27T10:00:00.000Z");
}

describe("EncryptedAutoReplyDecisionStore", () => {
  function fixture() {
    const db = openDatabase(":memory:");
    insertAccount(db, "acct-1");
    insertAccount(db, "acct-2");
    applyAgentStoreSchema(db);
    const masterKey = randomBytes(32);
    const store = new EncryptedAutoReplyDecisionStore(db, masterKey, () => "2026-08-08T12:00:00.000Z");
    return { db, store };
  }

  it("creates, lists (newest first), and gets records", () => {
    const { db, store } = fixture();
    try {
      const first = store.create({
        messageId: "msg-1",
        accountId: "acct-1",
        threadKey: "subject:Hello",
        reason: "low-value",
        fromAddress: "ada@example.test",
        fromName: "Ada",
        subject: "Hello",
        detail: "来信价值较低。",
      });
      const second = store.create({
        messageId: "msg-2",
        accountId: "acct-2",
        threadKey: "thread:x",
        reason: "user-rejected",
        fromAddress: "bob@example.test",
        subject: "Invoice",
        occurredAt: "2026-08-08T11:00:00.000Z",
      });
      expect(first.id).toBeTruthy();
      expect(first.occurredAt).toBe("2026-08-08T12:00:00.000Z");

      const listed = store.list();
      expect(listed.map((record) => record.messageId)).toEqual(["msg-1", "msg-2"]);
      expect(listed[0]!.fromName).toBe("Ada");
      expect(listed[1]!.reason).toBe("user-rejected");

      expect(store.get(first.id).subject).toBe("Hello");
    } finally {
      db.close();
    }
  });

  it("filters by reason and free text over decrypted fields", () => {
    const { db, store } = fixture();
    try {
      store.create({
        messageId: "msg-1",
        accountId: "acct-1",
        threadKey: "subject:Hello",
        reason: "scope",
        fromAddress: "ada@example.test",
        fromName: "Ada Lovelace",
        subject: "Quarterly report",
        detail: "不在回复白名单中。",
      });
      store.create({
        messageId: "msg-2",
        accountId: "acct-2",
        threadKey: "subject:Hello",
        reason: "low-value",
        fromAddress: "bob@example.test",
        subject: "Re: quarterly REPORT",
      });

      expect(store.list({ reason: "scope" })).toHaveLength(1);
      expect(store.list({ query: "lovelace" })).toHaveLength(1);
      expect(store.list({ query: "report" })).toHaveLength(2);
      expect(store.list({ query: "白名单" })).toHaveLength(1);
      expect(store.list({ subject: "quarterly" })).toHaveLength(2);
      expect(store.list({ accountId: "acct-2" })).toHaveLength(1);
      expect(store.list({ limit: 1 })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("encrypts the payload at rest", () => {
    const { db, store } = fixture();
    try {
      store.create({
        messageId: "msg-1",
        accountId: "acct-1",
        threadKey: "subject:Hello",
        reason: "screening",
        fromAddress: "ada@example.test",
        subject: "Hello",
        detail: "营销列表",
      });
      const row = db.prepare("SELECT encrypted_payload FROM auto_reply_decisions LIMIT 1").get() as {
        encrypted_payload: string;
      };
      expect(row.encrypted_payload).not.toContain("ada@example.test");
      expect(row.encrypted_payload).not.toContain("营销列表");
      expect(row.encrypted_payload).toContain("nami-agent-root-envelope-v1");
    } finally {
      db.close();
    }
  });

  it("tracks thread rejections for thread-once dedup and drops records", () => {
    const { db, store } = fixture();
    try {
      store.create({
        messageId: "msg-1",
        accountId: "acct-1",
        threadKey: "thread:<root@example>",
        reason: "user-rejected",
        fromAddress: "ada@example.test",
        subject: "Hello",
      });
      expect(store.hasThreadRejected("thread:<root@example>")).toBe(true);
      expect(store.hasThreadRejected("thread:<other@example>")).toBe(false);

      store.create({
        messageId: "msg-2",
        accountId: "acct-1",
        threadKey: "subject:Hi",
        reason: "expired",
      });
      expect(store.list()).toHaveLength(2);
      expect(store.delete("missing")).toBe(false);
      expect(store.delete(store.list({ reason: "expired" })[0]!.id)).toBe(true);
      expect(store.list()).toHaveLength(1);
      expect(store.clear()).toBe(1);
      expect(store.list()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("cascades when the owning account is deleted", () => {
    const { db, store } = fixture();
    try {
      store.create({
        messageId: "msg-1",
        accountId: "acct-1",
        threadKey: "subject:Hello",
        reason: "llm-failed",
      });
      db.prepare("DELETE FROM accounts WHERE id = ?").run("acct-1");
      expect(store.list()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});