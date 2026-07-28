import type { Citation } from "@nami/agent-contracts";
import type { DatabaseHandle } from "../db.js";
import { agentOpaqueDigest, canonicalAgentJson } from "./store-crypto.js";
import { assertAgentStoreReadable } from "./schema.js";

export type StoredCitationReference = {
  citation: Citation;
  accountGeneration: number;
  sourceRevision: string | number;
};

export type CitationSourceState = {
  accountId: string;
  accountGeneration: number;
  sourceRevision: string;
  deleted: boolean;
};

export type CitationRevalidationResult =
  | { valid: true; citation: Citation }
  | { valid: false; citation: Citation; reason: "account_unavailable" | "generation_changed" | "message_deleted" | "revision_changed" | "source_state_missing" };

export interface CitationAuthority {
  stateFor(reference: StoredCitationReference): CitationSourceState | undefined;
}

/** Revalidates every source relation before a citation is returned to an Agent or UI. */
export class CitationRevalidator {
  constructor(private readonly authority: CitationAuthority) {}

  revalidate(reference: StoredCitationReference): CitationRevalidationResult {
    const state = this.authority.stateFor(reference);
    if (!state) return { valid: false, citation: reference.citation, reason: "source_state_missing" };
    if (state.accountId !== reference.citation.accountId) {
      return { valid: false, citation: reference.citation, reason: "account_unavailable" };
    }
    if (state.accountGeneration !== reference.accountGeneration) {
      return { valid: false, citation: reference.citation, reason: "generation_changed" };
    }
    if (state.deleted) return { valid: false, citation: reference.citation, reason: "message_deleted" };
    if (state.sourceRevision !== String(reference.sourceRevision)) {
      return { valid: false, citation: reference.citation, reason: "revision_changed" };
    }
    return { valid: true, citation: reference.citation };
  }

  revalidateAll(references: readonly StoredCitationReference[]): {
    valid: Citation[];
    invalid: Extract<CitationRevalidationResult, { valid: false }>[];
  } {
    const valid: Citation[] = [];
    const invalid: Extract<CitationRevalidationResult, { valid: false }>[] = [];
    for (const reference of references) {
      const result = this.revalidate(reference);
      if (result.valid) valid.push(result.citation);
      else invalid.push(result);
    }
    return { valid, invalid };
  }
}

type LifecycleRow = {
  generation: number;
  state: "active" | "deleting" | "deleted";
};

type SourceEventRow = {
  source_revision: string;
  event_type: "message-upserted" | "message-deleted" | "attachment-upserted" | "attachment-deleted" | "account-generation-advanced" | "account-deleted";
};

/**
 * A SQLite authority that verifies the encrypted RAG reference against both
 * the primary mail row and the durable local source-event history. It returns
 * no plaintext message content.
 */
export class SqliteCitationAuthority implements CitationAuthority {
  constructor(private readonly db: DatabaseHandle, private readonly masterKey: Buffer) {}

  stateFor(reference: StoredCitationReference): CitationSourceState | undefined {
    assertAgentStoreReadable(this.db);
    const account = this.db.prepare(`
      SELECT generation, state FROM agent_account_lifecycle WHERE account_id = ?
    `).get(reference.citation.accountId) as LifecycleRow | undefined;
    if (!account || account.state !== "active") return undefined;
    const message = this.db.prepare(`
      SELECT 1 FROM messages WHERE id = ? AND account_id = ?
    `).get(reference.citation.messageId, reference.citation.accountId);
    const sourceLocatorOpaque = agentOpaqueDigest(
      this.masterKey,
      "source-locator",
      canonicalAgentJson({
        accountId: reference.citation.accountId,
        source: { kind: "message", messageId: reference.citation.messageId },
      }),
    );
    const event = this.db.prepare(`
      SELECT source_revision, event_type
      FROM agent_source_events
      WHERE account_id = ? AND account_generation = ? AND source_locator_opaque = ?
        AND event_type IN ('message-upserted', 'message-deleted')
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT 1
    `).get(reference.citation.accountId, account.generation, sourceLocatorOpaque) as SourceEventRow | undefined;
    if (!event) return undefined;
    return {
      accountId: reference.citation.accountId,
      accountGeneration: account.generation,
      sourceRevision: event.source_revision,
      deleted: !message || event.event_type === "message-deleted",
    };
  }
}
