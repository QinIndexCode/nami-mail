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
import type { AgentAuditEvent, CallerContext, ConfirmationDecision, ConfirmationRequest } from "@nami/agent-contracts";
import type { DatabaseHandle } from "../db.js";
import { messagePayloadById, payloadHeaders } from "../message-storage.js";
import { getAppSettings } from "../settings.js";
import type { EncryptedAgentAuditStore } from "./audit.js";
import { buildMemoryContextLines, type EncryptedAgentMemoryStore } from "./memory.js";
import type { ImmutableGuiConfirmationStore } from "./confirmations.js";
import { canonicalAgentJson } from "./store-crypto.js";
import type { MailApplicationContext, MailApplicationService } from "./mail-application-service.js";
import { autoReplyThreadKey, scanSensitiveKeywords, screenAutoReply, screeningIgnoreReasonText } from "./auto-reply-screening.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const THREAD_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1_000;
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
  confirmationStore?: ImmutableGuiConfirmationStore;
  desktopConfirmation?: Readonly<{ capability: unknown }>;
  clock?: () => string;
};

export type AutoReplyResolution = { ok: true } | { decision: "not-found" | "expired" | "failed" };

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
 * engine only exists when a verified desktop confirmation capability is
 * wired in (see runtime.ts), and resolutions reach it solely through the
 * desktop IPC bridge after the main process verified a visible window, so
 * recording as the desktop surface mirrors the conversational path where
 * `pending.caller` is the original desktop-ui caller.
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
      await this.processMessage(accountId, messageId, config.dailyLimitPerAccount);
    }
  }

  resolveConfirmation(confirmationId: string, decision: "approve" | "reject"): AutoReplyResolution {
    const pending = this.pending.get(confirmationId);
    if (!pending || !this.options.confirmationStore || !this.options.desktopConfirmation) {
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
      this.options.confirmationStore.recordDecision(receipt, autoReplyDesktopCaller, this.options.desktopConfirmation.capability);
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

  private async processMessage(accountId: string, messageId: string, dailyLimit: number): Promise<void> {
    if (this.sentToday(accountId) >= dailyLimit) {
      this.recordLedger(messageId, accountId, "ignored", "message-only");
      this.rememberIgnored(accountId, messageId, "每日自动回复上限已达，本轮不再发送。");
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
      return;
    }
    const threadKey = screening.threadKey ?? `subject:${payload.subject}`;
    if (this.recentThreadSent(threadKey)) {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      return;
    }
    const hints = scanSensitiveKeywords(payload.subject, payload.fromAddress, payload.textBody.slice(0, 2_000));
    let memoryContext = "";
    try {
      memoryContext = buildMemoryContextLines(this.options.memory, { query: payload.subject, limit: 6 }).join("\n");
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
      return;
    }
    const replyText = evaluation.replyText?.trim();
    if (evaluation.replyValue !== "high" || !replyText) {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      this.rememberIgnored(accountId, messageId, `来信价值较低，Agent 判断无需回复：${payload.subject}`);
      return;
    }
    await this.requestConfirmation(accountId, messageId, payload, replyText, evaluation.sensitive === true, threadKey);
  }

  private async requestConfirmation(
    accountId: string,
    messageId: string,
    payload: { subject: string; fromName: string; fromAddress: string; inReplyTo: string | null; references: readonly string[] | null },
    replyText: string,
    sensitive: boolean,
    threadKey: string,
  ): Promise<void> {
    if (!this.options.confirmationStore || !this.options.desktopConfirmation) {
      this.recordLedger(messageId, accountId, "failed", threadKey);
      this.rememberIgnored(accountId, messageId, "桌面确认通道不可用，未发送自动回复。");
      return;
    }
    const confirmation = this.buildRequest(accountId, messageId, payload, replyText, sensitive);
    let resolveOutcome!: (outcome: "approved" | "rejected" | "expired" | "cancelled") => void;
    const outcomePromise = new Promise<"approved" | "rejected" | "expired" | "cancelled">((resolve) => {
      resolveOutcome = resolve;
    });
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
      settle: resolveOutcome,
    };
    this.pending.set(confirmation.id, pending);
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
      return;
    }
    const outcome = await outcomePromise;
    this.pending.delete(confirmation.id);
    const timer = this.timers.get(confirmation.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(confirmation.id);
    if (outcome === "approved") {
      await this.sendReply(pending, threadKey);
    } else if (outcome === "rejected") {
      this.recordLedger(messageId, accountId, "ignored", threadKey);
      this.rememberIgnored(accountId, messageId, `用户拒绝了自动回复：${payload.subject}`);
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
    } catch (error) {
      console.warn(`Auto-reply send failed for ${pending.messageId}:`, error);
      this.recordLedger(pending.messageId, pending.accountId, "failed", threadKey);
      this.audit(pending.accountId, pending.confirmation.requestId, "auto-reply.send", "发送失败", "failed", pending.confirmation.id);
      this.rememberIgnored(pending.accountId, pending.messageId, `自动回复发送失败：${pending.subject}`);
    }
  }

  private expirePending(confirmationId: string): void {
    const pending = this.pending.get(confirmationId);
    if (!pending) return;
    this.recordExpired(pending, this.clock());
  }

  private recordExpired(pending: EnginePending, nowIso: string): void {
    if (!this.options.confirmationStore || !this.options.desktopConfirmation) {
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
      this.options.confirmationStore.recordDecision(receipt, autoReplyDesktopCaller, this.options.desktopConfirmation.capability);
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

  private recentThreadSent(threadKey: string): boolean {
    const cutoff = new Date(Date.now() - THREAD_DEDUP_WINDOW_MS).toISOString();
    const row = this.options.db.prepare(`
      SELECT 1 FROM auto_reply_processed
      WHERE thread_key = ? AND decision = 'sent' AND occurred_at >= ?
      LIMIT 1
    `).get(threadKey, cutoff) as { "1": unknown } | undefined;
    return Boolean(row);
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