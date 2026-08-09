import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db.js";
import {
  agentMemoryPatchSchema,
  agentMemoryRecordSchema,
  type AgentMemoryKind,
  type AgentMemoryPatch,
  type AgentMemoryRecord,
} from "@nami/agent-contracts";
import { assertAgentStoreReadable } from "./schema.js";
import {
  AGENT_STORE_CRYPTO_VERSION,
  canonicalAgentJson,
  decryptRootAgentRecord,
  encryptRootAgentRecord,
} from "./store-crypto.js";

const MEMORY_RECORD_TYPE = "agent-memory";
const MEMORY_MAX_RECORDS = 500;

export type AgentMemoryCreateInput = {
  kind?: AgentMemoryKind;
  accountId?: string;
  summary: string;
  detail?: string;
  occurredAt?: string;
};

export type AgentMemoryListOptions = {
  kind?: AgentMemoryKind;
  accountId?: string;
  query?: string;
  limit?: number;
};

type MemoryRow = {
  record_id: string;
  record_kind: string;
  account_id: string | null;
  encrypted_payload: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
};

function encryptMemoryRecord(masterKey: Buffer, recordId: string, value: unknown): string {
  const plaintext = canonicalAgentJson(value);
  return JSON.stringify({
    format: "nami-agent-root-envelope-v1",
    encryptedPayload: encryptRootAgentRecord(masterKey, MEMORY_RECORD_TYPE, recordId, plaintext),
  });
}

function decryptMemoryRecord(masterKey: Buffer, recordId: string, encryptedEnvelope: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encryptedEnvelope) as unknown;
  } catch {
    throw new Error("Agent memory record envelope is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent memory record envelope is invalid.");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== "nami-agent-root-envelope-v1" || typeof envelope.encryptedPayload !== "string") {
    throw new Error("Agent memory record envelope is invalid.");
  }
  const plaintext = decryptRootAgentRecord(masterKey, MEMORY_RECORD_TYPE, recordId, envelope.encryptedPayload);
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error("Decrypted Agent memory record is invalid.");
  }
}

/**
 * Durable, editable Agent memory. Records are device-wide (root master-key
 * envelope, no account DEK), so deleting a mail account never makes the memory
 * unreadable. Summaries can be patched and records deleted by the user; the
 * immutable audit trail stays in EncryptedAgentAuditStore.
 */
export class EncryptedAgentMemoryStore {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private row(recordId: string): MemoryRow | undefined {
    return this.db.prepare(`
      SELECT record_id, record_kind, account_id, encrypted_payload, occurred_at, created_at, updated_at
      FROM agent_memory_records
      WHERE record_id = ?
    `).get(recordId) as MemoryRow | undefined;
  }

  private decode(row: MemoryRow): AgentMemoryRecord {
    const record = agentMemoryRecordSchema.parse(decryptMemoryRecord(this.masterKey, row.record_id, row.encrypted_payload));
    if (record.kind !== row.record_kind) throw new Error("Agent memory record kind is inconsistent.");
    return record;
  }

  create(input: AgentMemoryCreateInput): AgentMemoryRecord {
    assertAgentStoreReadable(this.db);
    const now = this.clock();
    const record = agentMemoryRecordSchema.parse({
      id: randomUUID(),
      kind: input.kind ?? "note",
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      summary: input.summary,
      detail: input.detail ?? "",
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    });
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_memory_records (
          record_id, record_kind, account_id, encrypted_payload, crypto_version,
          occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.kind,
        record.accountId ?? null,
        encryptMemoryRecord(this.masterKey, record.id, record),
        AGENT_STORE_CRYPTO_VERSION,
        record.occurredAt,
        record.createdAt,
        record.createdAt,
      );
      this.trimToLimit();
      return record;
    });
  }

  list(options: AgentMemoryListOptions = {}): AgentMemoryRecord[] {
    assertAgentStoreReadable(this.db);
    const rows = this.db.prepare(`
      SELECT record_id, record_kind, account_id, encrypted_payload, occurred_at, created_at, updated_at
      FROM agent_memory_records
      ORDER BY occurred_at DESC, record_id
    `).all() as MemoryRow[];
    const records: AgentMemoryRecord[] = [];
    for (const row of rows) {
      let record: AgentMemoryRecord;
      try {
        record = this.decode(row);
      } catch {
        continue;
      }
      if (options.kind && record.kind !== options.kind) continue;
      if (options.accountId && record.accountId !== options.accountId) continue;
      if (options.query) {
        const needle = options.query.trim().toLowerCase();
        if (!needle) continue;
        if (!record.summary.toLowerCase().includes(needle) && !record.detail.toLowerCase().includes(needle)) continue;
      }
      records.push(record);
    }
    if (options.limit !== undefined && records.length > options.limit) return records.slice(0, options.limit);
    return records;
  }

  get(recordId: string): AgentMemoryRecord {
    assertAgentStoreReadable(this.db);
    const row = this.row(recordId);
    if (!row) throw new Error("Agent memory record was not found.");
    return this.decode(row);
  }

  patchSummary(recordId: string, summary: string): AgentMemoryRecord {
    return this.update(recordId, { summary });
  }

  /**
   * Patches one or more editable fields of an existing memory record.
   * At least one of summary or detail must be present (validated by the
   * patch schema); records never carry a user-visible updatedAt.
   */
  update(recordId: string, patch: AgentMemoryPatch): AgentMemoryRecord {
    assertAgentStoreReadable(this.db);
    const parsed = agentMemoryPatchSchema.parse(patch);
    return this.transaction(() => {
      const row = this.row(recordId);
      if (!row) throw new Error("Agent memory record was not found.");
      const existing = this.decode(row);
      const updated: AgentMemoryRecord = {
        ...existing,
        ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
        ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
      };
      const now = this.clock();
      this.db.prepare(`
        UPDATE agent_memory_records
        SET encrypted_payload = ?, updated_at = ?
        WHERE record_id = ?
      `).run(encryptMemoryRecord(this.masterKey, recordId, updated), now, recordId);
      return updated;
    });
  }

  delete(recordId: string): void {
    assertAgentStoreReadable(this.db);
    const result = this.db.prepare("DELETE FROM agent_memory_records WHERE record_id = ?").run(recordId);
    if (result.changes === 0) throw new Error("Agent memory record was not found.");
  }

  clear(): number {
    assertAgentStoreReadable(this.db);
    return this.db.prepare("DELETE FROM agent_memory_records").run().changes;
  }

  /** Keeps the memory bounded by dropping the oldest records after each insert. */
  private trimToLimit(): void {    const count = this.db.prepare("SELECT COUNT(*) AS count FROM agent_memory_records").get() as { count: number };
    const excess = count.count - MEMORY_MAX_RECORDS;
    if (excess <= 0) return;
    this.db.prepare(`
      DELETE FROM agent_memory_records
      WHERE record_id IN (
        SELECT record_id FROM agent_memory_records
        ORDER BY occurred_at ASC, record_id
        LIMIT ?
      )
    `).run(excess);
  }
}

/**
 * Shared recall formatting for every consumer that injects memory into an LLM
 * prompt (interactive turns in AgentService, auto-reply evaluation). Keeps the
 * bullet format and access path single-sourced so the two paths cannot drift.
 */
export function buildMemoryContextLines(
  store: Pick<EncryptedAgentMemoryStore, "list">,
  options: AgentMemoryListOptions = {},
): string[] {
  return store.list(options).map((record) => `- ${record.summary}`);
}
