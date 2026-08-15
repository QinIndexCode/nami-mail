import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db.js";
import {
  decryptMultiAccountAgentRecord,
  encryptMultiAccountAgentRecord,
  canonicalAgentJson,
  AGENT_STORE_CRYPTO_VERSION,
  type AccountEnvelopeScope,
  type EncryptedAccountEnvelope,
} from "./store-crypto.js";
import type { AccountLifecycleStore} from "./lifecycle.js";
import { type AccountGenerationLease } from "./lifecycle.js";
import { assertAgentStoreReadable } from "./schema.js";

export type ConversationRecordKind = "metadata" | "turn" | "tool-call" | "tool-result" | "citation" | "audit" | "regeneration" | "tombstone" | "revoke";

export type ConversationDescriptor = {
  conversationId: string;
  state: "active" | "deleted";
  scopes: Array<{ accountId: string; generation: number }>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type DecryptedConversationRecord = {
  recordId: string;
  kind: ConversationRecordKind;
  sequence: number;
  value: unknown;
  createdAt: string;
};

type ConversationRow = {
  conversation_id: string;
  state: "active" | "deleted";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ScopeRow = {
  account_id: string;
  account_generation: number;
};

type RecordRow = {
  record_id: string;
  conversation_id: string;
  record_kind: ConversationRecordKind;
  sequence: number;
  account_id: string;
  account_generation: number;
  encrypted_payload: string;
  crypto_version: number;
  created_at: string;
};

function ensureIdentifier(value: string, name: string): void {
  if (!value || value.length > 512) throw new Error(`${name} is invalid.`);
}

function scopeIdentity(scope: { accountId: string; generation: number }): string {
  return `${scope.accountId}\0${scope.generation}`;
}

function sortedScopes(scopes: ReadonlyArray<{ accountId: string; generation: number }>): Array<{ accountId: string; generation: number }> {
  return [...scopes].sort((left, right) => left.accountId.localeCompare(right.accountId) || left.generation - right.generation);
}

function sameScopes(
  expected: ReadonlyArray<{ accountId: string; generation: number }>,
  actual: ReadonlyArray<{ accountId: string; generation: number }>,
): boolean {
  const expectedSorted = sortedScopes(expected);
  const actualSorted = sortedScopes(actual);
  return expectedSorted.length === actualSorted.length
    && expectedSorted.every((scope, index) => scopeIdentity(scope) === scopeIdentity(actualSorted[index]!));
}

function asDescriptor(row: ConversationRow, scopes: ScopeRow[]): ConversationDescriptor {
  return {
    conversationId: row.conversation_id,
    state: row.state,
    scopes: scopes.map((scope) => ({ accountId: scope.account_id, generation: scope.account_generation })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * Durable conversation history. Every mail-derived record is duplicated into
 * account-bound envelopes, so a removed source account makes the full record
 * unreadable rather than weakening cross-account privacy.
 */
export class EncryptedConversationStore {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly lifecycle: AccountLifecycleStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private conversationRow(conversationId: string): ConversationRow | undefined {
    return this.db.prepare(`
      SELECT conversation_id, state, created_at, updated_at, deleted_at
      FROM agent_conversations
      WHERE conversation_id = ?
    `).get(conversationId) as ConversationRow | undefined;
  }

  private scopes(conversationId: string): ScopeRow[] {
    return this.db.prepare(`
      SELECT account_id, account_generation
      FROM agent_conversation_scopes
      WHERE conversation_id = ?
      ORDER BY account_id, account_generation
    `).all(conversationId) as ScopeRow[];
  }

  private accountEncryptionScopes(leases: readonly AccountGenerationLease[]): AccountEnvelopeScope[] {
    if (!leases.length) throw new Error("Mail-derived conversations require at least one account.");
    const seen = new Set<string>();
    const scopes: AccountEnvelopeScope[] = [];
    try {
      for (const lease of leases) {
        const identity = scopeIdentity(lease);
        if (seen.has(identity)) throw new Error("Conversation account scope is duplicated.");
        seen.add(identity);
        this.lifecycle.assertCurrent(lease);
        scopes.push({
          accountId: lease.accountId,
          generation: lease.generation,
          accountDek: this.lifecycle.accountDataKey(lease),
        });
      }
      return scopes;
    } catch (error) {
      this.zeroAccountEncryptionScopes(scopes);
      throw error;
    }
  }

  private zeroAccountEncryptionScopes(scopes: readonly AccountEnvelopeScope[]): void {
    for (const scope of scopes) scope.accountDek.fill(0);
  }

  private requireMatchingScopes(conversationId: string, leases: readonly AccountGenerationLease[]): ScopeRow[] {
    const stored = this.scopes(conversationId);
    if (!sameScopes(
      stored.map((scope) => ({ accountId: scope.account_id, generation: scope.account_generation })),
      leases,
    )) {
      throw new Error("Conversation account scope no longer matches the current request.");
    }
    return stored;
  }

  private insertRecord(
    conversationId: string,
    recordId: string,
    kind: ConversationRecordKind,
    sequence: number,
    value: unknown,
    scopes: readonly AccountEnvelopeScope[],
    createdAt: string,
  ): void {
    const plaintext = canonicalAgentJson(value);
    const envelopes = encryptMultiAccountAgentRecord(scopes, "conversation-record", recordId, plaintext);
    const insert = this.db.prepare(`
      INSERT INTO agent_conversation_records (
        record_id, conversation_id, record_kind, sequence, account_id, account_generation,
        encrypted_payload, crypto_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const envelope of envelopes) {
      insert.run(
        recordId,
        conversationId,
        kind,
        sequence,
        envelope.accountId,
        envelope.generation,
        envelope.encryptedPayload,
        envelope.cryptoVersion,
        createdAt,
      );
    }
  }

  create(
    leases: readonly AccountGenerationLease[],
    metadata: unknown,
    conversationId = randomUUID(),
  ): ConversationDescriptor {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    return this.transaction(() => {
      const scopes = this.accountEncryptionScopes(leases);
      try {
        const now = this.clock();
        this.db.prepare(`
          INSERT INTO agent_conversations (conversation_id, state, created_at, updated_at, deleted_at)
          VALUES (?, 'active', ?, ?, NULL)
        `).run(conversationId, now, now);
        const insertScope = this.db.prepare(`
          INSERT INTO agent_conversation_scopes (conversation_id, account_id, account_generation, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const scope of scopes) insertScope.run(conversationId, scope.accountId, scope.generation, now);
        this.insertRecord(conversationId, randomUUID(), "metadata", 0, metadata, scopes, now);
        const row = this.conversationRow(conversationId);
        if (!row) throw new Error("Conversation could not be created.");
        return asDescriptor(row, this.scopes(conversationId));
      } finally {
        this.zeroAccountEncryptionScopes(scopes);
      }
    });
  }

  append(
    conversationId: string,
    leases: readonly AccountGenerationLease[],
    kind: ConversationRecordKind,
    value: unknown,
    recordId: string = randomUUID(),
  ): DecryptedConversationRecord {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    ensureIdentifier(recordId, "Conversation record id");
    return this.transaction(() => {
      const conversation = this.conversationRow(conversationId);
      if (!conversation || conversation.state !== "active") throw new Error("Conversation is unavailable.");
      this.requireMatchingScopes(conversationId, leases);
      const scopes = this.accountEncryptionScopes(leases);
      try {
        const sequenceRow = this.db.prepare(`
          SELECT COALESCE(MAX(sequence), -1) AS last_sequence
          FROM agent_conversation_records
          WHERE conversation_id = ?
        `).get(conversationId) as { last_sequence: number };
        const sequence = sequenceRow.last_sequence + 1;
        const now = this.clock();
        this.insertRecord(conversationId, recordId, kind, sequence, value, scopes, now);
        this.db.prepare("UPDATE agent_conversations SET updated_at = ? WHERE conversation_id = ? AND state = 'active'").run(now, conversationId);
        return { recordId, kind, sequence, value, createdAt: now };
      } finally {
        this.zeroAccountEncryptionScopes(scopes);
      }
    });
  }

  /**
   * Writes (or replaces in place) the single in-progress assistant draft for a
   * conversation. The draft lives in a separate replaceable table so the
   * append-only conversation record log stays immutable: throttled streaming
   * snapshots update this row under one message id, and the finished turn is
   * appended to the durable log while this row is cleared. Mail-derived drafts
   * use the same per-account encryption envelopes as the durable log, so a
   * removed source account still makes the partial reply unreadable.
   */
  upsertStreaming(conversationId: string, leases: readonly AccountGenerationLease[], value: unknown, messageId: string): void {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    ensureIdentifier(messageId, "Conversation message id");
    this.transaction(() => {
      const conversation = this.conversationRow(conversationId);
      if (!conversation || conversation.state !== "active") throw new Error("Conversation is unavailable.");
      this.requireMatchingScopes(conversationId, leases);
      const scopes = this.accountEncryptionScopes(leases);
      try {
        const plaintext = canonicalAgentJson(value);
        const envelopes = encryptMultiAccountAgentRecord(scopes, "conversation-record", messageId, plaintext);
        const now = this.clock();
        this.db.prepare(`
          INSERT OR REPLACE INTO agent_conversation_streaming (
            conversation_id, message_id, encrypted_payload, crypto_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(conversationId, messageId, JSON.stringify(envelopes), AGENT_STORE_CRYPTO_VERSION, now, now);
      } finally {
        this.zeroAccountEncryptionScopes(scopes);
      }
    });
  }

  /** Returns the current in-progress assistant draft, or null when none exists. */
  readStreaming(conversationId: string, leases: readonly AccountGenerationLease[]): unknown | null {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    return this.transaction(() => {
      const conversation = this.conversationRow(conversationId);
      if (!conversation || conversation.state !== "active") throw new Error("Conversation is unavailable.");
      const stored = this.requireMatchingScopes(conversationId, leases);
      const row = this.db.prepare(`
        SELECT message_id, encrypted_payload, crypto_version
        FROM agent_conversation_streaming
        WHERE conversation_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(conversationId) as { message_id: string; encrypted_payload: string; crypto_version: number } | undefined;
      if (!row) return null;
      if (row.crypto_version !== AGENT_STORE_CRYPTO_VERSION) throw new Error("Conversation streaming record has an unsupported format.");
      let envelopes: EncryptedAccountEnvelope[];
      try {
        envelopes = JSON.parse(row.encrypted_payload) as EncryptedAccountEnvelope[];
      } catch {
        throw new Error("Conversation streaming record is invalid.");
      }
      if (!Array.isArray(envelopes) || !sameScopes(
        stored.map((scope) => ({ accountId: scope.account_id, generation: scope.account_generation })),
        envelopes.map((envelope) => ({ accountId: envelope.accountId, generation: envelope.generation })),
      )) {
        throw new Error("Conversation streaming record is missing an account encryption envelope.");
      }
      const leaseByScope = new Map(leases.map((lease) => [scopeIdentity(lease), lease]));
      const plaintext = decryptMultiAccountAgentRecord(envelopes, "conversation-record", row.message_id, (accountId, generation) => {
        const lease = leaseByScope.get(scopeIdentity({ accountId, generation }));
        if (!lease) throw new Error("Conversation account scope is unavailable.");
        this.lifecycle.assertCurrent(lease);
        return this.lifecycle.accountDataKey(lease);
      });
      try {
        return JSON.parse(plaintext) as unknown;
      } catch {
        throw new Error("Conversation streaming record is invalid.");
      }
    });
  }

  /** Removes the in-progress assistant draft once the finished turn is durable. */
  clearStreaming(conversationId: string, leases: readonly AccountGenerationLease[]): void {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    this.transaction(() => {
      const conversation = this.conversationRow(conversationId);
      if (!conversation || conversation.state !== "active") throw new Error("Conversation is unavailable.");
      this.requireMatchingScopes(conversationId, leases);
      this.db.prepare("DELETE FROM agent_conversation_streaming WHERE conversation_id = ?").run(conversationId);
    });
  }

  rename(conversationId: string, leases: readonly AccountGenerationLease[], title: string): DecryptedConversationRecord {
    if (!title.trim() || title.length > 512) throw new Error("Conversation title is invalid.");
    return this.append(conversationId, leases, "metadata", { title: title.trim(), kind: "rename" });
  }

  markDeleted(conversationId: string, leases: readonly AccountGenerationLease[]): ConversationDescriptor {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    return this.transaction(() => {
      const conversation = this.conversationRow(conversationId);
      if (!conversation) throw new Error("Conversation was not found.");
      this.requireMatchingScopes(conversationId, leases);
      if (conversation.state === "deleted") return asDescriptor(conversation, this.scopes(conversationId));
      const scopes = this.accountEncryptionScopes(leases);
      try {
        const now = this.clock();
        const sequenceRow = this.db.prepare(`
          SELECT COALESCE(MAX(sequence), -1) AS last_sequence
          FROM agent_conversation_records WHERE conversation_id = ?
        `).get(conversationId) as { last_sequence: number };
        this.insertRecord(conversationId, randomUUID(), "tombstone", sequenceRow.last_sequence + 1, { reason: "user_deleted" }, scopes, now);
        this.db.prepare("DELETE FROM agent_conversation_streaming WHERE conversation_id = ?").run(conversationId);
        this.db.prepare(`
          UPDATE agent_conversations
          SET state = 'deleted', updated_at = ?, deleted_at = ?
          WHERE conversation_id = ? AND state = 'active'
        `).run(now, now, conversationId);
        const updated = this.conversationRow(conversationId);
        if (!updated) throw new Error("Conversation was not found.");
        return asDescriptor(updated, this.scopes(conversationId));
      } finally {
        this.zeroAccountEncryptionScopes(scopes);
      }
    });
  }

  get(conversationId: string, leases: readonly AccountGenerationLease[]): {
    conversation: ConversationDescriptor;
    records: DecryptedConversationRecord[];
  } {
    assertAgentStoreReadable(this.db);
    ensureIdentifier(conversationId, "Conversation id");
    const conversation = this.conversationRow(conversationId);
    if (!conversation) throw new Error("Conversation was not found.");
    if (conversation.state !== "active") throw new Error("Conversation is unavailable.");
    const scopes = this.requireMatchingScopes(conversationId, leases);
    const leaseByScope = new Map(leases.map((lease) => [scopeIdentity(lease), lease]));
    const records = this.db.prepare(`
      SELECT * FROM agent_conversation_records
      WHERE conversation_id = ?
      ORDER BY sequence, record_id, account_id, account_generation
    `).all(conversationId) as RecordRow[];
    const grouped = new Map<string, RecordRow[]>();
    for (const record of records) {
      const group = grouped.get(record.record_id) ?? [];
      group.push(record);
      grouped.set(record.record_id, group);
    }
    const expectedScopes = scopes.map((scope) => ({ accountId: scope.account_id, generation: scope.account_generation }));
    const decrypted = [...grouped.values()].map((group) => {
      const first = group[0];
      if (!first || !sameScopes(expectedScopes, group.map((row) => ({ accountId: row.account_id, generation: row.account_generation })))) {
        throw new Error("Conversation record is missing an account encryption envelope.");
      }
      const envelopes: EncryptedAccountEnvelope[] = group.map((row) => ({
        accountId: row.account_id,
        generation: row.account_generation,
        encryptedPayload: row.encrypted_payload,
        cryptoVersion: row.crypto_version,
      }));
      const plaintext = decryptMultiAccountAgentRecord(envelopes, "conversation-record", first.record_id, (accountId, generation) => {
        const lease = leaseByScope.get(scopeIdentity({ accountId, generation }));
        if (!lease) throw new Error("Conversation account scope is unavailable.");
        this.lifecycle.assertCurrent(lease);
        return this.lifecycle.accountDataKey(lease);
      });
      let value: unknown;
      try {
        value = JSON.parse(plaintext) as unknown;
      } catch {
        throw new Error("Conversation record is invalid.");
      }
      return {
        recordId: first.record_id,
        kind: first.record_kind,
        sequence: first.sequence,
        value,
        createdAt: first.created_at,
      };
    });
    return { conversation: asDescriptor(conversation, scopes), records: decrypted };
  }

  /** Returns only readable active conversation descriptors without decrypting history. */
  listActive(): ConversationDescriptor[] {
    assertAgentStoreReadable(this.db);
    const conversations = this.db.prepare(`
      SELECT conversation_id, state, created_at, updated_at, deleted_at
      FROM agent_conversations
      WHERE state = 'active'
      ORDER BY updated_at DESC, conversation_id
    `).all() as ConversationRow[];
    const readable: ConversationDescriptor[] = [];
    for (const conversation of conversations) {
      const scopes = this.scopes(conversation.conversation_id);
      if (!scopes.length) continue;
      try {
        for (const scope of scopes) {
          this.lifecycle.assertCurrent({ accountId: scope.account_id, generation: scope.account_generation });
        }
      } catch {
        // A deleted or changed source account makes the entire conversation unavailable.
        continue;
      }
      readable.push(asDescriptor(conversation, scopes));
    }
    return readable;
  }
}
