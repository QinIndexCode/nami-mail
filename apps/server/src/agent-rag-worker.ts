import { createHash, randomUUID } from "node:crypto";
import type { AgentSourceEvent, Citation, EmbeddingProvider } from "@nami/agent-contracts";
import type { DatabaseHandle } from "./db.js";
import { messagePayloadById } from "./message-storage.js";
import { chunkMailContent, cleanMailContent } from "./agent/index.js";
import { CitationRevalidator, SqliteCitationAuthority, type StoredCitationReference } from "./agent/citations.js";
import type { AccountLifecycleStore} from "./agent/lifecycle.js";
import { type AccountGenerationLease } from "./agent/lifecycle.js";
import { EncryptedRagPageStore, type DecryptedRagPage, type RagPageMetadata } from "./agent/rag-page-store.js";
import { SqliteRagIndex, bm25TermScore, effectiveTermFrequency, tokenCounts, type RagIndexedTerm } from "./agent/rag-index.js";
import {
  HybridRagRetriever,
  InMemorySemanticIndex,
  type MetadataRetriever,
  type RagRetrievalCandidate,
  type RagRetrievalQuery,
  type SemanticRetriever,
} from "./agent/retrieval.js";
import type { AgentSourceEventOutbox} from "./agent/source-events.js";
import { type ClaimedSourceEvent } from "./agent/source-events.js";
import { agentOpaqueDigest, canonicalAgentJson } from "./agent/store-crypto.js";

const RAG_PAYLOAD_VERSION = 1;
const workerIntervalMs = 1_500;
const maximumSearchTerms = 32;
const maximumInitialBackfillScan = 100;
/** Pages repaired per warm-up pass by the remote-id migration, so a first search
 * on a large mailbox never blocks the event loop on a full re-encryption sweep. */
const REMOTE_ID_REPAIR_BATCH = 20;

export type AgentRagPagePayload = {
  version: typeof RAG_PAYLOAD_VERSION;
  kind: "mail-chunk";
  messageId: string;
  /** Provider-stable identity (HMAC of the IMAP Message-ID/emailId). Gmail
   *  exposes one physical message under several labels (Inbox + All Mail + a
   *  user label), which become several local `messageId`s; this key is the same
   *  across all of those copies and is what dedupe collapses on. Absent when
   *  the provider supplied no stable identifier — dedupe then falls back to
   *  `messageId`. */
  remoteIdLookup?: string;
  sourceRevision: string;
  chunkId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  subject: string;
  sender: string;
  sentAt?: string;
  mailbox: string;
  cleaner: {
    version: string;
    source: "text" | "html" | "empty";
    truncated: boolean;
    removedQuotedContent: boolean;
    removedSignatureOrDisclaimer: boolean;
  };
};

export type AgentRagSearchResult = {
  citation: Citation;
  content: string;
  score: number;
};

export type RagVerifyAccountReport = {
  accountId: string;
  generation: number;
  pages: {
    /** Active pages at their latest revision. */
    activePageIds: number;
    /** Page ids whose latest revision is tombstoned. */
    tombstonedPageIds: number;
    /** Active rows behind the latest revision (unreachable duplicates). */
    staleActiveRevisions: number;
    /** Total tombstoned rows including historical revisions. */
    tombstonedRows: number;
    /** Latest active pages that could not be decrypted or parsed. */
    unreadableActivePages: number;
    /** Distinct messages referenced by active pages but missing from the mail store. */
    orphanMessageIds: number;
  };
  sourceEvents: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
    oldestPending: string | null;
  };
  revisions: {
    /** Active pages whose payload source revision has no matching message-upserted event. */
    pagesMissingSourceRevision: number;
  };
  index: {
    /** In-memory index entries for this account generation. */
    entries: number;
    /** Index entries that no longer resolve to a readable active page. */
    entriesWithoutReadablePage: number;
  };
};

export type RagVerifyReport = {
  generatedAt: string;
  accounts: readonly RagVerifyAccountReport[];
  overall: {
    accounts: number;
    activePageIds: number;
    tombstonedPageIds: number;
    staleActiveRevisions: number;
    unreadableActivePages: number;
    orphanMessageIds: number;
    pendingEvents: number;
    failedEvents: number;
    pagesMissingSourceRevision: number;
    indexEntries: number;
    indexEntriesWithoutReadablePage: number;
  };
};

export type AgentRagWorkerOptions = {
  db: DatabaseHandle;
  masterKey: Buffer;
  lifecycle: AccountLifecycleStore;
  sourceEvents: AgentSourceEventOutbox;
  pollIntervalMs?: number;
  now?: () => string;
  /** Enables process-local semantic indexing and hybrid retrieval. */
  embedding?: AgentRagEmbeddingOptions;
};

/**
 * When present, page content is embedded into the process-local semantic index
 * and retrieval fuses lexical and semantic scores. The provider is resolved by
 * the caller (AgentService) so cloud-content consent and model eligibility are
 * enforced before any mail text leaves the machine. Embedding failures degrade
 * silently to lexical-only retrieval.
 */
export type AgentRagEmbeddingOptions = {
  provider: EmbeddingProvider;
  model: string;
};

type IndexedPage = {
  accountId: string;
  accountGeneration: number;
  pageId: string;
  pageRevision: number;
  payload: AgentRagPagePayload;
};

type ScoredLexicalCandidate = {
  key: string;
  accountId: string;
  accountGeneration: number;
  pageId: string;
  pageRevision: number;
  score: number;
};

type ResolvedLexicalCandidate = {
  key: string;
  entry: IndexedPage;
  score: number;
};

type BackfillCursor = {
  generation: number;
  lastRowId: number;
  exhausted: boolean;
};

type BackfillMessageRow = {
  row_id: number;
  id: string;
  account_id: string;
  mailbox: string;
  uid: number;
  created_at: string;
};

function stableId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url").slice(0, 60);
}

function pageIdFor(messageId: string, chunkIndex: number): string {
  return `message:${messageId}:chunk:${chunkIndex}`;
}

function pagePrefix(messageId: string): string {
  return `message:${messageId}:chunk:`;
}

function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase().normalize("NFC");
  const terms = normalized.match(/[\u3400-\u9FFF\uF900-\uFAFF]|[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, maximumSearchTerms);
}

/** Per-field term frequencies and the total token count of a page payload. */
function indexTermsFor(payload: AgentRagPagePayload): RagIndexedTerm[] {
  const subjectCounts = tokenCounts(payload.subject);
  const senderCounts = tokenCounts(payload.sender);
  const bodyCounts = tokenCounts(payload.content);
  const terms = new Map<string, RagIndexedTerm>();
  for (const [term, count] of subjectCounts) {
    terms.set(term, { term, tfSubject: count, tfSender: 0, tfBody: 0 });
  }
  for (const [term, count] of senderCounts) {
    const existing = terms.get(term);
    terms.set(term, existing
      ? { term, tfSubject: existing.tfSubject, tfSender: count, tfBody: existing.tfBody }
      : { term, tfSubject: 0, tfSender: count, tfBody: 0 });
  }
  for (const [term, count] of bodyCounts) {
    const existing = terms.get(term);
    terms.set(term, existing
      ? { term, tfSubject: existing.tfSubject, tfSender: existing.tfSender, tfBody: count }
      : { term, tfSubject: 0, tfSender: 0, tfBody: count });
  }
  return [...terms.values()];
}

function indexTermCount(payload: AgentRagPagePayload): number {
  let total = 0;
  for (const counts of [tokenCounts(payload.subject), tokenCounts(payload.sender), tokenCounts(payload.content)]) {
    for (const count of counts.values()) total += count;
  }
  return total;
}

function parsePayload(value: unknown): AgentRagPagePayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const cleaner = item.cleaner;
  if (!cleaner || typeof cleaner !== "object" || Array.isArray(cleaner)) return undefined;
  const detail = cleaner as Record<string, unknown>;
  if (
    item.version !== RAG_PAYLOAD_VERSION
    || item.kind !== "mail-chunk"
    || typeof item.messageId !== "string"
    || typeof item.sourceRevision !== "string"
    || typeof item.chunkId !== "string"
    || typeof item.chunkIndex !== "number"
    || typeof item.content !== "string"
    || typeof item.contentHash !== "string"
    || typeof item.subject !== "string"
    || typeof item.sender !== "string"
    || typeof item.mailbox !== "string"
    || typeof detail.version !== "string"
    || (detail.source !== "text" && detail.source !== "html" && detail.source !== "empty")
    || typeof detail.truncated !== "boolean"
    || typeof detail.removedQuotedContent !== "boolean"
    || typeof detail.removedSignatureOrDisclaimer !== "boolean"
  ) return undefined;
  return {
    version: RAG_PAYLOAD_VERSION,
    kind: "mail-chunk",
    messageId: item.messageId,
    ...(typeof item.remoteIdLookup === "string" ? { remoteIdLookup: item.remoteIdLookup } : {}),
    sourceRevision: item.sourceRevision,
    chunkId: item.chunkId,
    chunkIndex: item.chunkIndex,
    content: item.content,
    contentHash: item.contentHash,
    subject: item.subject,
    sender: item.sender,
    ...(typeof item.sentAt === "string" ? { sentAt: item.sentAt } : {}),
    mailbox: item.mailbox,
    cleaner: {
      version: detail.version,
      source: detail.source,
      truncated: detail.truncated,
      removedQuotedContent: detail.removedQuotedContent,
      removedSignatureOrDisclaimer: detail.removedSignatureOrDisclaimer,
    },
  };
}

function metadataKey(accountId: string, generation: number, pageId: string): string {
  return `${accountId}\u0000${generation}\u0000${pageId}`;
}

function indexKey(accountId: string, generation: number, pageId: string, revision: number): string {
  return `${metadataKey(accountId, generation, pageId)}\u0000${revision}`;
}

/**
 * Legacy lexical-scoring heuristic (subject boost + term overlap), kept as a
 * regression baseline for the BM25 query it replaced. It is not part of the
 * runtime retrieval path.
 */
export function scorePage(queryTerms: readonly string[], payload: AgentRagPagePayload): number {
  if (!queryTerms.length) return 0;
  const haystack = `${payload.subject}\n${payload.sender}\n${payload.content}`.toLocaleLowerCase();
  const terms = new Set(searchTerms(`${payload.subject}\n${payload.sender}\n${payload.content}`));
  let lexical = 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (!haystack.includes(term)) continue;
    matched += 1;
    const titleWeight = payload.subject.toLocaleLowerCase().includes(term) ? 1.25 : 0;
    lexical += 1 + titleWeight;
  }
const overlap = queryTerms.filter((term) => terms.has(term)).length;
  const semantic = overlap / Math.max(queryTerms.length, terms.size, 1);
  return matched ? lexical + semantic : 0;
}

function decodeIndexKey(key: string): { accountId: string; accountGeneration: number; pageId: string; pageRevision: number } | undefined {
  const [accountId, generation, pageId, revision, ...rest] = key.split("\u0000");
  if (!accountId || !generation || !pageId || !revision || rest.length > 0) return undefined;
  const accountGeneration = Number(generation);
  const pageRevision = Number(revision);
  if (!Number.isSafeInteger(accountGeneration) || accountGeneration < 0) return undefined;
  if (!Number.isSafeInteger(pageRevision) || pageRevision < 1) return undefined;
  return { accountId, accountGeneration, pageId, pageRevision };
}

// Gentle recency bias for retrieval ranking: today's mail scores up to +20%,
// decaying to zero by ~30 days. Kept small so lexical relevance still wins —
// this only breaks ties and lifts very recent matches.
function recencyBoost(sentAt: string | undefined, nowMs = Date.now()): number {
  if (!sentAt) return 0;
  const ageMs = nowMs - Date.parse(sentAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  return Math.max(0, 0.2 * (1 - ageMs / (30 * 86_400_000)));
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 360 ? normalized : `${normalized.slice(0, 357).trimEnd()}...`;
}

/** Stable identity a citation/chunk collapses on: the provider-stable id when
 *  present (Gmail's one-message-many-labels case), else the local message id. */
function dedupeKey(payload: AgentRagPagePayload): string {
  return payload.remoteIdLookup || payload.messageId;
}

function asCitation(entry: IndexedPage, confidence: number): StoredCitationReference {
  const payload = entry.payload;
  return {
    accountGeneration: entry.accountGeneration,
    sourceRevision: payload.sourceRevision,
    citation: {
      id: `rag_${stableId(`${entry.accountId}\u0000${payload.messageId}\u0000${payload.chunkId}\u0000${payload.sourceRevision}`)}`,
      source: "rag-chunk",
      accountId: entry.accountId,
      messageId: payload.messageId,
      chunkId: payload.chunkId,
      subject: payload.subject,
      ...(payload.sender ? { sender: payload.sender } : {}),
      ...(payload.sentAt ? { sentAt: payload.sentAt } : {}),
      mailbox: payload.mailbox,
      excerpt: excerpt(payload.content),
      confidence,
      sourceRevision: payload.sourceRevision,
      target: { kind: "message", id: payload.messageId },
    },
  };
}

/**
 * Consumes the transactional mail-event outbox and keeps the local encrypted
 * RAG pages in sync. Its index is intentionally process-local; only encrypted
 * pages survive restarts and account key revocation immediately makes them unreadable.
 */
export class AgentRagWorker {
  private readonly pageStore: EncryptedRagPageStore;
  private readonly citations: CitationRevalidator;
  private readonly ragIndex: SqliteRagIndex;
  private readonly semantic = new InMemorySemanticIndex();
  /** Latest sentAt per index key observed while scoring the current query. */
  private readonly sentAtByKey = new Map<string, string>();
  private embedding: AgentRagEmbeddingOptions | undefined;
  // Latest requested page per semantic key; a re-embed supersedes a stale one.
  private readonly pendingSemantic = new Map<string, IndexedPage>();
  private semanticPump: Promise<void> | undefined;
  private readonly workerId = `nami-rag-${randomUUID()}`;
  private readonly pollIntervalMs: number;
  private readonly now: () => string;
  private readonly backfillCursors = new Map<string, BackfillCursor>();
  /** Generations whose tombstoned rows and stale revisions were already purged. */
  private readonly purgedGenerations = new Set<string>();
  /** Generations whose pages were already repaired for the missing remote id. */
  private readonly remoteIdRepairedGenerations = new Set<string>();
  /** Progress cursor for the remote-id repair, keyed by `accountId:generation`. */
  private readonly remoteIdRepairCursor = new Map<string, string>();
  /** Cached candidate prefixes (`message:<id>:` → remoteIdLookup) per generation. */
  private readonly remoteIdCandidatePrefixes = new Map<string, Map<string, string>>();
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: AgentRagWorkerOptions) {
    this.pageStore = new EncryptedRagPageStore(options.db, options.masterKey, options.lifecycle, options.now);
    this.citations = new CitationRevalidator(new SqliteCitationAuthority(options.db, options.masterKey));
    this.ragIndex = new SqliteRagIndex(options.db);
    this.embedding = options.embedding;
    this.pollIntervalMs = Math.max(250, Math.min(30_000, options.pollIntervalMs ?? workerIntervalMs));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Switches the embedding provider/model at runtime (for example after the
   * default provider or its consent changes). A different provider or model
   * changes the vector space, so the semantic index is rebuilt lazily from the
   * already-warmed lexical index. Passing `undefined` disables semantic search.
   */
  setEmbedding(embedding: AgentRagEmbeddingOptions | undefined): void {
    const changed = this.embedding?.provider.id !== embedding?.provider.id
      || this.embedding?.model !== embedding?.model;
    this.embedding = embedding;
    if (!embedding || !changed) {
      if (!embedding) {
        this.semantic.clear();
        this.pendingSemantic.clear();
      }
      return;
    }
    this.semantic.clear();
    this.pendingSemantic.clear();
    for (const account of this.options.db.prepare(`
      SELECT DISTINCT account_id, account_generation FROM agent_rag_index
    `).all() as Array<{ account_id: string; account_generation: number }>) {
      let lease: AccountGenerationLease;
      try {
        lease = this.options.lifecycle.acquireLease(account.account_id);
      } catch {
        continue;
      }
      for (const ref of this.ragIndex.distinctPagesFor(account.account_id, account.account_generation)) {
        const page = this.pageStore.get(lease, ref.pageId);
        if (!page || page.pageRevision !== ref.pageRevision) continue;
        const payload = parsePayload(page.payload);
        if (!payload) continue;
        this.scheduleSemanticIndex({
          accountId: lease.accountId,
          accountGeneration: lease.generation,
          pageId: ref.pageId,
          pageRevision: ref.pageRevision,
          payload,
        });
      }
    }
  }

  start(): void {
    if (this.stopped) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.draining;
    await this.semanticPump;
    this.semantic.clear();
    this.pendingSemantic.clear();
    this.sentAtByKey.clear();
    this.backfillCursors.clear();
    this.remoteIdRepairCursor.clear();
    this.remoteIdCandidatePrefixes.clear();
  }

  async drainOnce(limit = 25): Promise<void> {
    if (this.stopped) return;
    if (this.draining) return this.draining;
    const work = this.drain(limit).finally(() => {
      if (this.draining === work) this.draining = undefined;
    });
    this.draining = work;
    return work;
  }

  /** Awaits all queued page embeddings so semantic state can be asserted deterministically. */
  async flushSemantic(): Promise<void> {
    while (this.pendingSemantic.size > 0 || this.semanticPump !== undefined) {
      if (this.semanticPump === undefined) {
        void this.pumpSemantic();
        continue;
      }
      await this.semanticPump;
    }
  }

  /**
   * When `allowedMessageIds` is supplied, it is an exact authorization
   * boundary. The worker never expands an anchor message into a thread;
   * callers must resolve and authorize every permitted message before search.
   */
  async search(
    accountIds: readonly string[],
    query: string,
    limit = 8,
    signal?: AbortSignal,
    allowedMessageIds?: readonly string[],
  ): Promise<AgentRagSearchResult[]> {
    if (signal?.aborted) return [];
    const terms = searchTerms(query);
    if (!terms.length || !accountIds.length || (allowedMessageIds !== undefined && !allowedMessageIds.length)) return [];
    const accountSet = new Set(accountIds);
    const messageSet = allowedMessageIds === undefined ? undefined : new Set(allowedMessageIds);
    for (const accountId of accountSet) {
      if (signal?.aborted) return [];
      let lease: AccountGenerationLease;
      try {
        lease = this.options.lifecycle.acquireLease(accountId);
      } catch {
        continue;
      }
      this.warmAccount(lease);
    }
    if (this.embedding) {
      // Semantic retrieval is best-effort: a failed query embedding or a
      // failed hybrid merge degrades to the pure lexical path below.
      try {
        const queryVector = await this.embedQuery(query, signal);
        if (queryVector && !signal?.aborted) {
          return await this.searchHybrid(accountSet, messageSet, query, queryVector, limit, signal);
        }
      } catch {
        // Fall through to lexical-only retrieval.
      }
    }
    const candidates = await this.lexCandidatesFor(accountSet, messageSet, terms, limit, signal);
    if (signal?.aborted) return [];
    const maximum = Math.max(1, Math.min(30, limit));
    const results: AgentRagSearchResult[] = [];
    // A single message can span many chunks; keep only its best chunk so the
    // top results stay diverse across messages instead of one long mail. The
    // key is the provider-stable id when available so Gmail's label copies of
    // the same physical mail also collapse into a single result.
    const seenMessages = new Set<string>();
    for (const candidate of candidates) {
      if (signal?.aborted || results.length >= maximum) break;
      const key = dedupeKey(candidate.entry.payload);
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      const confidence = Math.min(1, candidate.score / Math.max(terms.length * 2.25, 1));
      const reference = asCitation(candidate.entry, confidence);
      const validated = this.citations.revalidate(reference);
      if (!validated.valid) continue;
      results.push({ citation: validated.citation, content: candidate.entry.payload.content, score: candidate.score });
    }
    return results;
  }

  /**
   * Fuses lexical and semantic candidates with reciprocal-rank fusion and
   * returns the validated citations. The allowed-message boundary is enforced
   * on both candidate sets before merging.
   */
  private async searchHybrid(
    accountSet: ReadonlySet<string>,
    messageSet: ReadonlySet<string> | undefined,
    query: string,
    queryVector: readonly number[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<AgentRagSearchResult[]> {
    if (signal?.aborted) return [];
    const lexical: MetadataRetriever = {
      searchMetadata: async (ragQuery) => this.lexicalCandidates(ragQuery, accountSet, messageSet),
    };
    const semantic: SemanticRetriever = {
      searchSemantic: async (ragQuery, ragSignal) => {
        const candidates = await this.semantic.searchSemantic({ ...ragQuery, vector: queryVector }, ragSignal);
        if (!messageSet) return candidates;
        return candidates.filter((candidate) => messageSet.has(candidate.citation.citation.messageId));
      },
    };
    const hybrid = new HybridRagRetriever(lexical, semantic, this.citations, 60);
    const results = await hybrid.search({ text: query, filter: { accountIds: [...accountSet] }, limit }, signal);
    if (signal?.aborted) return [];
    const resolved: AgentRagSearchResult[] = [];
    const seenMessages = new Set<string>();
    for (const result of results) {
      const decoded = decodeIndexKey(result.id);
      if (!decoded) continue;
      let lease: AccountGenerationLease | undefined;
      try {
        lease = this.options.lifecycle.acquireLease(decoded.accountId);
      } catch {
        continue;
      }
      const page = this.pageStore.get(lease, decoded.pageId);
      if (!page || page.pageRevision !== decoded.pageRevision) continue;
      const payload = parsePayload(page.payload);
      if (!payload) continue;
      const key = dedupeKey(payload);
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      resolved.push({ citation: result.citation, content: payload.content, score: result.score });
    }
    return resolved;
  }

  private async lexicalCandidates(
    ragQuery: RagRetrievalQuery,
    accountSet: ReadonlySet<string>,
    messageSet: ReadonlySet<string> | undefined,
  ): Promise<readonly RagRetrievalCandidate[]> {
    const queryTerms = searchTerms(ragQuery.text);
    if (!queryTerms.length) return [];
    const pool = Math.max(1, Math.min(30, ragQuery.limit * 4));
    const candidates = await this.lexCandidatesFor(accountSet, messageSet, queryTerms, pool);
    return candidates.map(({ key, entry, score }) => {
      const confidence = Math.min(1, score / Math.max(queryTerms.length * 2.25, 1));
      return {
        id: key,
        citation: asCitation(entry, confidence),
        ...(score > 0 ? { metadataScore: score } : {}),
      } satisfies RagRetrievalCandidate;
    });
  }

  /**
   * Scores pages against the persisted inverted index with BM25 and returns
   * the top pool with their decrypted page payloads. Only the pool (at most
   * 30 pages) is ever decrypted per search; the rest of the account stays
   * encrypted on disk.
   */
  private async lexCandidatesFor(
    accountSet: ReadonlySet<string>,
    messageSet: ReadonlySet<string> | undefined,
    terms: readonly string[],
    pool: number,
    signal?: AbortSignal,
  ): Promise<ResolvedLexicalCandidate[]> {
    if (signal?.aborted || !terms.length) return [];
    const scored: ScoredLexicalCandidate[] = [];
    for (const accountId of accountSet) {
      if (signal?.aborted) return [];
      let lease: AccountGenerationLease;
      try {
        lease = this.options.lifecycle.acquireLease(accountId);
      } catch {
        continue;
      }
      const stats = this.ragIndex.statsFor(lease.accountId, lease.generation);
      if (!stats || stats.docCount <= 0) continue;
      const byPage = new Map<string, ScoredLexicalCandidate>();
      for (const term of terms) {
        const postings = this.ragIndex.postingsFor(lease.accountId, lease.generation, term, messageSet);
        if (!postings.length) continue;
        for (const posting of postings) {
          const key = indexKey(lease.accountId, lease.generation, posting.pageId, posting.pageRevision);
          let candidate = byPage.get(key);
          if (!candidate) {
            candidate = {
              key,
              accountId: lease.accountId,
              accountGeneration: lease.generation,
              pageId: posting.pageId,
              pageRevision: posting.pageRevision,
              score: 0,
            };
            byPage.set(key, candidate);
            if (posting.sentAt) this.sentAtByKey.set(key, posting.sentAt);
          }
          const termFrequency = effectiveTermFrequency(posting);
          candidate.score += bm25TermScore(
            termFrequency,
            posting.termCount,
            stats.termTotal / stats.docCount,
            stats.docCount,
            postings.length,
          );
        }
      }
      for (const candidate of byPage.values()) {
        if (candidate.score <= 0) continue;
        candidate.score *= 1 + recencyBoost(this.sentAtByKey.get(candidate.key));
        scored.push(candidate);
      }
      this.sentAtByKey.clear();
    }
    scored.sort((left, right) => right.score - left.score || left.pageId.localeCompare(right.pageId));
    const top = scored.slice(0, pool);
    const resolved: ResolvedLexicalCandidate[] = [];
    const leases = new Map<string, AccountGenerationLease>();
    for (const candidate of top) {
      if (signal?.aborted) return [];
      try {
        let lease = leases.get(candidate.accountId);
        if (!lease) {
          lease = this.options.lifecycle.acquireLease(candidate.accountId);
          leases.set(candidate.accountId, lease);
        }
        const page = this.pageStore.get(lease, candidate.pageId);
        if (!page || page.pageRevision !== candidate.pageRevision) continue;
        const payload = parsePayload(page.payload);
        if (!payload) continue;
        resolved.push({
          key: candidate.key,
          entry: {
            accountId: candidate.accountId,
            accountGeneration: candidate.accountGeneration,
            pageId: candidate.pageId,
            pageRevision: candidate.pageRevision,
            payload,
          },
          score: candidate.score,
        });
      } catch {
        // A page that vanished or a scope that changed mid-search is skipped;
        // retrieval continues with the remaining candidates.
      }
    }
    return resolved;
  }

  private async embedQuery(query: string, signal?: AbortSignal): Promise<readonly number[] | undefined> {
    if (!this.embedding) return undefined;
    try {
      const response = await this.embedding.provider.embed({
        requestId: `rag-embed-${randomUUID()}`,
        providerId: this.embedding.provider.id,
        model: this.embedding.model,
        inputs: [query.slice(0, 500_000) || " "],
      }, { signal, timeoutMs: 60_000 });
      const vector = response.vectors[0];
      return vector?.length ? vector : undefined;
    } catch {
      return undefined;
    }
  }

  evictAccount(accountId: string, generationAtMost = Number.MAX_SAFE_INTEGER): void {
    this.semantic.removeAccount(accountId, generationAtMost);
    for (const [key, entry] of this.pendingSemantic) {
      if (entry.accountId === accountId && entry.accountGeneration <= generationAtMost) this.pendingSemantic.delete(key);
    }
  }

  /**
   * Read-only maintenance check. It counts source-event states, finds stale
   * active page revisions and tombstoned pages, checks page source revisions,
   * and confirms the in-memory index resolves only to readable active pages.
   * It never rebuilds or deletes anything.
   */
  verify(): RagVerifyReport {
    const generatedAt = this.now();
    const accounts: RagVerifyAccountReport[] = [];
    const rows = this.options.db.prepare("SELECT id FROM accounts ORDER BY id").all() as Array<{ id: string }>;
    for (const { id: accountId } of rows) {
      let lease: AccountGenerationLease;
      try {
        lease = this.options.lifecycle.acquireLease(accountId);
      } catch {
        continue; // No current generation to verify.
      }
      const generation = lease.generation;
      const pageRows = this.options.db.prepare(`
        SELECT page_id, page_revision, state
        FROM agent_rag_pages
        WHERE account_id = ? AND account_generation = ?
      `).all(accountId, generation) as Array<{ page_id: string; page_revision: number; state: "active" | "deleted" }>;
      const latestRevision = new Map<string, number>();
      for (const row of pageRows) {
        const current = latestRevision.get(row.page_id) ?? 0;
        if (row.page_revision > current) latestRevision.set(row.page_id, row.page_revision);
      }
      const activePageIds = new Set<string>();
      for (const row of pageRows) {
        if (row.state === "active" && row.page_revision === latestRevision.get(row.page_id)) activePageIds.add(row.page_id);
      }
      const tombstonedPageIds = new Set(
        pageRows
          .filter((row) => row.state === "deleted" && row.page_revision === latestRevision.get(row.page_id))
          .map((row) => row.page_id),
      );
      const staleActiveRevisions = pageRows
        .filter((row) => row.state === "active" && row.page_revision < (latestRevision.get(row.page_id) ?? 0))
        .length;
      const tombstonedRows = pageRows.filter((row) => row.state === "deleted").length;

      // Latest active pages must decrypt and parse; their message must still
      // exist in the mail store.
      let unreadableActivePages = 0;
      const referencedMessageIds = new Set<string>();
      for (const pageId of activePageIds) {
        const page = this.pageStore.get(lease, pageId);
        if (!page) {
          unreadableActivePages += 1;
          continue;
        }
        const payload = parsePayload(page.payload);
        if (payload) referencedMessageIds.add(payload.messageId);
      }
      let orphanMessageIds = 0;
      if (referencedMessageIds.size > 0) {
        const existing = new Set<string>();
        const batchSize = 400;
        for (const batch of [...referencedMessageIds].reduce<string[][]>((batches, messageId, index) => {
          const batchIndex = Math.floor(index / batchSize);
          (batches[batchIndex] ??= []).push(messageId);
          return batches;
        }, [])) {
          const placeholders = batch.map(() => "?").join(",");
          const found = this.options.db.prepare(
            `SELECT id FROM messages WHERE account_id = ? AND id IN (${placeholders})`,
          ).all(accountId, ...batch) as Array<{ id: string }>;
          for (const row of found) existing.add(row.id);
        }
        for (const messageId of referencedMessageIds) {
          if (!existing.has(messageId)) orphanMessageIds += 1;
        }
      }

      // Source-event state counts including the oldest pending event.
      const eventRows = this.options.db.prepare(`
        SELECT state, COUNT(*) AS count, MIN(occurred_at) AS oldest
        FROM agent_source_events
        WHERE account_id = ? AND account_generation = ?
        GROUP BY state
      `).all(accountId, generation) as Array<{ state: string; count: number; oldest: string | null }>;
      const sourceEvents = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, oldestPending: null as string | null };
      for (const event of eventRows) {
        switch (event.state) {
          case "pending":
            sourceEvents.pending = event.count;
            sourceEvents.oldestPending = event.oldest;
            break;
          case "processing":
            sourceEvents.processing = event.count;
            break;
          case "completed":
            sourceEvents.completed = event.count;
            break;
          case "failed":
            sourceEvents.failed = event.count;
            break;
          case "cancelled":
            sourceEvents.cancelled = event.count;
            break;
        }
      }

      // Every active page's payload must trace to a message-upserted event.
      let pagesMissingSourceRevision = 0;
      for (const pageId of activePageIds) {
        const page = this.pageStore.get(lease, pageId);
        if (!page) continue;
        const payload = parsePayload(page.payload);
        if (!payload || typeof payload.sourceRevision !== "string" || !payload.sourceRevision) {
          pagesMissingSourceRevision += 1;
          continue;
        }
        const found = this.options.db.prepare(`
          SELECT 1 FROM agent_source_events
          WHERE account_id = ? AND account_generation = ? AND source_revision = ? AND event_type = 'message-upserted'
          LIMIT 1
        `).get(accountId, generation, payload.sourceRevision);
        if (!found) pagesMissingSourceRevision += 1;
      }

      // The in-memory index must resolve only to readable active pages.
      const indexRefs = this.ragIndex.distinctPagesFor(accountId, generation);
      const indexEntries = indexRefs.length;
      let indexEntriesWithoutReadablePage = 0;
      for (const ref of indexRefs) {
        if (!this.pageStore.get(lease, ref.pageId)) indexEntriesWithoutReadablePage += 1;
      }

      accounts.push({
        accountId,
        generation,
        pages: {
          activePageIds: activePageIds.size,
          tombstonedPageIds: tombstonedPageIds.size,
          staleActiveRevisions,
          tombstonedRows,
          unreadableActivePages,
          orphanMessageIds,
        },
        sourceEvents,
        revisions: { pagesMissingSourceRevision },
        index: { entries: indexEntries, entriesWithoutReadablePage: indexEntriesWithoutReadablePage },
      });
    }
    const overall = {
      accounts: accounts.length,
      activePageIds: accounts.reduce((sum, account) => sum + account.pages.activePageIds, 0),
      tombstonedPageIds: accounts.reduce((sum, account) => sum + account.pages.tombstonedPageIds, 0),
      staleActiveRevisions: accounts.reduce((sum, account) => sum + account.pages.staleActiveRevisions, 0),
      unreadableActivePages: accounts.reduce((sum, account) => sum + account.pages.unreadableActivePages, 0),
      orphanMessageIds: accounts.reduce((sum, account) => sum + account.pages.orphanMessageIds, 0),
      pendingEvents: accounts.reduce((sum, account) => sum + account.sourceEvents.pending, 0),
      failedEvents: accounts.reduce((sum, account) => sum + account.sourceEvents.failed, 0),
      pagesMissingSourceRevision: accounts.reduce((sum, account) => sum + account.revisions.pagesMissingSourceRevision, 0),
      indexEntries: accounts.reduce((sum, account) => sum + account.index.entries, 0),
      indexEntriesWithoutReadablePage: accounts.reduce((sum, account) => sum + account.index.entriesWithoutReadablePage, 0),
    };
    return { generatedAt, accounts, overall };
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drainOnce().finally(() => this.schedule(this.pollIntervalMs));
    }, delay);
    this.timer.unref?.();
  }

  private async drain(limit: number): Promise<void> {
    this.queueInitialBackfill(limit);
    const claims = this.options.sourceEvents.claimPending({ limit, owner: this.workerId });
    let processed = 0;
    for (const claim of claims) {
      try {
        this.processClaim(claim);
        this.options.sourceEvents.complete(claim);
      } catch (error) {
        const code = error instanceof Error && error.message.includes("account")
          ? "account_state_unavailable"
          : "rag_ingestion_failed";
        try {
          this.options.sourceEvents.fail(claim, code);
        } catch {
          // A lost claim is safe: the durable outbox recovery path will decide its next state.
        }
      }
      // The claim loop is pure synchronous work (decrypt → clean → chunk →
      // re-encrypt → index transactions). A backfilled mailbox can keep the
      // event loop busy for a long stretch, starving concurrent HTTP: SSE
      // flushes of a just-started run's first tool event and unrelated GETs
      // (e.g. switching to another conversation) queue up behind it. Yield to
      // the event loop every few claims so those stay responsive.
      processed += 1;
      if (processed % 4 === 0) {
        await new Promise<void>((resolve) => setImmediate(() => resolve()));
      }
    }
  }

  /**
   * Older mail may predate Agent source events. Seed it through the same
   * encrypted outbox used by live sync, in small batches, so it receives the
   * normal lifecycle, retry, and deletion guarantees instead of a parallel
   * indexing path. A source event is written at most once per active account
   * generation; after a restart the cursor can safely rescan metadata.
   */
  private queueInitialBackfill(limit: number): void {
    const target = Math.max(1, Math.min(limit, maximumInitialBackfillScan));
    let remaining = target;
    const accounts = this.options.db.prepare("SELECT id FROM accounts ORDER BY created_at, id").all() as Array<{ id: string }>;
    for (const account of accounts) {
      if (remaining <= 0) break;
      let lease: AccountGenerationLease;
      try {
        lease = this.options.lifecycle.acquireLease(account.id);
      } catch {
        this.backfillCursors.delete(account.id);
        continue;
      }
      const current = this.backfillCursors.get(account.id);
      const cursor = current && current.generation === lease.generation
        ? current
        : { generation: lease.generation, lastRowId: 0, exhausted: false } satisfies BackfillCursor;
      if (cursor.exhausted) continue;
      const task = this.options.lifecycle.registerTask(lease);
      try {
        const rows = this.options.db.prepare(`
          SELECT rowid AS row_id, id, account_id, mailbox, uid, created_at
          FROM messages
          WHERE account_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?
        `).all(account.id, cursor.lastRowId, Math.max(remaining * 4, target)) as BackfillMessageRow[];
        if (!rows.length) {
          cursor.exhausted = true;
          this.backfillCursors.set(account.id, cursor);
          continue;
        }
        for (const row of rows) {
          cursor.lastRowId = row.row_id;
          task.assertCurrent();
          if (this.hasSourceEvent(lease, row.id)) continue;
          const occurredAt = this.now();
          this.options.sourceEvents.enqueue({
            lease,
            event: {
              eventId: randomUUID(),
              type: "message-upserted",
              accountId: lease.accountId,
              accountGeneration: lease.generation,
              revision: this.backfillRevision(row),
              source: { kind: "message", messageId: row.id },
              occurredAt,
            },
            payloadForDigest: {
              source: "initial-backfill",
              messageId: row.id,
              accountId: lease.accountId,
              accountGeneration: lease.generation,
            },
          });
          remaining -= 1;
          if (remaining <= 0) break;
        }
        if (rows.length < Math.max(remaining * 4, target)) cursor.exhausted = true;
        this.backfillCursors.set(account.id, cursor);
      } finally {
        task.release();
      }
    }
  }

  private hasSourceEvent(lease: AccountGenerationLease, messageId: string): boolean {
    const sourceLocatorOpaque = agentOpaqueDigest(
      this.options.masterKey,
      "source-locator",
      canonicalAgentJson({ accountId: lease.accountId, source: { kind: "message", messageId } }),
    );
    return Boolean(this.options.db.prepare(`
      SELECT 1 FROM agent_source_events
      WHERE account_id = ? AND account_generation = ?
        AND source_locator_opaque = ? AND event_type = 'message-upserted'
      LIMIT 1
    `).get(lease.accountId, lease.generation, sourceLocatorOpaque));
  }

  private backfillRevision(row: BackfillMessageRow): string {
    return `initial-backfill-v1:${stableId(canonicalAgentJson({
      messageId: row.id,
      accountId: row.account_id,
      mailbox: row.mailbox,
      uid: row.uid,
      createdAt: row.created_at,
    }))}`;
  }

  private processClaim(claim: ClaimedSourceEvent): void {
    const lifecycle = this.options.lifecycle.current(claim.accountId);
    const needsAccountData = claim.eventType === "message-upserted" || claim.eventType === "message-deleted"
      || claim.eventType === "attachment-upserted" || claim.eventType === "attachment-deleted";
    if (!lifecycle || lifecycle.generation !== claim.accountGeneration) {
      throw new Error("Source event account lifecycle is unavailable.");
    }
    if (!needsAccountData) {
      const event = this.options.sourceEvents.recoverClaimedEvent(claim);
      this.processLifecycleEvent(event);
      return;
    }
    const lease = this.options.lifecycle.acquireLease(claim.accountId);
    const event = this.options.sourceEvents.recoverClaimedEvent(claim, lease);
    if (event.type === "message-upserted") {
      this.upsertMessage(lease, event);
      return;
    }
    if (event.type === "message-deleted") {
      const messageId = event.source?.messageId ?? "";
      // Mail-state transactions remove the primary row before appending a
      // delete event. If a row with the same deterministic cache id exists
      // again, it was re-ingested after that deletion (for example after a
      // UIDVALIDITY reset). A retried old delete must not tombstone its newer
      // pages.
      if (!this.currentMessageExists(lease, messageId)) {
        this.tombstoneMessagePages(lease, messageId);
      }
      return;
    }
    // Attachment metadata is represented on the parent message. A later
    // attachment extractor can replace this with its own safe page type.
    this.upsertMessage(lease, { ...event, type: "message-upserted" });
  }

  private processLifecycleEvent(event: AgentSourceEvent): void {
    this.evictAccount(event.accountId, event.accountGeneration);
    if (event.type !== "account-deleted" && event.type !== "account-generation-advanced") return;
    // The lifecycle event may run after its DEK was deliberately discarded,
    // so deletion uses only identifiers and never attempts decryption.
    this.options.db.prepare(`
      DELETE FROM agent_rag_pages
      WHERE account_id = ? AND account_generation <= ?
    `).run(event.accountId, event.accountGeneration);
    this.ragIndex.removeGeneration(event.accountId, event.accountGeneration);
  }

  private upsertMessage(lease: AccountGenerationLease, event: AgentSourceEvent): void {
    const messageId = event.source?.messageId;
    if (!messageId) throw new Error("Message source event has no message id.");
    const stored = messagePayloadById(this.options.db, this.options.masterKey, messageId);
    if (!stored || stored.row.account_id !== lease.accountId) {
      this.tombstoneMessagePages(lease, messageId);
      return;
    }
    const payload = stored.payload;
    const cleaned = cleanMailContent({
      subject: payload.subject,
      textBody: payload.textBody,
      htmlBody: payload.htmlBody,
    });
    const chunks = chunkMailContent({
      messageId,
      sourceRevision: String(event.revision),
      subject: cleaned.normalizedSubject,
      text: cleaned.text,
    });
    const current = this.pageStore.listMetadata(lease);
    const byPageId = new Map(current.map((page) => [page.pageId, page]));
    const retained = new Set<string>();
    for (const chunk of chunks) {
      const pageId = pageIdFor(messageId, chunk.chunkIndex);
      retained.add(pageId);
      const nextPayload: AgentRagPagePayload = {
        version: RAG_PAYLOAD_VERSION,
        kind: "mail-chunk",
        messageId,
        ...(typeof stored.row.remote_id_lookup === "string" && stored.row.remote_id_lookup
          ? { remoteIdLookup: stored.row.remote_id_lookup }
          : {}),
        sourceRevision: String(event.revision),
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentHash: chunk.contentHash,
        subject: cleaned.normalizedSubject,
        sender: [payload.fromName, payload.fromAddress].filter(Boolean).join(" <").replace(/ <([^<]+)$/, " <$1>"),
        ...(typeof stored.row.sent_at === "string" ? { sentAt: stored.row.sent_at } : {}),
        mailbox: stored.row.mailbox,
        cleaner: {
          version: cleaned.cleanerVersion,
          source: cleaned.source,
          truncated: cleaned.truncated,
          removedQuotedContent: cleaned.removedQuotedContent,
          removedSignatureOrDisclaimer: cleaned.removedSignatureOrDisclaimer,
        },
      };
      const existing = byPageId.get(pageId);
      const existingPage = existing?.state === "active" ? this.pageStore.get(lease, pageId) : undefined;
      const existingPayload = parsePayload(existingPage?.payload);
      if (existingPayload?.sourceRevision === nextPayload.sourceRevision && existingPayload.contentHash === nextPayload.contentHash) {
        this.upsertIndex(existingPage!);
        continue;
      }
      const page = this.pageStore.put({
        lease,
        pageId,
        pageRevision: this.nextPageRevision(lease, pageId, existing),
        pageKind: "mail-chunk",
        payload: nextPayload,
      });
      this.upsertIndex({ ...page, payload: nextPayload });
    }
    for (const page of current) {
      if (!page.pageId.startsWith(pagePrefix(messageId)) || retained.has(page.pageId)) continue;
      this.pageStore.tombstone(lease, page.pageId);
      this.removeIndex(lease.accountId, lease.generation, page.pageId);
    }
  }

  private tombstoneMessagePages(lease: AccountGenerationLease, messageId: string): void {
    if (!messageId) return;
    for (const page of this.pageStore.listMetadata(lease)) {
      if (!page.pageId.startsWith(pagePrefix(messageId))) continue;
      this.pageStore.tombstone(lease, page.pageId);
      this.removeIndex(lease.accountId, lease.generation, page.pageId);
    }
  }

  private currentMessageExists(lease: AccountGenerationLease, messageId: string): boolean {
    if (!messageId) return false;
    return Boolean(this.options.db.prepare(`
      SELECT 1 FROM messages WHERE id = ? AND account_id = ?
    `).get(messageId, lease.accountId));
  }

  private nextPageRevision(
    lease: AccountGenerationLease,
    pageId: string,
    visibleCurrent: RagPageMetadata | undefined,
  ): number {
    if (visibleCurrent) return visibleCurrent.pageRevision + 1;
    const row = this.options.db.prepare(`
      SELECT COALESCE(MAX(page_revision), 0) AS page_revision
      FROM agent_rag_pages
      WHERE account_id = ? AND account_generation = ? AND page_id = ?
    `).get(lease.accountId, lease.generation, pageId) as { page_revision: number };
    return row.page_revision + 1;
  }

  private warmAccount(lease: AccountGenerationLease): void {
    // The persisted index is a derived cache of the authoritative encrypted
    // page store. Warm-up only repairs the delta: pages whose latest active
    // revision is missing from the index are decrypted and indexed, and index
    // rows without an active page are dropped. Restarts therefore never pay a
    // full-decryption pass over the account.
    const pages = this.pageStore.listMetadata(lease);
    const activeByPageId = new Map(pages.map((page) => [page.pageId, page]));
    const indexedByPageId = new Map(
      this.ragIndex.distinctPagesFor(lease.accountId, lease.generation).map((ref) => [ref.pageId, ref.pageRevision]),
    );
    for (const page of pages) {
      const indexedRevision = indexedByPageId.get(page.pageId);
      if (indexedRevision !== undefined && indexedRevision >= page.pageRevision) continue;
      const decrypted = this.pageStore.get(lease, page.pageId);
      if (decrypted) this.upsertIndex(decrypted);
    }
    for (const pageId of indexedByPageId.keys()) {
      if (!activeByPageId.has(pageId)) this.removeIndex(lease.accountId, lease.generation, pageId);
    }
    this.ragIndex.reconcileStats(lease.accountId, lease.generation);
    this.purgeAccountGeneration(lease);
    this.repairRemoteIdLookup(lease);
  }

  /**
   * One-time migration for pages indexed before the provider-stable identity
   * was persisted: a page whose payload lacks `remoteIdLookup` but whose source
   * message now carries one is re-encrypted in place with the SAME source
   * revision and content (a new page revision) so Gmail label copies of one
   * physical mail collapse during dedup. Runs once per account generation,
   * lazily on warm-up; a failure is retried on the next warm-up.
   */
  private repairRemoteIdLookup(lease: AccountGenerationLease): void {
    const generationKey = `${lease.accountId}:${lease.generation}`;
    if (this.remoteIdRepairedGenerations.has(generationKey)) return;
    try {
      // Only pages whose message NOW carries a provider-stable id need repair.
      // The prefix map is computed once per generation and reused, so warm-up
      // stays a single JOIN rather than re-scanning on every search.
      let prefixToRemoteId = this.remoteIdCandidatePrefixes.get(generationKey);
      if (!prefixToRemoteId) {
        const candidates = this.options.db.prepare(`
          SELECT DISTINCT i.message_id AS messageId, m.remote_id_lookup AS remoteIdLookup
          FROM agent_rag_index i
          JOIN messages m ON m.id = i.message_id AND m.account_id = i.account_id
          WHERE i.account_id = ? AND i.account_generation = ?
            AND m.remote_id_lookup IS NOT NULL AND m.remote_id_lookup <> ''
        `).all(lease.accountId, lease.generation) as Array<{ messageId: string; remoteIdLookup: string }>;
        prefixToRemoteId = new Map(candidates.map((candidate) => [pagePrefix(candidate.messageId), candidate.remoteIdLookup]));
        this.remoteIdCandidatePrefixes.set(generationKey, prefixToRemoteId);
        if (candidates.length === 0) {
          this.remoteIdRepairedGenerations.add(generationKey);
          this.remoteIdRepairCursor.delete(generationKey);
          return;
        }
      }
      const cursor = this.remoteIdRepairCursor.get(generationKey) ?? "";
      const pages = this.pageStore.listMetadata(lease)
        .filter((page) => page.state === "active")
        .sort((left, right) => left.pageId.localeCompare(right.pageId));
      let repaired = 0;
      let scannedToEnd = true;
      for (const page of pages) {
        if (page.pageId <= cursor) continue;
        // Advance the cursor on every inspected page so a later warm-up resumes
        // right after it, whether or not this page needed a repair.
        this.remoteIdRepairCursor.set(generationKey, page.pageId);
        let remoteIdLookup: string | undefined;
        for (const [prefix, remoteId] of prefixToRemoteId) {
          if (page.pageId.startsWith(prefix)) { remoteIdLookup = remoteId; break; }
        }
        if (!remoteIdLookup) continue;
        const decrypted = this.pageStore.get(lease, page.pageId);
        if (!decrypted) continue;
        const payload = parsePayload(decrypted.payload);
        if (!payload || payload.remoteIdLookup) continue;
        const nextPayload: AgentRagPagePayload = { ...payload, remoteIdLookup };
        const revised = this.pageStore.put({
          lease,
          pageId: page.pageId,
          pageRevision: this.nextPageRevision(lease, page.pageId, page),
          pageKind: page.pageKind,
          payload: nextPayload,
        });
        this.upsertIndex({ ...revised, payload: nextPayload });
        repaired += 1;
        if (repaired >= REMOTE_ID_REPAIR_BATCH) {
          scannedToEnd = false;
          break;
        }
      }
      if (scannedToEnd) {
        this.remoteIdRepairedGenerations.add(generationKey);
        this.remoteIdRepairCursor.delete(generationKey);
        this.remoteIdCandidatePrefixes.delete(generationKey);
      }
    } catch {
      // Best-effort migration; a failure keeps the cursor so the next warm-up
      // resumes from where it stopped instead of restarting the whole pass.
    }
  }

  /**
   * Reclaims storage for a generation exactly once per process: tombstoned
   * pages (all revisions) and stale revisions of active pages are removed from
   * the encrypted store after the process-local index has been warmed.
   */
  private purgeAccountGeneration(lease: AccountGenerationLease): void {
    const generationKey = `${lease.accountId}:${lease.generation}`;
    if (this.purgedGenerations.has(generationKey)) return;
    this.purgedGenerations.add(generationKey);
    try {
      this.pageStore.purgeTombstoned(lease);
    } catch {
      // Purge is best-effort maintenance; a failure must not block retrieval.
      // The generation is retried on the next warm-up.
      this.purgedGenerations.delete(generationKey);
    }
  }

  private upsertIndex(page: DecryptedRagPage): void {
    const payload = parsePayload(page.payload);
    if (!payload) return;
    // A re-ingested page supersedes its older revisions everywhere.
    for (const revision of this.ragIndex.pageRevisionsFor(page.accountId, page.accountGeneration, page.pageId)) {
      if (revision !== page.pageRevision) {
        this.semantic.removeMany([indexKey(page.accountId, page.accountGeneration, page.pageId, revision)]);
      }
    }
    const entry: IndexedPage = {
      accountId: page.accountId,
      accountGeneration: page.accountGeneration,
      pageId: page.pageId,
      pageRevision: page.pageRevision,
      payload,
    };
    this.ragIndex.replacePage({
      accountId: page.accountId,
      accountGeneration: page.accountGeneration,
      pageId: page.pageId,
      pageRevision: page.pageRevision,
      messageId: payload.messageId,
      terms: indexTermsFor(payload),
      termCount: indexTermCount(payload),
      ...(typeof payload.sentAt === "string" ? { sentAt: payload.sentAt } : {}),
    });
    this.scheduleSemanticIndex(entry);
  }

  private removeIndex(accountId: string, generation: number, pageId: string): void {
    for (const [key, entry] of this.pendingSemantic) {
      if (entry.accountId === accountId && entry.accountGeneration === generation && entry.pageId === pageId) {
        this.pendingSemantic.delete(key);
      }
    }
    this.ragIndex.removePage(accountId, generation, pageId);
  }

  /**
   * Queues an incremental embedding of a page. Embeddings are fire-and-forget:
   * the query path and lexical retrieval never wait for them, and a failed
   * embed simply leaves the page out of the semantic index. A newer page
   * revision supersedes a pending or in-flight embed for the same page.
   */
  private scheduleSemanticIndex(entry: IndexedPage): void {
    if (!this.embedding) return;
    const key = metadataKey(entry.accountId, entry.accountGeneration, entry.pageId);
    this.pendingSemantic.set(key, entry);
    void this.pumpSemantic();
  }

  private async pumpSemantic(): Promise<void> {
    if (this.semanticPump) return;
    const run = async () => {
      while (!this.stopped && this.pendingSemantic.size > 0) {
        const first = this.pendingSemantic.entries().next().value;
        if (!first) break;
        const [key, entry] = first;
        this.pendingSemantic.delete(key);
        try {
          const vector = await this.embedPage(entry);
          if (!vector) continue;
          // Publish only when the page revision is still the current active one.
          const current = this.options.db.prepare(`
            SELECT 1 FROM agent_rag_pages
            WHERE account_id = ? AND account_generation = ? AND page_id = ? AND page_revision = ? AND state = 'active'
            LIMIT 1
          `).get(entry.accountId, entry.accountGeneration, entry.pageId, entry.pageRevision);
          if (!current) continue;
          const indexKeyValue = indexKey(entry.accountId, entry.accountGeneration, entry.pageId, entry.pageRevision);
          this.semantic.upsert({
            id: indexKeyValue,
            accountId: entry.accountId,
            accountGeneration: entry.accountGeneration,
            vector,
            candidate: {
              id: indexKeyValue,
              citation: asCitation(entry, 0),
            },
          });
        } catch {
          // Embedding failures are silent: lexical retrieval still covers the page.
        }
      }
    };
    this.semanticPump = run().finally(() => {
      this.semanticPump = undefined;
    });
    return this.semanticPump;
  }

  private async embedPage(entry: IndexedPage): Promise<readonly number[] | undefined> {
    if (!this.embedding) return undefined;
    const text = `${entry.payload.subject}\n${entry.payload.sender}\n${entry.payload.content}`.slice(0, 500_000) || " ";
    const response = await this.embedding.provider.embed({
      requestId: `rag-index-${randomUUID()}`,
      providerId: this.embedding.provider.id,
      model: this.embedding.model,
      inputs: [text],
    });
    const vector = response.vectors[0];
    return vector?.length ? vector : undefined;
  }
}
