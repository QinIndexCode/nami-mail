import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { EncryptedAgentAuditStore } from "../src/agent/audit.js";
import { ImmutableGuiConfirmationStore } from "../src/agent/confirmations.js";
import { EncryptedConversationStore } from "../src/agent/conversations.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
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

const desktopCaller = {
  callerId: "desktop-user",
  kind: "desktop-ui" as const,
  entryPoint: "desktop" as const,
  accessLevel: "full-access" as const,
  scopes: ["send:mail" as const],
  accountScope: { mode: "selected" as const, accountIds: ["account-2"] },
  interactive: true,
  canRequestConfirmation: true,
};

describe("encrypted conversations, audit, and GUI confirmations", () => {
  it("keeps multi-account conversations unreadable after one source account is removed", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-07-27T10:00:01.000Z");
    const leaseOne = lifecycle.acquireLease("account-1");
    const leaseTwo = lifecycle.acquireLease("account-2");
    const conversations = new EncryptedConversationStore(db, lifecycle, () => "2026-07-27T10:00:02.000Z");
    conversations.create([leaseOne, leaseTwo], { title: "Private project mail" }, "conversation-1");
    conversations.append("conversation-1", [leaseOne, leaseTwo], "turn", { content: "MAIL-DERIVED-CANARY" }, "turn-1");

    const stored = db.prepare("SELECT encrypted_payload FROM agent_conversation_records").all() as Array<{ encrypted_payload: string }>;
    expect(stored).toHaveLength(4);
    expect(stored.every((row) => !row.encrypted_payload.includes("MAIL-DERIVED-CANARY"))).toBe(true);
    expect(conversations.get("conversation-1", [leaseOne, leaseTwo]).records).toHaveLength(2);
    lifecycle.beginDeletion("account-1");
    expect(() => conversations.get("conversation-1", [leaseOne, leaseTwo])).toThrow();
    db.close();
  });

  it("records encrypted audit intents and consumes a visible confirmation exactly once", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-2");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-07-27T10:00:01.000Z");
    lifecycle.acquireLease("account-2");
    const audits = new EncryptedAgentAuditStore(db, masterKey, lifecycle);
    const event = {
      id: "audit-intent-1",
      requestId: "d2719bc0-7bb9-48a9-bd81-8b3e6fbdf4c9",
      occurredAt: "2026-07-27T10:00:02.000Z",
      callerId: "desktop-user",
      callerKind: "desktop-ui" as const,
      entryPoint: "desktop" as const,
      operation: "mail.send",
      toolName: "mail.send",
      toolCallId: "call-1",
      accountIds: ["account-2"],
      outcome: "intent" as const,
      parametersSummary: "No mail content is stored in this summary.",
    };
    audits.appendSync(event);
    const intentId = audits.intentIdFor(event);
    const rawIntent = db.prepare("SELECT encrypted_details FROM agent_audit_intents WHERE intent_id = ?").get(intentId) as { encrypted_details: string };
    expect(rawIntent.encrypted_details).not.toContain("No mail content");
    expect(audits.intent(intentId)).toMatchObject({ id: event.id, outcome: "intent" });
    const completion = { ...event, id: "audit-completion-1", outcome: "succeeded" as const };
    audits.appendSync(completion);
    const linkedIntentIds = db.prepare(`
      SELECT intent_id FROM agent_audit_events
      WHERE event_id IN (?, ?)
      ORDER BY event_id
    `).all(event.id, completion.id) as Array<{ intent_id: string }>;
    expect(linkedIntentIds).toEqual([{ intent_id: intentId }, { intent_id: intentId }]);

    const desktopCapability = Object.freeze({ capability: "desktop-main-only" });
    const confirmations = new ImmutableGuiConfirmationStore(
      db,
      masterKey,
      lifecycle,
      () => "2026-07-27T10:00:04.000Z",
      {
        verify: ({ capability, caller }) => capability === desktopCapability && caller.callerId === "desktop-user"
          ? { principalId: "desktop-main-user", surfaceId: "main-window" }
          : undefined,
      },
    );
    const request = {
      id: "confirmation-1",
      requestId: event.requestId,
      toolName: "mail.send",
      action: "send-mail" as const,
      accountIds: ["account-2"],
      immutablePayloadHash: "a".repeat(64),
      oneTime: true as const,
      createdAt: "2026-07-27T10:00:03.000Z",
      expiresAt: "2026-07-27T10:10:00.000Z",
      preview: { title: "Send message", summary: "Recipient and message preview", fields: [] },
    };
    await confirmations.create(request);
    expect(await confirmations.consumeApproval({
      confirmationId: request.id,
      requestId: request.requestId,
      caller: desktopCaller,
      immutablePayloadHash: request.immutablePayloadHash,
    })).toMatchObject({ approved: false, error: { code: "CONFIRMATION_REQUIRED" } });

    expect(() => confirmations.recordDecision({
      confirmationId: request.id,
      requestId: request.requestId,
      decision: "approved",
      decidedAt: "2026-07-27T10:00:05.000Z",
      immutablePayloadHash: request.immutablePayloadHash,
    }, desktopCaller)).toThrow("verified desktop confirmation capability");
    expect(() => confirmations.recordDecision({
      confirmationId: request.id,
      requestId: request.requestId,
      decision: "approved",
      decidedAt: "2026-07-27T10:00:05.000Z",
      immutablePayloadHash: request.immutablePayloadHash,
    }, desktopCaller, { capability: "desktop-main-only" })).toThrow("verified desktop confirmation capability");
    const unconfiguredConfirmations = new ImmutableGuiConfirmationStore(
      db,
      masterKey,
      lifecycle,
      () => "2026-07-27T10:00:04.000Z",
    );
    expect(() => unconfiguredConfirmations.recordDecision({
      confirmationId: request.id,
      requestId: request.requestId,
      decision: "approved",
      decidedAt: "2026-07-27T10:00:05.000Z",
      immutablePayloadHash: request.immutablePayloadHash,
    }, desktopCaller, desktopCapability)).toThrow("verified desktop confirmation capability");
    confirmations.recordDecision({
      confirmationId: request.id,
      requestId: request.requestId,
      decision: "approved",
      decidedAt: "2026-07-27T10:00:05.000Z",
      immutablePayloadHash: request.immutablePayloadHash,
    }, desktopCaller, desktopCapability);
    expect(await confirmations.consumeApproval({
      confirmationId: request.id,
      requestId: request.requestId,
      caller: desktopCaller,
      immutablePayloadHash: request.immutablePayloadHash,
      desktopCapability,
    })).toEqual({ approved: true });
    expect(await confirmations.consumeApproval({
      confirmationId: request.id,
      requestId: request.requestId,
      caller: desktopCaller,
      immutablePayloadHash: request.immutablePayloadHash,
      desktopCapability,
    })).toMatchObject({ approved: false, error: { code: "CONFLICT" } });
    expect(() => db.prepare("UPDATE agent_gui_confirmation_records SET event_type = 'rejected'").run()).toThrow();
    db.close();
  });

  it("mirrors streaming drafts in one replaceable row and clears them when finished", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-07-27T10:00:01.000Z");
    const leaseOne = lifecycle.acquireLease("account-1");
    const leaseTwo = lifecycle.acquireLease("account-2");
    const conversations = new EncryptedConversationStore(db, lifecycle, () => "2026-07-27T10:00:02.000Z");
    conversations.create([leaseOne, leaseTwo], { title: "Streaming" }, "conversation-streaming");
    const turn = (content: string, state: "streaming" | "complete") => ({
      type: "conversation-turn",
      message: {
        id: "message-x",
        role: "assistant",
        content,
        createdAt: "2026-07-27T10:00:02.000Z",
        state,
        citations: [],
        toolActivities: [],
      },
      mailContextIncluded: false,
    });

    // Two throttled streaming snapshots under the same message id: the draft
    // row is replaced in place, never duplicated.
    conversations.upsertStreaming("conversation-streaming", [leaseOne, leaseTwo], turn("Partial one. ", "streaming"), "message-x");
    conversations.upsertStreaming("conversation-streaming", [leaseOne, leaseTwo], turn("Partial one. Partial two. ", "streaming"), "message-x");
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_conversation_streaming").get()).toEqual({ count: 1 });
    const draft = conversations.readStreaming("conversation-streaming", [leaseOne, leaseTwo]) as { message: { content: string; state: string } };
    expect(draft.message.content).toBe("Partial one. Partial two. ");
    expect(draft.message.state).toBe("streaming");

    conversations.clearStreaming("conversation-streaming", [leaseOne, leaseTwo]);
    expect(conversations.readStreaming("conversation-streaming", [leaseOne, leaseTwo])).toBeNull();

    // The finished turn is appended to the immutable log; the draft is gone, so
    // the durable history holds exactly metadata + one turn row.
    conversations.append("conversation-streaming", [leaseOne, leaseTwo], "turn", turn("Partial one. Partial two. Final.", "complete"), "message-x");
    const stored = conversations.get("conversation-streaming", [leaseOne, leaseTwo]);
    expect(stored.records).toHaveLength(2);
    const persisted = stored.records.filter((record) => record.kind === "turn").map((record) => record.value) as Array<{ message: { content: string; state: string } }>;
    expect(persisted).toEqual([expect.objectContaining({
      message: expect.objectContaining({ content: "Partial one. Partial two. Final.", state: "complete" }),
    })]);
    db.close();
  });
});
