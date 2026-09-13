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

