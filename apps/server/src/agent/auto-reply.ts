/**
 * Agent auto-reply pipeline. Runs fire-and-forget after a sync pass, screens
 * new Inbox messages offline, asks the LLM to estimate reply value and draft a
 * plain-text reply, then routes every send through a visible user confirmation.
 *
 * The engine is opt-in per account (`autoReplyConfig` in app settings). It is
 * registered module-wide so `sync.ts` can notify it without threading the
 * dependency through every sync call site; the same registry lets `app.ts`
 * surface pending confirmations to the desktop UI.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentAuditEvent, AutoReplyConfig, CallerContext, ConfirmationDecision, ConfirmationRequest } from "@nami/agent-contracts";
import type { DatabaseHandle } from "../db.js";
import { messagePayloadById, payloadHeaders } from "../message-storage.js";
import { getAppSettings } from "../settings.js";
import { contactFromRow, type ContactRow } from "../contacts.js";
import type { EncryptedAgentAuditStore } from "./audit.js";
import { buildMemoryContextLines, type EncryptedAgentMemoryStore } from "./memory.js";
import type { ImmutableGuiConfirmationStore } from "./confirmations.js";
import { canonicalAgentJson } from "./store-crypto.js";
import type { MailApplicationContext, MailApplicationService } from "./mail-application-service.js";
import { applyAutoReplyScope, renderAutoReplyTemplate, scanSensitiveKeywords, screenAutoReply, screeningIgnoreReasonText, senderDomain, type AutoReplyScopeReason } from "./auto-reply-screening.js";
import { type AutoReplyDecisionListOptions, type AutoReplyDecisionReason, type AutoReplyDecisionRecord, type EncryptedAutoReplyDecisionStore } from "./auto-reply-decisions.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MESSAGES_PER_PASS = 40;

export type AutoReplyEvaluationInput = {
  accountEmail: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  textBody: string;
  snippet: string;
  sensitiveKeywords: readonly string[];
  memoryContext: string;
};

export type AutoReplyEvaluationResult = {
  replyValue: "high" | "low";
  sensitive: boolean;
  replyText?: string;
};

export type AutoReplyEngineOptions = {
  db: DatabaseHandle;
  masterKey: Buffer;
  evaluate: (input: AutoReplyEvaluationInput) => Promise<AutoReplyEvaluationResult>;
  mail: MailApplicationService;
  audit: EncryptedAgentAuditStore;
  memory: EncryptedAgentMemoryStore;
  /** Audit of declined/failed replies surfaced in the desktop review dialog. */
  decisions?: EncryptedAutoReplyDecisionStore;
  confirmationStore?: ImmutableGuiConfirmationStore;
  desktopConfirmation?: Readonly<{ capability: unknown }>;
  /** Local web surface confirmation authority; mutually exclusive with desktopConfirmation. */
  webConfirmation?: Readonly<{ capability: unknown }>;
  clock?: () => string;
  /** Fired for every user-facing auto-reply event (drafts awaiting approval, sent replies). */
  onEvent?: (event: AutoReplyUiEvent) => void;
};

export type AutoReplyResolution = { ok: true } | { decision: "not-found" | "expired" | "failed" };

/**
 * Push events surfaced to the desktop renderer, mirroring the new-mail
 * notification pipeline. `pending` fires once a confirmation request has been
 * durably created; `sent` fires after a prepared reply is actually submitted.
 */
export type AutoReplyUiEvent =
  | {
    kind: "pending";
    confirmationId: string;
    requestId: string;
    accountId: string;
    messageId: string;
    subject: string;
    fromName: string;
    fromAddress: string;
    sensitive: boolean;
    createdAt: string;
    expiresAt: string;
    replyPreview: string;
  }
  | {
    kind: "sent";
    messageId: string;
    accountId: string;
    subject: string;
    toName: string;
    toAddress: string;
    replyPreview: string;
  };

export type AutoReplyPendingSummary = {
  confirmationId: string;
  requestId: string;
  accountId: string;
  messageId: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  sensitive: boolean;
  createdAt: string;
  expiresAt: string;
  preview: ConfirmationRequest["preview"];
};

type EnginePending = {
  messageId: string;
  accountId: string;
  confirmation: ConfirmationRequest;
  replyText: string;
  toAddress: string;
  toName: string;
  subject: string;
  inReplyTo: string | null;
  references: readonly string[] | null;
  sensitive: boolean;
  threadKey: string;
  settle: (outcome: "approved" | "rejected" | "expired" | "cancelled") => void;
};

const registry: { current: AutoReplyEngine | undefined } = { current: undefined };

export function registerAutoReplyEngine(engine: AutoReplyEngine | undefined): void {
  registry.current = engine;
}

export function getAutoReplyEngine(): AutoReplyEngine | undefined {
  return registry.current;
}

const autoReplyCaller: CallerContext = {
  callerId: "auto-reply-engine",
  kind: "service",
  entryPoint: "service",
  accessLevel: "full-access",
  scopes: ["read:accounts", "read:messages", "send:mail", "write:mail"],
  accountScope: { mode: "all" },
  interactive: false,
  canRequestConfirmation: false,
  displayName: "Auto-reply",
};

/**
 * Decision-side caller used when recording auto-reply confirmations. The
 * engine only exists when a verified confirmation authority is wired in (see
 * runtime.ts): the desktop surface (Electron IPC, capability verified in the
 * main process against a visible window) records as `desktop-ui`, while the
 * local web surface (HTTP endpoint, capability verified by the runtime web
 * verifier) records as `web-ui`. Each authority only accepts its own caller.
 */
const autoReplyDesktopCaller: CallerContext = {
  callerId: "nami-desktop-main",
  kind: "desktop-ui",
  entryPoint: "desktop",
  accessLevel: "full-access",
  scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments", "write:drafts", "write:mail", "send:mail"],
  accountScope: { mode: "all" },
  interactive: true,
  canRequestConfirmation: true,
  displayName: "Nami Desktop",
};

const autoReplyWebCaller: CallerContext = {
  callerId: "nami-web-ui",
  kind: "web-ui",
  entryPoint: "web",
  accessLevel: "full-access",
  scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments", "write:drafts", "write:mail", "send:mail"],
  accountScope: { mode: "all" },
  interactive: true,
  canRequestConfirmation: true,
  displayName: "Nami Web",
};

export class AutoReplyEngine {
  private readonly clock: () => string;
  private readonly pending = new Map<string, EnginePending>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly folderSpecialUseCache = new Map<string, string | null>();
  private readonly mailContextSignal = new AbortController();

  constructor(private readonly options: AutoReplyEngineOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async notifyInboxMessages(accountId: string, messageIds: readonly string[]): Promise<void> {
    const config = getAppSettings(this.options.db).autoReply;
    if (!config.enabled || !config.accountIds.includes(accountId)) return;
    let processed = 0;
    for (const messageId of messageIds) {
      if (this.pending.has(messageId)) continue;
      if (processed >= MESSAGES_PER_PASS) break;
      processed += 1;
      await this.processMessage(accountId, messageId, config);
    }
  }

  resolveConfirmation(
    confirmationId: string,
    decision: "approve" | "reject",
    source: "desktop" | "web" = "desktop",
  ): AutoReplyResolution {
    const authority = source === "web" ? this.options.webConfirmation : this.options.desktopConfirmation;
    const caller = source === "web" ? autoReplyWebCaller : autoReplyDesktopCaller;
    const pending = this.pending.get(confirmationId);
    if (!pending || !this.options.confirmationStore || !authority) {
      return { decision: "not-found" };
    }
    if (Date.now() >= Date.parse(pending.confirmation.expiresAt)) {
      this.recordExpired(pending, this.clock());
      return { decision: "expired" };
    }
    const nowIso = this.clock();
    const receipt: ConfirmationDecision = decision === "approve"
      ? {
        confirmationId: pending.confirmation.id,
        requestId: pending.confirmation.requestId,
        decision: "approved",
        decidedAt: nowIso,
        immutablePayloadHash: pending.confirmation.immutablePayloadHash,
      }
      : {
        confirmationId: pending.confirmation.id,
        requestId: pending.confirmation.requestId,
        decision: "rejected",
        decidedAt: nowIso,
      };
    try {
      this.options.confirmationStore.recordDecision(receipt, caller, authority.capability);
    } catch (error) {
      console.warn(`Auto-reply confirmation record failed for ${confirmationId}:`, error);
      return { decision: "failed" };
    }
    this.settle(pending, decision === "approve" ? "approved" : "rejected");
    return { ok: true };
  }

  listPending(): AutoReplyPendingSummary[] {
    return [...this.pending.values()].map((pending) => ({
      confirmationId: pending.confirmation.id,
      requestId: pending.confirmation.requestId,
      accountId: pending.accountId,
      messageId: pending.messageId,
      subject: pending.subject,
      fromAddress: pending.toAddress,
      fromName: pending.toName,
      sensitive: pending.sensitive,
      createdAt: pending.confirmation.createdAt,
      expiresAt: pending.confirmation.expiresAt,
      preview: pending.confirmation.preview,
    }));
  }

  listDecisions(options?: AutoReplyDecisionListOptions): AutoReplyDecisionRecord[] {
    if (!this.options.decisions) return [];
    try {
      return this.options.decisions.list(options);
    } catch (error) {
      console.warn("Auto-reply decision list failed:", error);
      return [];
    }
  }

  deleteDecision(recordId: string): boolean {
    if (!this.options.decisions) return false;
    try {
      return this.options.decisions.delete(recordId);
    } catch (error) {
      console.warn(`Auto-reply decision delete failed for ${recordId}:`, error);
      return false;
    }
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const pending of [...this.pending.values()]) {
      if (!this.pending.has(pending.confirmation.id)) continue;
      this.recordLedger(pending.messageId, pending.accountId, "failed", pending.threadKey);
      this.settle(pending, "cancelled");
    }
    this.pending.clear();
    this.mailContextSignal.abort();
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private async processMessage(accountId: string, messageId: string, config: AutoReplyConfig): Promise<void> {
    if (this.sentToday(accountId) >= config.dailyLimitPerAccount) {
      this.recordLedger(messageId, accountId, "ignored", "message-only");
      this.rememberIgnored(accountId, messageId, "每日自动回复上限已达，本轮不再发送。");
      this.recordDecision(accountId, messageId, "message-only", "daily-cap", { subject: undefined });
      return;
    }
    const stored = messagePayloadById(this.options.db, this.options.masterKey, messageId);
    if (!stored) {
      this.recordLedger(messageId, accountId, "failed", "message-only");
      return;
    }
    const account = this.accountById(accountId);
    if (!account) {
      this.recordLedger(messageId, accountId, "failed", "message-only");
      return;
    }
    const { row, payload } = stored;
    const headers = payloadHeaders(payload);
    const screening = screenAutoReply({
      mailbox: row.mailbox,
      folderSpecialUse: this.folderSpecialUse(accountId, row.mailbox),
      subject: payload.subject,
      fromAddress: payload.fromAddress,
      autoSubmitted: headers.autoSubmitted,
      listUnsubscribe: headers.listUnsubscribe,
      precedence: headers.precedence,
      returnPath: headers.returnPath,
      labels: headers.labels,
      flags: parsedFlags(row.flags_json === null ? null : String(row.flags_json)),
      inReplyTo: payload.inReplyTo,
      references: payload.references,
    });
    if (!screening.keep) {
      this.recordLedger(messageId, accountId, "ignored", "message-only");
      this.rememberIgnored(accountId, messageId, `跳过 ${payload.fromAddress || payload.fromName} 的「${payload.subject}」：${screeningIgnoreReasonText(screening.reason)}`);
      this.recordDecision(accountId, messageId, "message-only", "screening", {
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
        detail: screeningIgnoreReasonText(screening.reason),
      });
      return;
    }
    const threadKey = screening.threadKey ?? `subject:${payload.subject}`;
    const scopeResult = applyAutoReplyScope(
      {
        fromAddress: payload.fromAddress,
        fromDomain: senderDomain(payload.fromAddress),
        subject: payload.subject,
        today: this.clock().slice(0, 10),
        contacts: config.scope.contactsOnly ? this.contactAddresses() : new Set<string>(),
      },
      config.scope,
    );
    if (!scopeResult.keep) {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      this.rememberIgnored(accountId, messageId, `跳过 ${payload.fromAddress || payload.fromName} 的「${payload.subject}」：不在回复范围内（${scopeReasonText(scopeResult.reason)}）`);
      this.recordDecision(accountId, messageId, threadKey, "scope", {
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
        detail: scopeReasonText(scopeResult.reason),
      });
      return;
    }
    if (config.scope.threadOnce && this.threadAlreadyReplied(threadKey)) {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      return;
    }
    const hints = scanSensitiveKeywords(payload.subject, payload.fromAddress, payload.textBody.slice(0, 2_000));
    const fromDomain = senderDomain(payload.fromAddress);
    let replyText: string | undefined;
    let sensitive = hints.length > 0;
    if (config.mode === "template") {
      const rendered = renderAutoReplyTemplate(config.template.text, {
        senderName: payload.fromName,
        senderAddress: payload.fromAddress,
        senderDomain: fromDomain,
        subject: payload.subject,
      });
      if (!rendered) {
        this.recordLedger(messageId, accountId, "ignored", threadKey);
        this.rememberIgnored(accountId, messageId, `模板回复为空，未回复 ${payload.fromAddress || payload.fromName} 的「${payload.subject}」。`);
        this.recordDecision(accountId, messageId, threadKey, "no-template", {
          fromAddress: payload.fromAddress,
          fromName: payload.fromName,
          subject: payload.subject,
        });
        return;
      }
      replyText = rendered;
    } else {
      let memoryContext = "";
      try {
        memoryContext = buildMemoryContextLines(this.options.memory, {
          query: payload.subject,
          limit: 6,
          excludeKinds: ["auto-reply-sent", "auto-reply-ignored"],
        }).join("\n");
      } catch {
        // Recall is best-effort.
      }
      let evaluation: AutoReplyEvaluationResult;
      try {
        evaluation = await this.options.evaluate({
          accountEmail: account.email || "",
          fromName: payload.fromName,
          fromAddress: payload.fromAddress,
          subject: payload.subject,
          textBody: payload.textBody.slice(0, 1_000),
          snippet: payload.snippet.slice(0, 400),
          sensitiveKeywords: hints,
          memoryContext,
        });
      } catch (error) {
        console.warn(`Auto-reply evaluation failed for ${messageId}:`, error);
        this.recordLedger(messageId, accountId, "failed", threadKey);
        this.rememberIgnored(accountId, messageId, "自动回复评估失败，已跳过。");
        this.recordDecision(accountId, messageId, threadKey, "llm-failed", {
          fromAddress: payload.fromAddress,
          fromName: payload.fromName,
          subject: payload.subject,
        });
        return;
      }
      const trimmed = evaluation.replyText?.trim();
      if (evaluation.replyValue !== "high" || !trimmed) {
        this.recordLedger(messageId, accountId, "ignored", threadKey);
        this.rememberIgnored(accountId, messageId, `来信价值较低，Agent 判断无需回复：${payload.subject}`);
        this.recordDecision(accountId, messageId, threadKey, "low-value", {
          fromAddress: payload.fromAddress,
          fromName: payload.fromName,
          subject: payload.subject,
        });
        return;
      }
      replyText = trimmed;
      sensitive = evaluation.sensitive === true;
    }
    const skipConfirmation = config.mode === "template" && config.template.skipConfirmation;
    await this.requestConfirmation(accountId, messageId, payload, replyText, sensitive, threadKey, skipConfirmation);
  }

  private async requestConfirmation(
    accountId: string,
    messageId: string,
    payload: { subject: string; fromName: string; fromAddress: string; inReplyTo: string | null; references: readonly string[] | null },
    replyText: string,
    sensitive: boolean,
    threadKey: string,
    skipConfirmation: boolean,
  ): Promise<void> {
    if (!this.options.confirmationStore || (!this.options.desktopConfirmation && !this.options.webConfirmation)) {
      this.recordLedger(messageId, accountId, "failed", threadKey);
      this.rememberIgnored(accountId, messageId, "确认通道不可用，未发送自动回复。");
      this.recordDecision(accountId, messageId, threadKey, "send-failed", {
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
        detail: "确认通道不可用",
      });
      return;
    }
    const confirmation = this.buildRequest(accountId, messageId, payload, replyText, sensitive);
    const pending: EnginePending = {
      messageId,
      accountId,
      confirmation,
      replyText,
      toAddress: payload.fromAddress,
      toName: payload.fromName,
      subject: payload.subject,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      sensitive,
      threadKey,
      settle: () => undefined,
    };
    if (skipConfirmation) {
      await this.sendReply(pending, threadKey);
      return;
    }
    let resolveOutcome!: (outcome: "approved" | "rejected" | "expired" | "cancelled") => void;
    const outcomePromise = new Promise<"approved" | "rejected" | "expired" | "cancelled">((resolve) => {
      resolveOutcome = resolve;
    });
    const pendingWithSettle: EnginePending = { ...pending, settle: resolveOutcome };
    this.pending.set(confirmation.id, pendingWithSettle);
    const remaining = Math.max(0, Date.parse(confirmation.expiresAt) - Date.now());
    this.timers.set(confirmation.id, setTimeout(() => this.expirePending(confirmation.id), remaining));
    try {
      await this.options.confirmationStore.create(confirmation);
    } catch (error) {
      const timer = this.timers.get(confirmation.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(confirmation.id);
      this.pending.delete(confirmation.id);
      this.recordLedger(messageId, accountId, "failed", threadKey);
      this.rememberIgnored(accountId, messageId, "自动回复确认创建失败，已跳过。");
      this.recordDecision(accountId, messageId, threadKey, "send-failed", {
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
        detail: "确认请求创建失败",
      });
      return;
    }
    try {
      this.options.onEvent?.({
        kind: "pending",
        confirmationId: confirmation.id,
        requestId: confirmation.requestId,
        accountId,
        messageId,
        subject: payload.subject,
        fromName: payload.fromName,
        fromAddress: payload.fromAddress,
        sensitive,
        createdAt: confirmation.createdAt,
        expiresAt: confirmation.expiresAt,
        replyPreview: replyText.slice(0, 200),
      });
    } catch (error) {
      console.warn(`Auto-reply pending event failed for ${confirmation.id}:`, error);
    }
    const outcome = await outcomePromise;
    this.pending.delete(confirmation.id);
    const timer = this.timers.get(confirmation.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(confirmation.id);
    if (outcome === "approved") {
      await this.sendReply(pendingWithSettle, threadKey);
    } else if (outcome === "rejected") {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      this.rememberIgnored(accountId, messageId, `用户拒绝了自动回复：${payload.subject}`);
      this.recordDecision(accountId, messageId, threadKey, "user-rejected", {
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
      });
    } else if (outcome === "expired") {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      this.recordDecision(accountId, messageId, threadKey, "expired", {
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
      });
    } else {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
    }
  }

  private async sendReply(pending: EnginePending, threadKey: string): Promise<void> {
    const context: MailApplicationContext = {
      requestId: pending.confirmation.requestId,
      caller: autoReplyCaller,
      accountIds: [pending.accountId],
      allowedMessageIds: [pending.messageId],
      signal: this.mailContextSignal.signal,
    };
    try {
      const prepared = await this.options.mail.prepareSubmission(context, {
        accountId: pending.accountId,
        to: [{ name: pending.toName, address: pending.toAddress }],
        subject: replySubject(pending.subject),
        text: pending.replyText,
        ...(pending.inReplyTo ? { inReplyTo: pending.inReplyTo } : {}),
        ...(pending.references?.length ? { references: [...pending.references] } : {}),
      });
      await this.options.mail.submitPreparedMail(context, prepared.submissionId);
      this.recordLedger(pending.messageId, pending.accountId, "sent", threadKey);
      this.audit(pending.accountId, pending.confirmation.requestId, "auto-reply.send", pending.replyText.slice(0, 120), "succeeded", pending.confirmation.id);
      this.rememberSent(pending.accountId, pending.messageId, pending.toName || pending.toAddress, pending.subject, pending.replyText);
      try {
        this.options.onEvent?.({
          kind: "sent",
          messageId: pending.messageId,
          accountId: pending.accountId,
          subject: pending.subject,
          toName: pending.toName,
          toAddress: pending.toAddress,
          replyPreview: pending.replyText.slice(0, 200),
        });
      } catch (error) {
        console.warn(`Auto-reply sent event failed for ${pending.messageId}:`, error);
      }
    } catch (error) {
      console.warn(`Auto-reply send failed for ${pending.messageId}:`, error);
      this.recordLedger(pending.messageId, pending.accountId, "failed", threadKey);
      this.audit(pending.accountId, pending.confirmation.requestId, "auto-reply.send", "发送失败", "failed", pending.confirmation.id);
      this.rememberIgnored(pending.accountId, pending.messageId, `自动回复发送失败：${pending.subject}`);
      this.recordDecision(pending.accountId, pending.messageId, threadKey, "send-failed", {
        fromAddress: pending.toAddress,
        fromName: pending.toName,
        subject: pending.subject,
      });
    }
  }

  private expirePending(confirmationId: string): void {
    const pending = this.pending.get(confirmationId);
    if (!pending) return;
    this.recordExpired(pending, this.clock());
  }

  private recordExpired(pending: EnginePending, nowIso: string): void {
    const authority = this.options.desktopConfirmation ?? this.options.webConfirmation;
    if (!this.options.confirmationStore || !authority) {
      this.settle(pending, "expired");
      return;
    }
    const receipt: ConfirmationDecision = {
      confirmationId: pending.confirmation.id,
      requestId: pending.confirmation.requestId,
      decision: "expired",
      decidedAt: nowIso,
    };
    try {
      this.options.confirmationStore.recordDecision(receipt, autoReplyDesktopCaller, authority.capability);
    } catch (error) {
      console.warn(`Auto-reply confirmation expiry could not be recorded for ${pending.confirmation.id}:`, error);
    } finally {
      this.settle(pending, "expired");
    }
  }

  private settle(pending: EnginePending, outcome: "approved" | "rejected" | "expired" | "cancelled"): void {
    pending.settle(outcome);
  }

  private buildRequest(
    accountId: string,
    messageId: string,
    payload: { subject: string; fromName: string; fromAddress: string },
    replyText: string,
    sensitive: boolean,
  ): ConfirmationRequest {
    const now = new Date();
    const fields: { label: string; value: string }[] = [
      { label: "收件人", value: payload.fromAddress || payload.fromName },
      { label: "主题", value: replySubject(payload.subject) },
      { label: "回复内容", value: replyText.slice(0, 1_800) },
    ];
    if (sensitive) {
      fields.push({ label: "注意", value: "这封邮件涉及敏感主题，Agent 已复核，仍需你最终确认是否发送。" });
    }
    const payloadHash = createHash("sha256").update(canonicalAgentJson({
      accountId,
      messageId,
      to: payload.fromAddress,
      subject: replySubject(payload.subject),
      replyText,
    })).digest("hex");
    return {
      id: `confirmation-${randomUUID()}`,
      requestId: `auto-reply-${randomUUID()}`,
      toolName: "auto-reply",
      action: "send-mail",
      accountIds: [accountId],
      immutablePayloadHash: payloadHash,
      oneTime: true,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      preview: {
        title: sensitive ? "自动回复确认（敏感）" : "自动回复确认",
        summary: `Agent 想回复 ${payload.fromName ? `${payload.fromName}（${payload.fromAddress}）` : payload.fromAddress} 的来信「${payload.subject}」。`,
        fields,
      },
    };
  }

  private accountById(accountId: string): { id: string; email: string } | undefined {
    const row = this.options.db.prepare("SELECT id, email FROM accounts WHERE id = ?").get(accountId) as
      | { id: string; email: string }
      | undefined;
    return row ?? undefined;
  }

  private folderSpecialUse(accountId: string, mailbox: string): string | null {
    const key = `${accountId}\0${mailbox}`;
    if (this.folderSpecialUseCache.has(key)) return this.folderSpecialUseCache.get(key) ?? null;
    const row = this.options.db.prepare(
      "SELECT special_use FROM folders WHERE account_id = ? AND path = ?",
    ).get(accountId, mailbox) as { special_use: string | null } | undefined;
    this.folderSpecialUseCache.set(key, row?.special_use ?? null);
    return row?.special_use ?? null;
  }

  private sentToday(accountId: string): number {
    const today = this.clock().slice(0, 10);
    const row = this.options.db.prepare(`
      SELECT COUNT(*) AS count FROM auto_reply_processed
      WHERE account_id = ? AND decision = 'sent' AND occurred_at >= ?
    `).get(accountId, today) as { count: number };
    return row.count;
  }

  /**
   * Thread-once dedup: a thread with a previously sent reply (any time) or an
   * explicit user rejection is never auto-answered again. Controlled by the
   * `scope.threadOnce` flag; when disabled the pipeline replies to every
   * eligible message regardless of thread history.
   */
  private threadAlreadyReplied(threadKey: string): boolean {
    const sent = this.options.db.prepare(`
      SELECT 1 FROM auto_reply_processed
      WHERE thread_key = ? AND decision = 'sent'
      LIMIT 1
    `).get(threadKey) as { "1": unknown } | undefined;
    if (sent) return true;
    if (!this.options.decisions) return false;
    try {
      return this.options.decisions.hasThreadRejected(threadKey);
    } catch (error) {
      console.warn("Auto-reply thread rejection check failed:", error);
      return false;
    }
  }

  private contactAddresses(): Set<string> {
    const addresses = new Set<string>();
    try {
      const rows = this.options.db.prepare(
        "SELECT id, email_enc, name_enc, notes_enc, auto_collected, created_at, updated_at FROM contacts",
      ).all() as ContactRow[];
      for (const row of rows) {
        try {
          const email = contactFromRow(row, this.options.masterKey).email.trim().toLowerCase();
          if (email) addresses.add(email);
        } catch {
          // Unreadable contact rows are skipped; the scope still applies to the rest.
        }
      }
    } catch (error) {
      console.warn("Auto-reply contact lookup failed:", error);
    }
    return addresses;
  }

  private recordDecision(
    accountId: string,
    messageId: string,
    threadKey: string,
    reason: AutoReplyDecisionReason,
    input: { fromAddress?: string; fromName?: string; subject?: string; detail?: string },
  ): void {
    if (!this.options.decisions) return;
    try {
      this.options.decisions.create({
        messageId,
        accountId,
        threadKey,
        reason,
        fromAddress: input.fromAddress,
        fromName: input.fromName,
        subject: input.subject,
        detail: input.detail,
      });
    } catch (error) {
      console.warn(`Auto-reply decision record failed for ${messageId}:`, error);
    }
  }

  private recordLedger(messageId: string, accountId: string, decision: "pending" | "sent" | "ignored" | "failed", threadKey: string): void {
    const now = this.clock();
    this.options.db.prepare(`
      INSERT INTO auto_reply_processed (message_id, account_id, decision, thread_key, occurred_at, updated_at)
      VALUES (@messageId, @accountId, @decision, @threadKey, @occurredAt, @updatedAt)
      ON CONFLICT(message_id) DO UPDATE SET
        decision = excluded.decision,
        thread_key = excluded.thread_key,
        updated_at = excluded.updated_at
    `).run({
      messageId,
      accountId,
      decision,
      threadKey,
      occurredAt: now,
      updatedAt: now,
    });
  }

  private rememberSent(accountId: string, messageId: string, sender: string, subject: string, replyText: string): void {
    try {
      this.options.memory.create({
        kind: "auto-reply-sent",
        accountId,
        summary: `已自动回复 ${sender} 关于「${subject}」的来信。`,
        detail: `发送给 ${sender} 的回复：\n${replyText}\n（原邮件 ${messageId}）`,
      });
    } catch (error) {
      console.warn("Auto-reply memory write failed:", error);
    }
  }

  private rememberIgnored(accountId: string, messageId: string, summary: string): void {
    try {
      this.options.memory.create({
        kind: "auto-reply-ignored",
        accountId,
        summary: `${summary}（${messageId.slice(0, 12)}…）`,
        detail: `原邮件编号 ${messageId}`,
      });
    } catch (error) {
      console.warn("Auto-reply memory write failed:", error);
    }
  }

  private audit(accountId: string, requestId: string, operation: string, detail: string, outcome: AgentAuditEvent["outcome"], confirmationId?: string): void {
    const event: AgentAuditEvent = {
      id: `audit-${randomUUID()}`,
      requestId,
      occurredAt: this.clock(),
      callerId: autoReplyCaller.callerId,
      callerKind: "service",
      entryPoint: "service",
      operation,
      toolName: "auto-reply",
      accountIds: [accountId],
      outcome,
      ...(confirmationId ? { confirmationId } : {}),
      parametersSummary: detail.slice(0, 240),
    };
    Promise.resolve(this.options.audit.append(event)).catch((error) => {
      console.warn("Auto-reply audit append failed:", error);
    });
  }
}

function parsedFlags(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === "string") : [];
  } catch {
    return [];
  }
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return trimmed.length > 0 ? `Re: ${trimmed}` : "(无主题)";
}

const SCOPE_REASON_TEXT: Record<AutoReplyScopeReason, string> = {
  "outside-date-range": "不在回复日期范围内",
  "not-contact": "发件人不在联系人中",
  "ignore-rule": "命中忽略规则",
  "not-in-whitelist": "不在回复白名单中",
};

function scopeReasonText(reason: AutoReplyScopeReason): string {
  return SCOPE_REASON_TEXT[reason] ?? reason;
}