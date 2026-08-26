import type { DatabaseHandle } from "../db.js";
import type { AccountLifecycleStore} from "./lifecycle.js";
import { type AccountGenerationLease } from "./lifecycle.js";
import {
  agentOpaqueDigest,
  canonicalAgentJson,
  decryptAccountAgentRecord,
  encryptAccountAgentRecord,
} from "./store-crypto.js";
import { assertAgentStoreReadable } from "./schema.js";

export type EncryptedRagPageInput = {
  lease: AccountGenerationLease;
  pageId: string;
  pageRevision: number;
  pageKind: string;
  payload: unknown;
};

export type RagPageMetadata = {
  accountId: string;
  accountGeneration: number;
  pageId: string;
  pageRevision: number;
  pageKind: string;
  contentDigest: string;
  state: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type DecryptedRagPage = RagPageMetadata & { payload: unknown };

type StoredRagPageRow = {
  account_id: string;
  account_generation: number;
  page_id: string;
  page_revision: number;
  page_kind: string;
  encrypted_payload: string;
  crypto_version: number;
  content_digest: string;
  state: "active" | "deleted";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export const insertEncryptedRagPageSql = `
INSERT INTO agent_rag_pages (
  account_id, account_generation, page_id, page_revision, page_kind,
  encrypted_payload, crypto_version, content_digest, state, created_at, updated_at, deleted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
`;

function validateString(value: string, name: string, maximum = 512): void {
  if (!value || value.length > maximum) throw new Error(`${name} is invalid.`);
}

function validatePageRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("RAG page revision is invalid.");
}

function pageRecordId(pageId: string, pageRevision: number): string {
  return `${pageId}@${pageRevision}`;
}

function metadata(row: StoredRagPageRow): RagPageMetadata {
  return {
    accountId: row.account_id,
    accountGeneration: row.account_generation,
    pageId: row.page_id,
    pageRevision: row.page_revision,
    pageKind: row.page_kind,
    contentDigest: row.content_digest,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * Persistent RAG pages are always encrypted with an account DEK. Semantic
 * vectors and full-text structures belong to a process-local index only and
 * are rebuilt from these authenticated pages after a restart.
 */
export class EncryptedRagPageStore {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly lifecycle: AccountLifecycleStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private currentRow(lease: AccountGenerationLease, pageId: string): StoredRagPageRow | undefined {
    return this.db.prepare(`
      SELECT * FROM agent_rag_pages
      WHERE account_id = ? AND account_generation = ? AND page_id = ?
      ORDER BY page_revision DESC
      LIMIT 1
    `).get(lease.accountId, lease.generation, pageId) as StoredRagPageRow | undefined;
  }

  put(input: EncryptedRagPageInput): RagPageMetadata {
    assertAgentStoreReadable(this.db);
    validateString(input.pageId, "RAG page id");
    validateString(input.pageKind, "RAG page kind", 128);
    validatePageRevision(input.pageRevision);
    return this.transaction(() => {
      this.lifecycle.assertCurrent(input.lease);
      const plaintext = canonicalAgentJson(input.payload);
      const contentDigest = agentOpaqueDigest(this.masterKey, "rag-page-content", plaintext);
      const existing = this.db.prepare(`
        SELECT * FROM agent_rag_pages
        WHERE account_id = ? AND account_generation = ? AND page_id = ? AND page_revision = ?
      `).get(
        input.lease.accountId,
        input.lease.generation,
        input.pageId,
        input.pageRevision,
      ) as StoredRagPageRow | undefined;
      if (existing) {
        if (existing.content_digest !== contentDigest || existing.state !== "active") {
          throw new Error("RAG page revision already exists with different content.");
        }
        return metadata(existing);
      }
      const current = this.currentRow(input.lease, input.pageId);
      if (current && input.pageRevision <= current.page_revision) {
        throw new Error("RAG page revision must advance monotonically.");
      }
      const accountDek = this.lifecycle.accountDataKey(input.lease);
      try {
        const encryptedPayload = encryptAccountAgentRecord(
          accountDek,
          input.lease.accountId,
          input.lease.generation,
          "rag-page",
          pageRecordId(input.pageId, input.pageRevision),
          plaintext,
        );
        const now = this.clock();
        this.db.prepare(insertEncryptedRagPageSql).run(
          input.lease.accountId,
          input.lease.generation,
          input.pageId,
          input.pageRevision,
          input.pageKind,
          encryptedPayload,
          1,
          contentDigest,
          now,
          now,
        );
      } finally {
        accountDek.fill(0);
      }
      const stored = this.currentRow(input.lease, input.pageId);
      if (!stored || stored.page_revision !== input.pageRevision) throw new Error("RAG page could not be persisted.");
      return metadata(stored);
    });
  }

  get(lease: AccountGenerationLease, pageId: string): DecryptedRagPage | undefined {
    assertAgentStoreReadable(this.db);
    validateString(pageId, "RAG page id");
    this.lifecycle.assertCurrent(lease);
    const row = this.currentRow(lease, pageId);
    if (!row || row.state !== "active") return undefined;
    if (row.crypto_version !== 1) throw new Error("Encrypted RAG page has an unsupported format.");
    const accountDek = this.lifecycle.accountDataKey(lease);
    try {
      const plaintext = decryptAccountAgentRecord(
        accountDek,
        lease.accountId,
        lease.generation,
        "rag-page",
        pageRecordId(row.page_id, row.page_revision),
        row.encrypted_payload,
      );
      let payload: unknown;
      try {
        payload = JSON.parse(plaintext) as unknown;
      } catch {
        throw new Error("Encrypted RAG page is invalid.");
      }
      // The row may have been invalidated while it was decrypted. The caller
      // must never receive old-account content after a deletion race.
      this.lifecycle.assertCurrent(lease);
      return { ...metadata(row), payload };
    } finally {
      accountDek.fill(0);
    }
  }

  listMetadata(lease: AccountGenerationLease): RagPageMetadata[] {
    assertAgentStoreReadable(this.db);
    this.lifecycle.assertCurrent(lease);
    return (this.db.prepare(`
      SELECT page.* FROM agent_rag_pages page
      JOIN (
        SELECT page_id, MAX(page_revision) AS page_revision
        FROM agent_rag_pages
        WHERE account_id = ? AND account_generation = ?
        GROUP BY page_id
      ) latest ON latest.page_id = page.page_id AND latest.page_revision = page.page_revision
      WHERE page.account_id = ? AND page.account_generation = ? AND page.state = 'active'
      ORDER BY page.updated_at DESC, page.page_id
    `).all(lease.accountId, lease.generation, lease.accountId, lease.generation) as StoredRagPageRow[]).map(metadata);
  }

  /** Tombstones the active revision; a later page revision can replace it. */
  tombstone(lease: AccountGenerationLease, pageId: string): RagPageMetadata | undefined {
    assertAgentStoreReadable(this.db);
    validateString(pageId, "RAG page id");
    return this.transaction(() => {
      this.lifecycle.assertCurrent(lease);
      const current = this.currentRow(lease, pageId);
      if (!current || current.state === "deleted") return current ? metadata(current) : undefined;
      const now = this.clock();
      this.db.prepare(`
        UPDATE agent_rag_pages
        SET state = 'deleted', updated_at = ?, deleted_at = ?
        WHERE account_id = ? AND account_generation = ? AND page_id = ? AND page_revision = ? AND state = 'active'
      `).run(now, now, lease.accountId, lease.generation, pageId, current.page_revision);
      const updated = this.currentRow(lease, pageId);
      return updated ? metadata(updated) : undefined;
    });
  }

  /**
   * Physically reclaims storage for this account generation:
   *
   * 1. Pages whose latest revision is `deleted` are unreachable (both get() and
   *    listMetadata() only ever surface the latest revision), so every one of
   *    their revisions is removed.
   * 2. Older revisions of still-active pages beyond {@link activeRevisionRetention}
   *    are unreachable too, and are pruned so repeated re-ingestion of the same
   *    message cannot accumulate unlimited encrypted rows.
   *
   * Returns the number of rows removed. The in-memory index must be rebuilt
   * after this call because the worker treats the store as authoritative.
   */
  purgeTombstoned(lease: AccountGenerationLease, activeRevisionRetention = 5): number {
    assertAgentStoreReadable(this.db);
    this.lifecycle.assertCurrent(lease);
    const retention = Math.max(1, Math.floor(activeRevisionRetention));
    return this.transaction(() => {
      const removedTombstoned = this.db.prepare(`
        DELETE FROM agent_rag_pages
        WHERE account_id = ? AND account_generation = ?
          AND page_id IN (
            SELECT t.page_id FROM (
              SELECT page_id FROM agent_rag_pages
              WHERE account_id = ? AND account_generation = ?
              GROUP BY page_id
            ) t
            WHERE (
              SELECT state FROM agent_rag_pages
              WHERE account_id = ? AND account_generation = ? AND page_id = t.page_id
              ORDER BY page_revision DESC LIMIT 1
            ) = 'deleted'
          )
      `).run(lease.accountId, lease.generation, lease.accountId, lease.generation, lease.accountId, lease.generation).changes;
      const removedOldRevisions = this.db.prepare(`
        DELETE FROM agent_rag_pages
        WHERE account_id = ? AND account_generation = ?
          AND page_revision < (
            SELECT MAX(page_revision) FROM agent_rag_pages
            WHERE account_id = ? AND account_generation = ? AND page_id = agent_rag_pages.page_id
          ) - ?
      `).run(lease.accountId, lease.generation, lease.accountId, lease.generation, retention - 1).changes;
      return removedTombstoned + removedOldRevisions;
    });
  }
}
