import type { Citation } from "@nami/agent-contracts";
import type { CitationRevalidator} from "./citations.js";
import { type StoredCitationReference } from "./citations.js";

export type RagMetadataFilter = {
  accountIds: readonly string[];
  folder?: string;
  sender?: string;
  recipient?: string;
  threadId?: string;
  after?: string;
  before?: string;
  labels?: readonly string[];
};

export type RagRetrievalQuery = {
  text: string;
  filter: RagMetadataFilter;
  limit: number;
};

export type RagRetrievalCandidate = {
  id: string;
  citation: StoredCitationReference;
  excerpt?: string;
  metadataScore?: number;
  semanticScore?: number;
};

export type RagRetrievalResult = {
  id: string;
  citation: Citation;
  excerpt?: string;
  score: number;
  metadataScore?: number;
  semanticScore?: number;
};

export interface MetadataRetriever {
  searchMetadata(query: RagRetrievalQuery, signal?: AbortSignal): Promise<readonly RagRetrievalCandidate[]>;
}

export interface SemanticRetriever {
  searchSemantic(query: RagRetrievalQuery, signal?: AbortSignal): Promise<readonly RagRetrievalCandidate[]>;
}

function validateQuery(query: RagRetrievalQuery): void {
  if (!query.text.trim()) throw new Error("RAG query text is required.");
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("RAG query limit is invalid.");
  if (new Set(query.filter.accountIds).size !== query.filter.accountIds.length) {
    throw new Error("RAG account scope contains duplicates.");
  }
}

function rankMap(candidates: readonly RagRetrievalCandidate[]): Map<string, { candidate: RagRetrievalCandidate; rank: number }> {
  const result = new Map<string, { candidate: RagRetrievalCandidate; rank: number }>();
  candidates.forEach((candidate, index) => {
    if (!candidate.id || result.has(candidate.id)) return;
    result.set(candidate.id, { candidate, rank: index + 1 });
  });
  return result;
}

/** Hybrid retrieval fuses independent metadata and semantic rankers, then validates citations. */
export class HybridRagRetriever {
  constructor(
    private readonly metadata: MetadataRetriever,
    private readonly semantic: SemanticRetriever,
    private readonly citations: CitationRevalidator,
    private readonly reciprocalRankConstant = 60,
  ) {
    if (!Number.isSafeInteger(reciprocalRankConstant) || reciprocalRankConstant < 1) {
      throw new Error("RAG reciprocal-rank constant is invalid.");
    }
  }

  async search(query: RagRetrievalQuery, signal?: AbortSignal): Promise<RagRetrievalResult[]> {
    validateQuery(query);
    if (signal?.aborted) return [];
    const [metadataCandidates, semanticCandidates] = await Promise.all([
      this.metadata.searchMetadata(query, signal),
      this.semantic.searchSemantic(query, signal),
    ]);
    if (signal?.aborted) return [];
    const metadataRanked = rankMap(metadataCandidates);
    const semanticRanked = rankMap(semanticCandidates);
    const mergedIds = new Set([...metadataRanked.keys(), ...semanticRanked.keys()]);
    const allowedAccounts = new Set(query.filter.accountIds);
    const merged: RagRetrievalResult[] = [];
    for (const id of mergedIds) {
      const metadata = metadataRanked.get(id);
      const semantic = semanticRanked.get(id);
      const candidate = metadata?.candidate ?? semantic?.candidate;
      if (!candidate || !allowedAccounts.has(candidate.citation.citation.accountId)) continue;
      const citation = this.citations.revalidate(candidate.citation);
      if (!citation.valid) continue;
      const score = (metadata ? 1 / (this.reciprocalRankConstant + metadata.rank) : 0)
        + (semantic ? 1 / (this.reciprocalRankConstant + semantic.rank) : 0);
      merged.push({
        id,
        citation: citation.citation,
        ...(candidate.excerpt ? { excerpt: candidate.excerpt } : {}),
        score,
        ...(metadata?.candidate.metadataScore !== undefined ? { metadataScore: metadata.candidate.metadataScore } : {}),
        ...(semantic?.candidate.semanticScore !== undefined ? { semanticScore: semantic.candidate.semanticScore } : {}),
      });
    }
    return merged
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, query.limit);
  }
}

export type InMemorySemanticEntry = {
  id: string;
  accountId: string;
  accountGeneration: number;
  vector: readonly number[];
  candidate: RagRetrievalCandidate;
};

function normalizeVector(vector: readonly number[]): Float64Array {
  if (!vector.length || vector.length > 16_384) throw new Error("Semantic vector dimension is invalid.");
  let sum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Semantic vector contains a non-finite value.");
    sum += value * value;
  }
  if (sum === 0) throw new Error("Semantic vector must not be zero.");
  const magnitude = Math.sqrt(sum);
  return Float64Array.from(vector, (value) => value / magnitude);
}

function cosine(left: Float64Array, right: Float64Array): number {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!;
  return score;
}

/**
 * Process-local semantic cache. It intentionally has no serialization API;
 * callers rebuild it from encrypted RAG pages and evict it on account deletion.
 */
export class InMemorySemanticIndex implements SemanticRetriever {
  private readonly entries = new Map<string, { accountId: string; accountGeneration: number; vector: Float64Array; candidate: RagRetrievalCandidate }>();

  upsert(entry: InMemorySemanticEntry): void {
    if (!entry.id || entry.id.length > 512) throw new Error("Semantic entry id is invalid.");
    if (!entry.accountId || !Number.isSafeInteger(entry.accountGeneration) || entry.accountGeneration < 0) {
      throw new Error("Semantic entry account scope is invalid.");
    }
    this.entries.set(entry.id, {
      accountId: entry.accountId,
      accountGeneration: entry.accountGeneration,
      vector: normalizeVector(entry.vector),
      candidate: entry.candidate,
    });
  }

  removeAccount(accountId: string, generationAtMost = Number.MAX_SAFE_INTEGER): void {
    for (const [id, entry] of this.entries) {
      if (entry.accountId === accountId && entry.accountGeneration <= generationAtMost) this.entries.delete(id);
    }
  }

  /** Removes entries whose ids match the given page-revision keys exactly. */
  removeMany(ids: readonly string[]): void {
    for (const id of ids) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  async searchSemantic(query: RagRetrievalQuery & { vector?: readonly number[] }, signal?: AbortSignal): Promise<readonly RagRetrievalCandidate[]> {
    if (!query.vector || signal?.aborted) return [];
    const vector = normalizeVector(query.vector);
    const accounts = new Set(query.filter.accountIds);
    return [...this.entries.entries()]
      .filter(([, entry]) => accounts.has(entry.accountId))
      .map(([id, entry]) => ({
        id,
        candidate: { ...entry.candidate, semanticScore: cosine(vector, entry.vector) },
      }))
      .filter(({ candidate }) => (candidate.semanticScore ?? Number.NEGATIVE_INFINITY) > Number.NEGATIVE_INFINITY)
      .sort((left, right) => (right.candidate.semanticScore ?? 0) - (left.candidate.semanticScore ?? 0) || left.id.localeCompare(right.id))
      .slice(0, query.limit)
      .map(({ candidate }) => candidate);
  }
}
