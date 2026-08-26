import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoReplyEngine, type AutoReplyEvaluationResult, type AutoReplyPendingSummary, type AutoReplyUiEvent } from "../src/agent/auto-reply.js";
import { EncryptedAgentAuditStore } from "../src/agent/audit.js";
import { ImmutableGuiConfirmationStore } from "../src/agent/confirmations.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import type { MailApplicationService } from "../src/agent/mail-application-service.js";
import { EncryptedAgentMemoryStore } from "../src/agent/memory.js";
import { EncryptedAutoReplyDecisionStore } from "../src/agent/auto-reply-decisions.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { encryptMessagePayload } from "../src/message-storage.js";
import { updateAppSettings } from "../src/settings.js";

const FIXED_NOW = "2026-08-08T12:00:00.000Z";

type MessageFixture = {
  id?: string;
  accountId?: string;
  mailbox?: string;
  uid?: number;
  subject?: string;
  fromName?: string;
  fromAddress?: string;
  textBody?: string;
  headers?: { autoSubmitted?: string; listUnsubscribe?: string; precedence?: string; returnPath?: string; labels?: string[] };
};

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-08-08T11:00:00.000Z");
}

function insertMessage(db: DatabaseHandle, masterKey: Buffer, fixture: MessageFixture): void {
  const id = fixture.id ?? "message-1";
  const accountId = fixture.accountId ?? "account-1";
  const textBody = fixture.textBody ?? "Could you review the project plan?";
  const payload = {
    messageId: null,
    subject: fixture.subject ?? "Project review",
    fromName: fixture.fromName ?? "Ada",
    fromAddress: fixture.fromAddress ?? "ada@example.test",
    to: [],
    cc: null,
    inReplyTo: null,
    references: null,
    snippet: textBody.slice(0, 80),
    textBody,
    htmlBody: "",
    attachments: null,
    headers: fixture.headers
      ? {
        autoSubmitted: fixture.headers.autoSubmitted ?? "",
        listUnsubscribe: fixture.headers.listUnsubscribe ?? "",
        precedence: fixture.headers.precedence ?? "",
        returnPath: fixture.headers.returnPath ?? "",
        labels: fixture.headers.labels ?? [],
      }
      : undefined,
  };
  const encrypted = encryptMessagePayload(masterKey, id, accountId, payload);
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size,
      encrypted_payload, payload_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, ?, 1, ?)
  `).run(
    id,
    accountId,
    fixture.mailbox ?? "INBOX",
    fixture.uid ?? 1,
    payload.subject,
    payload.fromName,
    payload.fromAddress,
    "2026-08-08T11:00:00.000Z",
    payload.snippet,
    payload.textBody,
    encrypted,
    "2026-08-08T11:00:00.000Z",
  );
}

async function waitForPending(engine: AutoReplyEngine, count: number, timeoutMs = 2_000): Promise<AutoReplyPendingSummary[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = engine.listPending();
    if (pending.length >= count) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} pending confirmation(s).`);
}

function ledgerDecision(db: DatabaseHandle, messageId: string): string | undefined {
  const row = db.prepare("SELECT decision FROM auto_reply_processed WHERE message_id = ?").get(messageId) as
    | { decision: string }
    | undefined;
  return row?.decision;
}

describe("Agent auto-reply engine", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(() => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  function makeEngine(dailyLimitPerAccount = 30, evaluate: (input: never) => Promise<AutoReplyEvaluationResult> = async () => ({
    replyValue: "high" as const,
    sensitive: false,
    replyText: "收到，谢谢！",
  })) {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db, FIXED_NOW);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => FIXED_NOW);
    lifecycle.acquireLease("account-1");
    const audit = new EncryptedAgentAuditStore(db, masterKey, lifecycle);
    const memory = new EncryptedAgentMemoryStore(db, masterKey, () => FIXED_NOW);
    const decisions = new EncryptedAutoReplyDecisionStore(db, masterKey, () => FIXED_NOW);
    const desktopCapability = Object.freeze({ capability: "desktop-main-only" });
    const confirmations = new ImmutableGuiConfirmationStore(db, masterKey, lifecycle, () => FIXED_NOW, {
      verify: ({ capability, caller }) =>
        capability === desktopCapability && caller.kind === "desktop-ui" && caller.interactive === true
          ? { principalId: "desktop-main-user", surfaceId: "main-window" }
          : undefined,
    });
    const mail = {
      prepareSubmission: vi.fn(async () => ({ submissionId: "submission-1" })),
      submitPreparedMail: vi.fn(async () => ({ submissionId: "submission-1" })),
    } as unknown as MailApplicationService;
    updateAppSettings(db, { autoReply: { enabled: true, accountIds: ["account-1"], dailyLimitPerAccount } });
    const engine = new AutoReplyEngine({
      db,
      masterKey,
      evaluate,
      mail,
      audit,
      memory,
      decisions,
      confirmationStore: confirmations,
      desktopConfirmation: { capability: desktopCapability },
      clock: () => FIXED_NOW,
    });
    return { engine, mail, memory, db: db as DatabaseHandle };
  }

  function makeEventEngine(onEvent: (event: AutoReplyUiEvent) => void) {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db, FIXED_NOW);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => FIXED_NOW);
    lifecycle.acquireLease("account-1");
    const audit = new EncryptedAgentAuditStore(db, masterKey, lifecycle);
    const memory = new EncryptedAgentMemoryStore(db, masterKey, () => FIXED_NOW);
    const desktopCapability = Object.freeze({ capability: "desktop-main-only" });
    const confirmations = new ImmutableGuiConfirmationStore(db, masterKey, lifecycle, () => FIXED_NOW, {
      verify: ({ capability, caller }) =>
        capability === desktopCapability && caller.kind === "desktop-ui" && caller.interactive === true
          ? { principalId: "desktop-main-user", surfaceId: "main-window" }
          : undefined,
    });
    const mail = {
      prepareSubmission: vi.fn(async () => ({ submissionId: "submission-1" })),
      submitPreparedMail: vi.fn(async () => ({ submissionId: "submission-1" })),
    } as unknown as MailApplicationService;
    updateAppSettings(db, { autoReply: { enabled: true, accountIds: ["account-1"], dailyLimitPerAccount: 30 } });
    const engine = new AutoReplyEngine({
      db,
      masterKey,
      evaluate: async () => ({ replyValue: "high" as const, sensitive: false, replyText: "收到，谢谢！" }),
      mail,
      audit,
      memory,
      confirmationStore: confirmations,
      desktopConfirmation: { capability: desktopCapability },
      clock: () => FIXED_NOW,
      onEvent,
    });
    return { engine, mail, db: db as DatabaseHandle };
  }

  it("screens, evaluates, and sends a drafted reply only after user approval", async () => {
    const { engine, mail, memory, db: handle } = makeEngine();
    insertMessage(handle, masterKey!, { id: "message-1" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(pending).toMatchObject({
      accountId: "account-1",
      messageId: "message-1",
      subject: "Project review",
      fromAddress: "ada@example.test",
      fromName: "Ada",
      sensitive: false,
    });
    expect(pending!.preview.title).toBe("自动回复确认");
    expect(engine.listPending()).toHaveLength(1);

    const resolution = engine.resolveConfirmation(pending!.confirmationId, "approve");
    expect(resolution).toEqual({ ok: true });
    await notify;

    expect(engine.listPending()).toHaveLength(0);
    expect(mail.prepareSubmission).toHaveBeenCalledTimes(1);
    const submission = (mail.prepareSubmission as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(submission).toMatchObject({
      accountId: "account-1",
      to: [{ name: "Ada", address: "ada@example.test" }],
      subject: "Re: Project review",
      text: "收到，谢谢！",
    });
    expect(mail.submitPreparedMail).toHaveBeenCalledTimes(1);
    expect(ledgerDecision(handle, "message-1")).toBe("sent");
    expect(memory.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const audits = handle.prepare("SELECT COUNT(*) AS count FROM agent_audit_events").get() as { count: number };
    expect(audits.count).toBeGreaterThan(0);
  });

  it("records a rejection and never sends", async () => {
    const { engine, mail, db: handle } = makeEngine();
    insertMessage(handle, masterKey!, { id: "message-1" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(engine.resolveConfirmation(pending!.confirmationId, "reject")).toEqual({ ok: true });
    await notify;

    expect(mail.prepareSubmission).not.toHaveBeenCalled();
    expect(ledgerDecision(handle, "message-1")).toBe("ignored");
    expect(engine.listPending()).toHaveLength(0);
  });

  it("skips low-value mail without creating a confirmation", async () => {
    const evaluate = vi.fn(async (): Promise<AutoReplyEvaluationResult> => ({
      replyValue: "low" as const,
      sensitive: false,
    }));
    const { engine, mail, db: handle } = makeEngine(30, evaluate);
    insertMessage(handle, masterKey!, { id: "message-1" });

    await engine.notifyInboxMessages("account-1", ["message-1"]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(engine.listPending()).toHaveLength(0);
    expect(mail.prepareSubmission).not.toHaveBeenCalled();
    expect(ledgerDecision(handle, "message-1")).toBe("ignored");
  });

  it("ignores junk-folder and auto-submitted mail without calling the model", async () => {
    const evaluate = vi.fn(async (): Promise<AutoReplyEvaluationResult> => ({
      replyValue: "high" as const,
      sensitive: false,
      replyText: "ok",
    }));
    const { engine, db: handle } = makeEngine(30, evaluate);
    insertMessage(handle, masterKey!, { id: "message-1", mailbox: "INBOX/Junk" });
    insertMessage(handle, masterKey!, { id: "message-2", headers: { autoSubmitted: "auto-generated" } });

    await engine.notifyInboxMessages("account-1", ["message-1", "message-2"]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(engine.listPending()).toHaveLength(0);
    expect(ledgerDecision(handle, "message-1")).toBe("ignored");
    expect(ledgerDecision(handle, "message-2")).toBe("ignored");
  });

  it("stops sending at the per-account daily limit", async () => {
    const { engine, mail, db: handle } = makeEngine(1);
    insertMessage(handle, masterKey!, { id: "message-1", subject: "First request" });

    const first = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(engine.resolveConfirmation(pending!.confirmationId, "approve")).toEqual({ ok: true });
    await first;
    expect(ledgerDecision(handle, "message-1")).toBe("sent");

    insertMessage(handle, masterKey!, { id: "message-2", uid: 2, subject: "Second request" });
    await engine.notifyInboxMessages("account-1", ["message-2"]);
    expect(ledgerDecision(handle, "message-2")).toBe("ignored");
    expect(engine.listPending()).toHaveLength(0);
    expect(mail.prepareSubmission).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a second message on the same thread", async () => {
    const { engine, mail, db: handle } = makeEngine();
    insertMessage(handle, masterKey!, { id: "message-1" });

    const first = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(engine.resolveConfirmation(pending!.confirmationId, "approve")).toEqual({ ok: true });
    await first;

    insertMessage(handle, masterKey!, { id: "message-2", uid: 2, fromAddress: "bob@example.test" });
    await engine.notifyInboxMessages("account-1", ["message-2"]);
    expect(ledgerDecision(handle, "message-2")).toBe("ignored");
    expect(mail.prepareSubmission).toHaveBeenCalledTimes(1);
  });

  it("surfaces sensitive evaluations through a higher-priority confirmation preview", async () => {
    const evaluate = vi.fn(async (): Promise<AutoReplyEvaluationResult> => ({
      replyValue: "high" as const,
      sensitive: true,
      replyText: "已处理，请勿在邮件中发送验证码。",
    }));
    const { engine, db: handle } = makeEngine(30, evaluate);
    insertMessage(handle, masterKey!, { id: "message-1", subject: "验证码" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(pending!.sensitive).toBe(true);
    expect(pending!.preview.title).toBe("自动回复确认（敏感）");
    expect(engine.resolveConfirmation(pending!.confirmationId, "approve")).toEqual({ ok: true });
    await notify;
    expect(ledgerDecision(handle, "message-1")).toBe("sent");
  });

  it("reports not-found for unknown confirmation ids", () => {
    const { engine } = makeEngine();
    expect(engine.resolveConfirmation("confirmation-missing", "approve")).toEqual({ decision: "not-found" });
  });

  it("expires pending confirmations after the TTL and never sends", async () => {
    vi.useFakeTimers();
    try {
      const { engine, mail, db: handle } = makeEngine();
      insertMessage(handle, masterKey!, { id: "message-1" });

      const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(engine.listPending()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 100);
      await notify;
      expect(engine.listPending()).toHaveLength(0);
      expect(mail.prepareSubmission).not.toHaveBeenCalled();
      expect(ledgerDecision(handle, "message-1")).toBe("ignored");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a pending event once the confirmation is durably created", async () => {
    const events: AutoReplyUiEvent[] = [];
    const { engine, db: handle } = makeEventEngine((event) => events.push(event));
    insertMessage(handle, masterKey!, { id: "message-1", subject: "Project review", fromName: "Ada", fromAddress: "ada@example.test" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    const pendingEvents = async () => events.filter((event) => event.kind === "pending");
    while ((await pendingEvents()).length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    void notify;

    const [event] = await pendingEvents();
    expect(event).toMatchObject({
      kind: "pending",
      accountId: "account-1",
      messageId: "message-1",
      subject: "Project review",
      fromName: "Ada",
      fromAddress: "ada@example.test",
      sensitive: false,
      replyPreview: "收到，谢谢！",
    });
    expect(Date.parse(event!.expiresAt) - Date.parse(event!.createdAt)).toBe(5 * 60 * 1_000);
    expect(events.filter((item) => item.kind === "sent")).toHaveLength(0);
  });

  it("emits a sent event with no pending leftovers after approval", async () => {
    const events: AutoReplyUiEvent[] = [];
    const { engine, mail, db: handle } = makeEventEngine((event) => events.push(event));
    insertMessage(handle, masterKey!, { id: "message-1", subject: "Project review", fromName: "Ada", fromAddress: "ada@example.test" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    while (engine.listPending().length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const pending = engine.listPending()[0]!;
    expect(engine.resolveConfirmation(pending.confirmationId, "approve")).toEqual({ ok: true });
    await notify;

    const sentEvents = events.filter((event) => event.kind === "sent");
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      kind: "sent",
      messageId: "message-1",
      subject: "Project review",
      toName: "Ada",
      toAddress: "ada@example.test",
      replyPreview: "收到，谢谢！",
    });
    expect(events.filter((event) => event.kind === "pending")).toHaveLength(1);
    expect(mail.submitPreparedMail).toHaveBeenCalledTimes(1);
  });

  it("never emits a sent event for a rejected reply", async () => {
    const events: AutoReplyUiEvent[] = [];
    const { engine, mail, db: handle } = makeEventEngine((event) => events.push(event));
    insertMessage(handle, masterKey!, { id: "message-1" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    while (engine.listPending().length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const pending = engine.listPending()[0]!;
    expect(engine.resolveConfirmation(pending.confirmationId, "reject")).toEqual({ ok: true });
    await notify;

    expect(events.filter((event) => event.kind === "sent")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "pending")).toHaveLength(1);
    expect(mail.prepareSubmission).not.toHaveBeenCalled();
  });

  // ── Web surface mode (no desktop confirmation authority) ────────────────

  function makeWebEngine(dailyLimitPerAccount = 30, evaluate: (input: never) => Promise<AutoReplyEvaluationResult> = async () => ({
    replyValue: "high" as const,
    sensitive: false,
    replyText: "收到，谢谢！",
  })) {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db, FIXED_NOW);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => FIXED_NOW);
    lifecycle.acquireLease("account-1");
    const audit = new EncryptedAgentAuditStore(db, masterKey, lifecycle);
    const memory = new EncryptedAgentMemoryStore(db, masterKey, () => FIXED_NOW);
    const decisions = new EncryptedAutoReplyDecisionStore(db, masterKey, () => FIXED_NOW);
    const webCapability = Object.freeze({ capability: "web-local-only" });
    const confirmations = new ImmutableGuiConfirmationStore(db, masterKey, lifecycle, () => FIXED_NOW, {
      verify: ({ capability, caller }) =>
        capability === webCapability && caller.kind === "web-ui" && caller.interactive === true
          ? { principalId: "web-main-user", surfaceId: "browser-window" }
          : undefined,
    });
    const mail = {
      prepareSubmission: vi.fn(async () => ({ submissionId: "submission-1" })),
      submitPreparedMail: vi.fn(async () => ({ submissionId: "submission-1" })),
    } as unknown as MailApplicationService;
    updateAppSettings(db, { autoReply: { enabled: true, accountIds: ["account-1"], dailyLimitPerAccount } });
    const engine = new AutoReplyEngine({
      db,
      masterKey,
      evaluate,
      mail,
      audit,
      memory,
      decisions,
      confirmationStore: confirmations,
      webConfirmation: { capability: webCapability },
      clock: () => FIXED_NOW,
    });
    return { engine, mail, memory, db: db as DatabaseHandle };
  }

  it("creates a confirmation and sends a reply when resolved from the web surface", async () => {
    const { engine, mail, db: handle } = makeWebEngine();
    insertMessage(handle, masterKey!, { id: "message-1" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(pending!.preview.title).toBe("自动回复确认");

    const resolution = engine.resolveConfirmation(pending!.confirmationId, "approve", "web");
    expect(resolution).toEqual({ ok: true });
    await notify;

    expect(engine.listPending()).toHaveLength(0);
    expect(mail.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(mail.submitPreparedMail).toHaveBeenCalledTimes(1);
    expect(ledgerDecision(handle, "message-1")).toBe("sent");
  });

  it("records a web rejection and never sends", async () => {
    const { engine, mail, db: handle } = makeWebEngine();
    insertMessage(handle, masterKey!, { id: "message-1" });

    const notify = engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);
    expect(engine.resolveConfirmation(pending!.confirmationId, "reject", "web")).toEqual({ ok: true });
    await notify;

    expect(mail.prepareSubmission).not.toHaveBeenCalled();
    expect(ledgerDecision(handle, "message-1")).toBe("ignored");
    expect(engine.listPending()).toHaveLength(0);
  });

  it("never trusts a desktop resolution when only the web authority is wired", async () => {
    const { engine, mail, db: handle } = makeWebEngine();
    insertMessage(handle, masterKey!, { id: "message-1" });

    // The engine waits for a settlement that a rejected desktop resolution
    // never produces, so the notify promise is intentionally not awaited.
    void engine.notifyInboxMessages("account-1", ["message-1"]);
    const [pending] = await waitForPending(engine, 1);

    // A desktop-sourced resolution has no desktop capability to record with.
    expect(engine.resolveConfirmation(pending!.confirmationId, "approve")).toEqual({ decision: "not-found" });
    expect(engine.listPending()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mail.prepareSubmission).not.toHaveBeenCalled();
  });

  it("fails the message with a send-failed decision when no confirmation authority is wired", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db, FIXED_NOW);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => FIXED_NOW);
    lifecycle.acquireLease("account-1");
    const audit = new EncryptedAgentAuditStore(db, masterKey, lifecycle);
    const memory = new EncryptedAgentMemoryStore(db, masterKey, () => FIXED_NOW);
    const decisions = new EncryptedAutoReplyDecisionStore(db, masterKey, () => FIXED_NOW);
    const mail = {
      prepareSubmission: vi.fn(async () => ({ submissionId: "submission-1" })),
      submitPreparedMail: vi.fn(async () => ({ submissionId: "submission-1" })),
    } as unknown as MailApplicationService;
    updateAppSettings(db, { autoReply: { enabled: true, accountIds: ["account-1"], dailyLimitPerAccount: 30 } });
    const engine = new AutoReplyEngine({
      db,
      masterKey,
      evaluate: async () => ({ replyValue: "high" as const, sensitive: false, replyText: "收到，谢谢！" }),
      mail,
      audit,
      memory,
      decisions,
      clock: () => FIXED_NOW,
    });
    const handle = db as DatabaseHandle;
    insertMessage(handle, masterKey!, { id: "message-1" });

    await engine.notifyInboxMessages("account-1", ["message-1"]);

    expect(engine.listPending()).toHaveLength(0);
    expect(ledgerDecision(handle, "message-1")).toBe("failed");
    expect(mail.prepareSubmission).not.toHaveBeenCalled();
    const failed = engine.listDecisions({ reason: "send-failed", limit: 10 });
    expect(failed.some((record) => record.messageId === "message-1")).toBe(true);
  });
});
