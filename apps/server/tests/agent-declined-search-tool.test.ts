import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentToolExecutionContext } from "@nami/agent-core";
import { EncryptedAutoReplyDecisionStore } from "../src/agent/auto-reply-decisions.js";
import { createAutoReplyDecisionTools } from "../src/agent/memory-tools.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import type { DatabaseHandle } from "../src/db.js";
import { openDatabase } from "../src/db.js";

const timestamp = "2026-08-03T00:00:00.000Z";
const toolName = "auto-reply.declined.search";

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, timestamp);
}

function contextFor(accountIds: readonly string[]): AgentToolExecutionContext {
  const scoped = [...accountIds];
  return {
    requestId: "req-1",
    caller: {
      callerId: "test",
      kind: "test",
      entryPoint: "test",
      accessLevel: "full-access",
      scopes: ["manage:memory"],
      accountScope: { mode: "selected", accountIds: scoped },
      interactive: true,
      canRequestConfirmation: false,
    },
    accountIds: scoped,
  };
}

describe("auto-reply declined-search tool", () => {
  it("is optional so the run engine can hide it when cloud mail consent is absent", () => {
    const db = openDatabase(":memory:");
    try {
      applyAgentStoreSchema(db, timestamp);
      const store = new EncryptedAutoReplyDecisionStore(db, randomBytes(32), () => timestamp);
      const tool = createAutoReplyDecisionTools(store)
        .find((candidate) => candidate.descriptor.name === toolName);
      expect(tool).toBeDefined();
      expect(tool!.descriptor.accountAccess).toBe("optional");
    } finally {
      db.close();
    }
  });

  it("returns only decisions belonging to the conversation's accounts", async () => {
    const db = openDatabase(":memory:");
    try {
      applyAgentStoreSchema(db, timestamp);
      insertAccount(db, "acct-1");
      insertAccount(db, "acct-2");
      const store = new EncryptedAutoReplyDecisionStore(db, randomBytes(32), () => timestamp);
      const tool = createAutoReplyDecisionTools(store)
        .find((candidate) => candidate.descriptor.name === toolName)!;

      store.create({
        messageId: "message-1",
        accountId: "acct-1",
        threadKey: "thread-1",
        reason: "scope",
        fromAddress: "first@example.test",
        subject: "First decision",
        detail: "ACCOUNT_ONE_DETAIL",
      });
      store.create({
        messageId: "message-2",
        accountId: "acct-2",
        threadKey: "thread-2",
        reason: "scope",
        fromAddress: "second@example.test",
        subject: "Second decision",
        detail: "ACCOUNT_TWO_DETAIL",
      });

      const result = await tool.execute(contextFor(["acct-1"]), {});

      expect(result.ok).toBe(true);
      const items = (result as { value: { items: Array<{ subject: string }> } }).value.items;
      expect(items.map((item) => item.subject)).toEqual(["First decision"]);
      expect(JSON.stringify(result)).not.toContain("ACCOUNT_TWO_DETAIL");
    } finally {
      db.close();
    }
  });
});
