import type { DatabaseHandle } from "../db.js";
import { assertAgentStoreReadable } from "./schema.js";

/**
 * Persisted lexical inverted index for RAG retrieval.
 *
 * Only token counts and page-level metadata are stored; message content stays
 * inside the encrypted `agent_rag_pages` payloads. The encrypted page store
 * remains authoritative — the index is a derived cache that the worker repairs
 * incrementally after a restart (see AgentRagWorker.warmAccount).
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_SUBJECT_BOOST = 1.5;
export const BM25_SENDER_BOOST = 1.1;
/** Upper bound on unique terms stored per page to bound pathological row counts. */
export const MAX_INDEX_TERMS_PER_PAGE = 5_000;

export type RagIndexedTerm = {
  term: string;
  tfSubject: number;
  tfSender: number;
  tfBody: number;
};

export type RagPageIndexInput = {
  accountId: string;
  accountGeneration: number;
  pageId: string;
  pageRevision: number;
  messageId: string;
  terms: readonly RagIndexedTerm[];
  /** Total token occurrences across all fields (BM25 document length). */
  termCount: number;
  sentAt?: string;
};

export type RagIndexPosting = {
  pageId: string;
  pageRevision: number;
  messageId: string;
  tfSubject: number;
  tfSender: number;
  tfBody: number;
  termCount: number;
  sentAt: string | null;
};

export type RagIndexAccountStats = {
  accountId: string;
  accountGeneration: number;
  docCount: number;
  termTotal: number;
};

export type RagIndexPageRef = {
  pageId: string;
  pageRevision: number;
};

type PostingRow = {
  page_id: string;
  page_revision: number;
  message_id: string;
  tf_subject: number;
  tf_sender: number;
  tf_body: number;
  term_count: number;
  sent_at: string | null;
};

/**
 * Tokenizes text like the query path (`searchTerms`) but keeps occurrence
 * counts and does not apply the query-side term cap, so the persisted index
 * covers every searchable term of a page.
 */
export function tokenCounts(value: string, maximumTerms = MAX_INDEX_TERMS_PER_PAGE): Map<string, number> {
  const normalized = value.toLocaleLowerCase().normalize("NFC");
  const matches = normalized.match(/[\u3400-\u9FFF\uF900-\uFAFF]|[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const counts = new Map<string, number>();
  for (const match of matches) {
    const existing = counts.get(match);
    if (existing !== undefined) {
      counts.set(match, existing + 1);
      continue;
    }
    if (counts.size >= maximumTerms) break;
    counts.set(match, 1);
  }
  return counts;
}

export function effectiveTermFrequency(posting: Pick<RagIndexPosting, "tfSubject" | "tfSender" | "tfBody">): number {
  return posting.tfBody + BM25_SUBJECT_BOOST * posting.tfSubject + BM25_SENDER_BOOST * posting.tfSender;
}

/** BM25 term score with the standard idf formula used here. */
export function bm25TermScore(
  termFrequency: number,
  documentLength: number,
  averageDocumentLength: number,
  documentCount: number,
  documentFrequency: number,
): number {
  if (termFrequency <= 0 || documentFrequency <= 0) return 0;
  const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
  const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (documentLength / Math.max(averageDocumentLength, 1)));
  return idf * ((termFrequency * (BM25_K1 + 1)) / denominator);
}

function pageTermTotal(rows: readonly PostingRow[]): number {
  // Every term row of a revision carries the same term_count; sum once per revision.
  const byRevision = new Map<number, number>();
  for (const row of rows) byRevision.set(row.page_revision, row.term_count);
  return [...byRevision.values()].reduce((sum, value) => sum + value, 0);
}

/**
 * Owns the `agent_rag_index` and `agent_rag_index_stats` tables. All mutations
 * keep per-generation stats (`doc_count`, `term_total`) in sync with the
 * postings rows so query-time BM25 needs no aggregation scan.
 */
export class SqliteRagIndex {
  constructor(private readonly db: DatabaseHandle) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private postingRows(accountId: string, accountGeneration: number, pageId: string): PostingRow[] {
    return this.db.prepare(`
      SELECT page_id, page_revision, message_id, tf_subject, tf_sender, tf_body, term_count, sent_at
      FROM agent_rag_index
      WHERE account_id = ? AND account_generation = ? AND page_id = ?
    `).all(accountId, accountGeneration, pageId) as PostingRow[];
  }

  private applyStatsDelta(accountId: string, accountGeneration: number, docDelta: number, termDelta: number): void {
    const existing = this.db.prepare(`
      SELECT doc_count, term_total
      FROM agent_rag_index_stats
      WHERE account_id = ? AND account_generation = ?
    `).get(accountId, accountGeneration) as { doc_count: number; term_total: number } | undefined;
    const docCount = Math.max(0, (existing?.doc_count ?? 0) + docDelta);
    const termTotal = Math.max(0, (existing?.term_total ?? 0) + termDelta);
    if (existing) {
      this.db.prepare(`
        UPDATE agent_rag_index_stats
        SET doc_count = ?, term_total = ?
        WHERE account_id = ? AND account_generation = ?
      `).run(docCount, termTotal, accountId, accountGeneration);
    } else if (docCount > 0 || termTotal > 0) {
      this.db.prepare(`
        INSERT INTO agent_rag_index_stats (account_id, account_generation, doc_count, term_total)
        VALUES (?, ?, ?, ?)
      `).run(accountId, accountGeneration, docCount, termTotal);
    }
  }

  /**
   * Replaces every index row of a page with the latest revision's terms. The
   * page is absent from the index when it has no terms, matching the store
   * semantics where only indexed pages can be retrieved.
   */
  replacePage(input: RagPageIndexInput): void {
    assertAgentStoreReadable(this.db);
    if (!input.pageId || input.pageId.length > 512) throw new Error("RAG index page id is invalid.");
    if (!input.messageId || input.messageId.length > 512) throw new Error("RAG index message id is invalid.");
    if (!Number.isSafeInteger(input.pageRevision) || input.pageRevision < 1) throw new Error("RAG index page revision is invalid.");
    if (!Number.isSafeInteger(input.termCount) || input.termCount < 0) throw new Error("RAG index term count is invalid.");
    this.transaction(() => {
      const old = this.postingRows(input.accountId, input.accountGeneration, input.pageId);
      const oldTermTotal = pageTermTotal(old);
      const oldHasPage = old.length > 0;
      this.db.prepare(`
        DELETE FROM agent_rag_index
        WHERE account_id = ? AND account_generation = ? AND page_id = ?
      `).run(input.accountId, input.accountGeneration, input.pageId);
      const insert = this.db.prepare(`
        INSERT INTO agent_rag_index (
          account_id, account_generation, page_id, page_revision, message_id,
          term, tf_subject, tf_sender, tf_body, term_count, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const term of input.terms) {
        insert.run(
          input.accountId,
          input.accountGeneration,
          input.pageId,
          input.pageRevision,
          input.messageId,
          term.term,
          term.tfSubject,
          term.tfSender,
          term.tfBody,
          input.termCount,
          input.sentAt ?? null,
        );
      }
      const newHasPage = input.terms.length > 0;
      this.applyStatsDelta(
        input.accountId,
        input.accountGeneration,
        (newHasPage ? 1 : 0) - (oldHasPage ? 1 : 0),
        (newHasPage ? input.termCount : 0) - oldTermTotal,
      );
    });
  }

  /** Removes a page (all revisions) from the index and its stats contribution. */
  removePage(accountId: string, accountGeneration: number, pageId: string): void {
    assertAgentStoreReadable(this.db);
    if (!pageId || pageId.length > 512) throw new Error("RAG index page id is invalid.");
    this.transaction(() => {
      const old = this.postingRows(accountId, accountGeneration, pageId);
      if (!old.length) return;
      const termTotal = pageTermTotal(old);
      this.db.prepare(`
        DELETE FROM agent_rag_index
        WHERE account_id = ? AND account_generation = ? AND page_id = ?
      `).run(accountId, accountGeneration, pageId);
      this.applyStatsDelta(accountId, accountGeneration, -1, -termTotal);
    });
  }

  /** Removes every generation at or below the given generation (lifecycle deletion). */
  removeGeneration(accountId: string, generationAtMost: number): void {
    assertAgentStoreReadable(this.db);
    this.transaction(() => {
      this.db.prepare(`
        DELETE FROM agent_rag_index
        WHERE account_id = ? AND account_generation <= ?
      `).run(accountId, generationAtMost);
      this.db.prepare(`
        DELETE FROM agent_rag_index_stats
        WHERE account_id = ? AND account_generation <= ?
      `).run(accountId, generationAtMost);
    });
  }

  /**
   * Removes index rows for pages that were physically purged from the
   * encrypted store, adjusting stats in one batch.
   */
  removePages(accountId: string, accountGeneration: number, pageIds: readonly string[]): void {
    assertAgentStoreReadable(this.db);
    if (!pageIds.length) return;
    this.transaction(() => {
      const placeholders = pageIds.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT page_id, page_revision, message_id, tf_subject, tf_sender, tf_body, term_count, sent_at
        FROM agent_rag_index
        WHERE account_id = ? AND account_generation = ? AND page_id IN (${placeholders})
      `).all(accountId, accountGeneration, ...pageIds) as PostingRow[];
      if (!rows.length) return;
      const termTotal = pageTermTotal(rows);
      const pageCount = new Set(rows.map((row) => row.page_id)).size;
      this.db.prepare(`
        DELETE FROM agent_rag_index
        WHERE account_id = ? AND account_generation = ? AND page_id IN (${placeholders})
      `).run(accountId, accountGeneration, ...pageIds);
      this.applyStatsDelta(accountId, accountGeneration, -pageCount, -termTotal);
    });
  }

  /** Rebuilds the stats row from the postings table (drift convergence). */
  reconcileStats(accountId: string, accountGeneration: number): void {
    assertAgentStoreReadable(this.db);
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT page_id) AS doc_count, COALESCE(SUM(term_count), 0) AS term_total
      FROM agent_rag_index
      WHERE account_id = ? AND account_generation = ?
    `).get(accountId, accountGeneration) as { doc_count: number; term_total: number };
    this.db.prepare(`
      INSERT INTO agent_rag_index_stats (account_id, account_generation, doc_count, term_total)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, account_generation) DO UPDATE SET
        doc_count = excluded.doc_count,
        term_total = excluded.term_total
    `).run(accountId, accountGeneration, row.doc_count, row.term_total);
  }

  statsFor(accountId: string, accountGeneration: number): RagIndexAccountStats | undefined {
    return this.db.prepare(`
      SELECT account_id AS accountId, account_generation AS accountGeneration,
             doc_count AS docCount, term_total AS termTotal
      FROM agent_rag_index_stats
      WHERE account_id = ? AND account_generation = ?
    `).get(accountId, accountGeneration) as RagIndexAccountStats | undefined;
  }

  /** Postings for one query term, optionally narrowed to an authorized message set. */
  postingsFor(
    accountId: string,
    accountGeneration: number,
    term: string,
    allowedMessageIds?: ReadonlySet<string>,
  ): RagIndexPosting[] {
    assertAgentStoreReadable(this.db);
    if (allowedMessageIds && allowedMessageIds.size === 0) return [];
    if (!allowedMessageIds) {
      return (this.db.prepare(`
        SELECT page_id, page_revision, message_id, tf_subject, tf_sender, tf_body, term_count, sent_at
        FROM agent_rag_index
        WHERE term = ? AND account_id = ? AND account_generation = ?
      `).all(term, accountId, accountGeneration) as PostingRow[]).map(this.toPosting);
    }
    const placeholders = [...allowedMessageIds].map(() => "?").join(",");
    return (this.db.prepare(`
      SELECT page_id, page_revision, message_id, tf_subject, tf_sender, tf_body, term_count, sent_at
      FROM agent_rag_index
      WHERE term = ? AND account_id = ? AND account_generation = ? AND message_id IN (${placeholders})
    `).all(term, accountId, accountGeneration, ...[...allowedMessageIds]) as PostingRow[]).map(this.toPosting);
  }

  /** The latest indexed revision per page for the account generation. */
  distinctPagesFor(accountId: string, accountGeneration: number): RagIndexPageRef[] {
    return (this.db.prepare(`
      SELECT page_id, MAX(page_revision) AS page_revision
      FROM agent_rag_index
      WHERE account_id = ? AND account_generation = ?
      GROUP BY page_id
    `).all(accountId, accountGeneration) as Array<{ page_id: string; page_revision: number }>)
      .map((row) => ({ pageId: row.page_id, pageRevision: row.page_revision }));
  }

  /** Every revision currently indexed for a page (for semantic cleanup). */
  pageRevisionsFor(accountId: string, accountGeneration: number, pageId: string): number[] {
    return (this.db.prepare(`
      SELECT DISTINCT page_revision
      FROM agent_rag_index
      WHERE account_id = ? AND account_generation = ? AND page_id = ?
    `).all(accountId, accountGeneration, pageId) as Array<{ page_revision: number }>)
      .map((row) => row.page_revision);
  }

  private toPosting(row: PostingRow): RagIndexPosting {
    return {
      pageId: row.page_id,
      pageRevision: row.page_revision,
      messageId: row.message_id,
      tfSubject: row.tf_subject,
      tfSender: row.tf_sender,
      tfBody: row.tf_body,
      termCount: row.term_count,
      sentAt: row.sent_at,
    };
  }
}
