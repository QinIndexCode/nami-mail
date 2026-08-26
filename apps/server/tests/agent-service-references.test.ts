import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-07-27T10:00:00.000Z");
}

function insertMessage(
  db: DatabaseHandle,
  accountId: string,
  id = "message-1",
  uid = 1,
  subject = "Quarterly project report",
  textBody = "The project report is ready. Please schedule the review for Friday.",
): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (
      ?, ?, 'INBOX', ?, ?, 'Ada', 'ada@example.test',
      '2026-07-27T10:00:00.000Z', 'Project report and review schedule',
      ?, '[]', 0, 0,
      '2026-07-27T10:00:00.000Z'
    )
  `).run(id, accountId, uid, subject, textBody);
}

function serviceFixture(db: DatabaseHandle, masterKey: Buffer): AgentService {
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  return new AgentService({ db, masterKey, lifecycle, sourceEvents: outbox });
}

function providerFor(service: AgentService): string {
  return service.createProvider({
    label: "Local test",
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "test-model",
    timeoutMs: 30_000,
    allowCloudMailContent: false,
    makeDefault: true,
  }).id;
}

describe("Agent service mailbox scope", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(async () => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  it("folds a stored current_message scope into selected_account on conversation creation", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const service = serviceFixture(db, masterKey);
    const providerId = providerFor(service);
    const conversation = service.createConversation({
      providerId,
      scope: { mode: "current_message", accountIds: ["account-1"], messageIds: ["message-1"] },
    });
    expect(conversation.scope).toEqual({
      mode: "selected_account",
      accountIds: ["account-1"],
      messageIds: [],
    });
    await service.close();
  });

  it("folds current_message and current_thread stored scopes into selected_account on read", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const service = serviceFixture(db, masterKey);
    const internals = service as unknown as {
      normalizeStoredScope: (value: unknown) => { mode: string; accountIds: string[]; messageIds: string[] };
    };
    expect(internals.normalizeStoredScope({
      mode: "current_message",
      accountIds: ["account-1"],
      messageIds: ["message-1"],
    })).toEqual({ mode: "selected_account", accountIds: ["account-1"], messageIds: [] });
    expect(internals.normalizeStoredScope({
      mode: "current_thread",
      accountIds: ["account-1"],
      messageIds: ["message-1", "message-2"],
    })).toEqual({ mode: "selected_account", accountIds: ["account-1"], messageIds: [] });
    expect(internals.normalizeStoredScope({
      mode: "all_accounts",
      accountIds: ["account-1"],
      messageIds: [],
    })).toEqual({ mode: "all_accounts", accountIds: ["account-1"], messageIds: [] });
    await service.close();
  });
});

describe("Agent service message references", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(async () => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  function streamChatCapture(service: AgentService): {
    internals: {
      runtime: { streamChat: (input: { chat: { messages: Array<{ role: string; content: string }> } }) => AsyncIterable<{ type: "completed"; reason: "stop" }> };
    };
    providerMessages: Array<Array<{ role: string; content: string }>>;
  } {
    const internals = service as unknown as {
      runtime: { streamChat: (input: { chat: { messages: Array<{ role: string; content: string }> } }) => AsyncIterable<{ type: "completed"; reason: "stop" }> };
    };
    const providerMessages: Array<Array<{ role: string; content: string }>> = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
      providerMessages.push(chat.messages);
      yield { type: "completed", reason: "stop" };
    });
    return { internals, providerMessages };
  }

  async function runTurn(
    service: AgentService,
    conversationId: string,
    providerId: string,
    input: { content: string; references?: Array<{ id: string; subject?: string }> },
  ): Promise<void> {
    for await (const _event of service.streamMessage(conversationId, {
      content: input.content,
      providerId,
      mode: "chat",
      scope: service.getConversation(conversationId).scope,
      ...(input.references ? { references: input.references } : {}),
    })) {
      // Exhaust the stream so the turn is fully persisted.
    }
  }

  it("injects referenced mail into the current turn ahead of the user content", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const service = serviceFixture(db, masterKey);
    const providerId = providerFor(service);
    const conversation = service.createConversation({
      providerId,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });
    const { providerMessages } = streamChatCapture(service);

    await runTurn(service, conversation.id, providerId, {
      content: "What is the deadline in this report?",
      references: [{ id: "message-1", subject: "Quarterly project report" }],
    });

    const userTurn = providerMessages[0]?.find((message) => message.role === "user");
    expect(userTurn?.content).toContain("[REFERENCED MAIL 1]");
    expect(userTurn?.content).toContain("Subject: Quarterly project report");
    expect(userTurn?.content).toContain("From: Ada");
    expect(userTurn?.content).toContain("Date: 2026-07-27T10:00:00.000Z");
    expect(userTurn?.content).toContain("The project report is ready.");
    expect(userTurn?.content).toContain("[/REFERENCED MAIL]");
    // The block leads the turn; the user's own question still follows.
    expect(userTurn?.content.indexOf("[REFERENCED MAIL 1]")).toBeLessThan(userTurn?.content.indexOf("What is the deadline in this report?") ?? 0);
    // The reference survives persistence so a reload keeps the chips.
    const stored = service.getConversation(conversation.id).messages.find((message) => message.role === "user");
    expect(stored?.references).toEqual([{ id: "message-1", subject: "Quarterly project report" }]);
    await service.close();
  });

  it("skips references whose messages no longer exist instead of failing the turn", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const service = serviceFixture(db, masterKey);
    const providerId = providerFor(service);
    const conversation = service.createConversation({
      providerId,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });
    const { providerMessages } = streamChatCapture(service);

    await runTurn(service, conversation.id, providerId, {
      content: "Read the missing mail.",
      references: [{ id: "message-deleted", subject: "Gone" }, { id: "message-1", subject: "Quarterly project report" }],
    });

    const userTurn = providerMessages[0]?.find((message) => message.role === "user");
    expect(userTurn?.content).toContain("[REFERENCED MAIL 1]");
    expect(userTurn?.content).not.toContain("Subject: Gone");
    expect(userTurn?.content).toContain("Subject: Quarterly project report");
    expect(userTurn?.content).toContain("Read the missing mail.");
    await service.close();
  });

  it("keeps references from earlier turns in the follow-up history", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const service = serviceFixture(db, masterKey);
    const providerId = providerFor(service);
    const conversation = service.createConversation({
      providerId,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });
    const { providerMessages } = streamChatCapture(service);

    await runTurn(service, conversation.id, providerId, {
      content: "What is in this report?",
      references: [{ id: "message-1" }],
    });
    await runTurn(service, conversation.id, providerId, {
      content: "And when is the review?",
    });

    expect(providerMessages).toHaveLength(2);
    // The second provider request replays turn 1 with its reference block.
    const history = providerMessages[1]?.filter((message) => message.role === "user");
    expect(history).toHaveLength(2);
    const firstTurn = history?.[0];
    expect(firstTurn?.content).toContain("[REFERENCED MAIL 1]");
    expect(firstTurn?.content).toContain("Subject: Quarterly project report");
    expect(firstTurn?.content).toContain("What is in this report?");
    expect(firstTurn?.content).toContain("User follow-up question:");
    const secondTurn = history?.[1];
    expect(secondTurn?.content).toBe("And when is the review?");
    await service.close();
  });
});