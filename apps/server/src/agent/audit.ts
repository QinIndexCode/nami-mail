import type { AgentAuditEvent } from "@nami/agent-contracts";
import type { AgentAuditSink } from "@nami/agent-core";
import type { DatabaseHandle } from "../db.js";
import { AccountLifecycleStore } from "./lifecycle.js";
import { decryptPersistentAgentRecord, encryptPersistentAgentRecord } from "./record-envelopes.js";
import { agentOpaqueDigest, canonicalAgentJson } from "./store-crypto.js";
import { assertAgentStoreReadable } from "./schema.js";

type AuditIntentRow = {
  intent_id: string;
  account_id: string | null;
  account_generation: number | null;
  action_type: string;
  request_fingerprint: string;
  encrypted_details: string;
  crypto_version: number;
  created_at: string;
};

function validAuditEvent(event: AgentAuditEvent): void {
  if (!event.id || !event.requestId || !event.operation || !event.callerId) {
    throw new Error("Agent audit event is incomplete.");
  }
  if (new Set(event.accountIds).size !== event.accountIds.length) {
    throw new Error("Agent audit account scope contains duplicates.");
  }
}

function firstAccountGeneration(lifecycle: AccountLifecycleStore, accountIds: readonly string[]): number | null {
  if (!accountIds.length) return null;
  return lifecycle.acquireLease(accountIds[0]!).generation;
}

/**
 * Derives the one durable intent id shared by the immutable intent record and
 * every later audit event for the same invocation. Runtime event ids remain
 * unique receipt ids and must never be used as a cross-event foreign key.
 */
export function auditIntentIdFor(masterKey: Buffer, event: AgentAuditEvent): string {
  validAuditEvent(event);
  return `intent.${agentOpaqueDigest(
    masterKey,
    "audit-intent-id",
    canonicalAgentJson({
      requestId: event.requestId,
      operation: event.operation,
      toolName: event.toolName ?? null,
      toolCallId: event.toolCallId ?? null,
      accountIds: [...event.accountIds].sort(),
    }),
  )}`;
}

/**
 * Durable audit sink for Agent Core. Payloads are encrypted and any
 * account-scoped details require all scoped account keys to remain available.
 */
export class EncryptedAgentAuditStore implements AgentAuditSink {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly lifecycle: AccountLifecycleStore,
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  async append(event: AgentAuditEvent): Promise<void> {
    this.appendSync(event);
  }

  appendSync(event: AgentAuditEvent): void {
    assertAgentStoreReadable(this.db);
    validAuditEvent(event);
    this.transaction(() => {
      const intentId = auditIntentIdFor(this.masterKey, event);
      const requestFingerprint = agentOpaqueDigest(
        this.masterKey,
        "audit-request",
        canonicalAgentJson({ requestId: event.requestId, operation: event.operation, toolCallId: event.toolCallId ?? null }),
      );
      const details = encryptPersistentAgentRecord(
        this.masterKey,
        this.lifecycle,
        event.accountIds,
        event.outcome === "intent" ? "audit-intent" : "audit-event",
        event.outcome === "intent" ? intentId : event.id,
        event,
      );
      const accountId = event.accountIds[0] ?? null;
      const accountGeneration = firstAccountGeneration(this.lifecycle, event.accountIds);
      if (event.outcome === "intent") {
        this.db.prepare(`
          INSERT INTO agent_audit_intents (
            intent_id, account_id, account_generation, action_type, request_fingerprint,
            encrypted_details, crypto_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(intent_id) DO NOTHING
        `).run(intentId, accountId, accountGeneration, event.operation, requestFingerprint, details, event.occurredAt);
      }
      this.db.prepare(`
        INSERT INTO agent_audit_events (
          event_id, intent_id, event_type, encrypted_details, crypto_version, created_at
        ) VALUES (?, ?, ?, ?, 1, ?)
      `).run(
        event.id,
        intentId,
        event.outcome,
        details,
        event.occurredAt,
      );
    });
  }

  intentIdFor(event: AgentAuditEvent): string {
    return auditIntentIdFor(this.masterKey, event);
  }

  intent(intentId: string): AgentAuditEvent | undefined {
    assertAgentStoreReadable(this.db);
    const row = this.db.prepare(`
      SELECT * FROM agent_audit_intents WHERE intent_id = ?
    `).get(intentId) as AuditIntentRow | undefined;
    if (!row) return undefined;
    const value = decryptPersistentAgentRecord(
      this.masterKey,
      this.lifecycle,
      "audit-intent",
      row.intent_id,
      row.encrypted_details,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Encrypted Agent audit intent is invalid.");
    return value as AgentAuditEvent;
  }
}
