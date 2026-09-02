/**
 * Encrypted audit of auto-reply declines and failures. Every message the
 * pipeline decided NOT to answer (plus send failures) is recorded here so the
 * user can review what the Agent skipped and why. Rows are device-wide like
 * Agent memory (root master-key envelope, no account DEK); the plaintext
 * columns only carry what is safe to filter by in SQL.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db.js";
import { assertAgentStoreReadable } from "./schema.js";
import {
  canonicalAgentJson,
  decryptRootAgentRecord,
  encryptRootAgentRecord,
} from "./store-crypto.js";

const DECISION_RECORD_TYPE = "auto-reply-decision";
const DECISION_MAX_RECORDS = 2_000;

export const autoReplyDecisionReasons = [
  "screening",
  "scope",
  "low-value",
  "sensitive",
  "user-rejected",
  "daily-cap",
  "llm-failed",
  "send-failed",
  "no-template",
  "expired",
] as const;

export type AutoReplyDecisionReason = (typeof autoReplyDecisionReasons)[number];

export type AutoReplyDecisionRecord = {
  id: string;
  messageId: string;
  accountId: string;
  threadKey: string;
  reason: AutoReplyDecisionReason;
  fromAddress: string;
  fromName: string;
  subject: string;
  detail: string;
  occurredAt: string;
  createdAt: string;
};

export type AutoReplyDecisionCreateInput = {
  messageId: string;
  accountId: string;
  threadKey: string;
  reason: AutoReplyDecisionReason;
  fromAddress?: string;
  fromName?: string;
  subject?: string;
  detail?: string;
  occurredAt?: string;
};

export type AutoReplyDecisionListOptions = {
  accountId?: string;
  reason?: AutoReplyDecisionReason;
  query?: string;
  fromAddress?: string;
  subject?: string;
  limit?: number;
};

type DecisionRow = {
  id: string;
  message_id: string;
  account_id: string;
  thread_key: string;
  reason: string;
  encrypted_payload: string;
  occurred_at: string;
  created_at: string;
};

const DECISION_REASON_SET = new Set<string>(autoReplyDecisionReasons);

export const autoReplyDecisionReasonText: Record<AutoReplyDecisionReason, string> = {
  "screening": "被离线规则拦截（垃圾/营销/自动消息等）",
  "scope": "不符合回复范围规则",
  "low-value": "Agent 判断来信价值较低",
  "sensitive": "涉及敏感内容，Agent 未起草回复",
  "user-rejected": "你拒绝了确认",
  "daily-cap": "当日自动回复已达上限",
  "llm-failed": "Agent 评估失败",
  "send-failed": "发送失败",
  "no-template": "模板为空，无法回复",
  "expired": "确认已过期",
};

function encryptDecision(masterKey: Buffer, recordId: string, value: unknown): string {
  const plaintext = canonicalAgentJson(value);
  return JSON.stringify({
    format: "nami-agent-root-envelope-v1",
    encryptedPayload: encryptRootAgentRecord(masterKey, DECISION_RECORD_TYPE, recordId, plaintext),
  });
}

function decryptDecision(masterKey: Buffer, recordId: string, encryptedEnvelope: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encryptedEnvelope) as unknown;
  } catch {
    throw new Error("Auto-reply decision envelope is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Auto-reply decision envelope is invalid.");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== "nami-agent-root-envelope-v1" || typeof envelope.encryptedPayload !== "string") {
    throw new Error("Auto-reply decision envelope is invalid.");
  }
  const plaintext = decryptRootAgentRecord(masterKey, DECISION_RECORD_TYPE, recordId, envelope.encryptedPayload);
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error("Decrypted auto-reply decision is invalid.");
  }
}

export class EncryptedAutoReplyDecisionStore {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private decode(row: DecisionRow): AutoReplyDecisionRecord {
    if (!DECISION_REASON_SET.has(row.reason)) throw new Error("Auto-reply decision reason is inconsistent.");
    const parsed = decryptDecision(this.masterKey, row.id, row.encrypted_payload) as Record<string, unknown>;
    const record: AutoReplyDecisionRecord = {
      id: row.id,
      messageId: String(parsed.messageId ?? row.message_id),
      accountId: String(parsed.accountId ?? row.account_id),
      threadKey: String(parsed.threadKey ?? row.thread_key),
      reason: row.reason as AutoReplyDecisionReason,
      fromAddress: parsed.fromAddress === undefined ? "" : String(parsed.fromAddress),
      fromName: parsed.fromName === undefined ? "" : String(parsed.fromName),
      subject: parsed.subject === undefined ? "" : String(parsed.subject),
      detail: parsed.detail === undefined ? "" : String(parsed.detail),
      occurredAt: String(parsed.occurredAt ?? row.occurred_at),
      createdAt: String(parsed.createdAt ?? row.created_at),
    };
    return record;
  }

  create(input: AutoReplyDecisionCreateInput): AutoReplyDecisionRecord {
    assertAgentStoreReadable(this.db);
    const now = this.clock();
    const id = randomUUID();
    const record: AutoReplyDecisionRecord = {
      id,
      messageId: input.messageId,
      accountId: input.accountId,
      threadKey: input.threadKey,
      reason: input.reason,
      fromAddress: input.fromAddress ?? "",
      fromName: input.fromName ?? "",
      subject: input.subject ?? "",
      detail: input.detail ?? "",
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO auto_reply_decisions (
          id, message_id, account_id, thread_key, reason, encrypted_payload,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.messageId,
        record.accountId,
        record.threadKey,
        record.reason,
        encryptDecision(this.masterKey, record.id, record),
        record.occurredAt,
        record.createdAt,
      );
      this.trimToLimit();
      return record;
    })();
  }

  list(options: AutoReplyDecisionListOptions = {}): AutoReplyDecisionRecord[] {
    assertAgentStoreReadable(this.db);
    const rows = this.db.prepare(`
      SELECT id, message_id, account_id, thread_key, reason, encrypted_payload, occurred_at, created_at
      FROM auto_reply_decisions
      ORDER BY occurred_at DESC, id
    `).all() as DecisionRow[];
    const needle = options.query?.trim().toLowerCase() ?? "";
    const fromNeedle = options.fromAddress?.trim().toLowerCase() ?? "";
    const subjectNeedle = options.subject?.trim().toLowerCase() ?? "";
    const records: AutoReplyDecisionRecord[] = [];
    for (const row of rows) {
      if (options.accountId && row.account_id !== options.accountId) continue;
      if (options.reason && row.reason !== options.reason) continue;
      let record: AutoReplyDecisionRecord;
      try {
        record = this.decode(row);
      } catch {
        continue;
      }
      if (needle) {
        const haystack = `${record.fromAddress} ${record.fromName} ${record.subject} ${record.detail}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      if (fromNeedle && !record.fromAddress.toLowerCase().includes(fromNeedle)) continue;
      if (subjectNeedle && !record.subject.toLowerCase().includes(subjectNeedle)) continue;
      records.push(record);
    }
    if (options.limit !== undefined && records.length > options.limit) return records.slice(0, options.limit);
    return records;
  }

  get(recordId: string): AutoReplyDecisionRecord {
    assertAgentStoreReadable(this.db);
    const row = this.db.prepare(`
      SELECT id, message_id, account_id, thread_key, reason, encrypted_payload, occurred_at, created_at
      FROM auto_reply_decisions WHERE id = ?
    `).get(recordId) as DecisionRow | undefined;
    if (!row) throw new Error("Auto-reply decision was not found.");
    return this.decode(row);
  }

  delete(recordId: string): boolean {
    assertAgentStoreReadable(this.db);
    return this.db.prepare("DELETE FROM auto_reply_decisions WHERE id = ?").run(recordId).changes > 0;
  }

  clear(): number {
    assertAgentStoreReadable(this.db);
    return this.db.prepare("DELETE FROM auto_reply_decisions").run().changes;
  }

  /**
   * Thread-once check: a thread the user explicitly rejected stays blocked
   * forever so the Agent does not nag the same conversation again.
   */
  hasThreadRejected(threadKey: string): boolean {
    assertAgentStoreReadable(this.db);
    const row = this.db.prepare(`
      SELECT 1 FROM auto_reply_decisions
      WHERE thread_key = ? AND reason = 'user-rejected'
      LIMIT 1
    `).get(threadKey) as { "1": unknown } | undefined;
    return Boolean(row);
  }

  private trimToLimit(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM auto_reply_decisions").get() as { count: number };
    const excess = count.count - DECISION_MAX_RECORDS;
    if (excess <= 0) return;
    this.db.prepare(`
      DELETE FROM auto_reply_decisions
      WHERE id IN (
        SELECT id FROM auto_reply_decisions
        ORDER BY occurred_at ASC, id
        LIMIT ?
      )
    `).run(excess);
  }
}
