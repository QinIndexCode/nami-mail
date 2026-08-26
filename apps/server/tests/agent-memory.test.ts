import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EncryptedAgentMemoryStore } from "../src/agent/memory.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { openDatabase } from "../src/db.js";

const timestamp = "2026-08-03T00:00:00.000Z";

describe("Agent memory store", () => {
  function fixture() {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db, timestamp);
    const masterKey = randomBytes(32);
    const store = new EncryptedAgentMemoryStore(db, masterKey, () => "2026-08-08T12:00:00.000Z");
    return { db, store };
  }

  it("creates, lists, and gets records", () => {
    const { db, store } = fixture();
    try {
      const created = store.create({
        kind: "auto-reply-sent",
        accountId: "acct-1",
        summary: "回复了张三的邮件",
        detail: "会议改期到周五下午三点",
      });
      expect(created.id).toBeTruthy();
      expect(created.kind).toBe("auto-reply-sent");
      expect(created.accountId).toBe("acct-1");
      expect(created.occurredAt).toBe("2026-08-08T12:00:00.000Z");

      const listed = store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.summary).toBe("回复了张三的邮件");

      const fetched = store.get(created.id);
      expect(fetched.detail).toBe("会议改期到周五下午三点");
    } finally {
      db.close();
    }
  });

  it("encrypts payloads at rest", () => {
    const { db, store } = fixture();
    try {
      const created = store.create({ kind: "note", summary: "机密记忆内容" });
      const row = db.prepare(`
        SELECT encrypted_payload FROM agent_memory_records WHERE record_id = ?
      `).get(created.id) as { encrypted_payload: string };
      expect(row.encrypted_payload).not.toContain("机密记忆内容");
      expect(row.encrypted_payload).not.toContain("note");
      expect(row.encrypted_payload).toContain("nami-agent-root-envelope-v1");
    } finally {
      db.close();
    }
  });

  it("filters by kind, account, and query text", () => {
    const { db, store } = fixture();
    try {
      store.create({ kind: "auto-reply-sent", accountId: "acct-1", summary: "回复了张三的报价邮件", detail: "报价 5000 元" });
      store.create({ kind: "email-sent", accountId: "acct-1", summary: "发送了周报给团队" });
      store.create({ kind: "calendar-created", summary: "创建了产品评审会议" });
      store.create({ kind: "auto-reply-ignored", accountId: "acct-2", summary: "忽略了一封营销邮件" });

      expect(store.list({ kind: "auto-reply-sent" })).toHaveLength(1);
      expect(store.list({ accountId: "acct-1" })).toHaveLength(2);
      expect(store.list({ kind: "calendar-created" })).toHaveLength(1);
      expect(store.list({ query: "报价" })).toHaveLength(1);
      expect(store.list({ query: "不存在的词" })).toHaveLength(0);
      expect(store.list({ kind: "auto-reply-ignored", accountId: "acct-2" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("patches the summary without touching detail", () => {
    const { db, store } = fixture();
    try {
      const created = store.create({ kind: "note", summary: "旧摘要", detail: "不可变细节" });
      const updated = store.patchSummary(created.id, "新摘要");
      expect(updated.summary).toBe("新摘要");
      expect(updated.detail).toBe("不可变细节");
      expect(store.get(created.id).summary).toBe("新摘要");
    } finally {
      db.close();
    }
  });

  it("deletes a record and clears all records", () => {
    const { db, store } = fixture();
    try {
      const first = store.create({ kind: "note", summary: "第一条" });
      const second = store.create({ kind: "note", summary: "第二条" });
      store.delete(first.id);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.id).toBe(second.id);
      expect(() => store.delete(first.id)).toThrow();
      expect(store.clear()).toBe(1);
      expect(store.list()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("rejects invalid input", () => {
    const { db, store } = fixture();
    try {
      expect(() => store.create({ summary: "" })).toThrow();
      expect(() => store.create({ summary: "  " })).toThrow();
      expect(() => store.create({ kind: "unsupported-kind", summary: "x" })).toThrow();
      expect(() => store.create({ summary: "x".repeat(501) })).toThrow();
    } finally {
      db.close();
    }
  });

  it("drops the oldest record when the memory exceeds its limit", () => {
    const { db, store } = fixture();
    try {
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      store.create({ kind: "note", summary: "最早的记忆", occurredAt: new Date(base - 1).toISOString() });
      for (let index = 0; index < 500; index += 1) {
        store.create({ kind: "note", summary: `记忆 ${index}`, occurredAt: new Date(base + index * 1000).toISOString() });
      }
      const listed = store.list();
      expect(listed).toHaveLength(500);
      expect(listed.some((record) => record.summary === "最早的记忆")).toBe(false);
      expect(listed[0]!.summary).toBe("记忆 499");
      expect(listed[499]!.summary).toBe("记忆 0");
    } finally {
      db.close();
    }
  });
});
