# RAG Retrieval

[Chinese](retrieval.zh-CN.md) | [English](retrieval.en.md)

## Query boundary

A retrieval request needs a verified caller, account scope, and current account generation first. Apply permission and scope before querying pages; do not recall an entire store and filter only in UI. Deleted pages, old generations, digest-mismatched pages, and undecryptable pages are never candidates.

## Current retrieval

The current runtime uses lexical term scoring and structured scope filters, and enables hybrid retrieval when the default model provider can serve embeddings. It verifies account scope, current generation, message restrictions, and page state, then generates lexical candidates from the persisted SQLite inverted index (`agent_rag_index`) by fetching postings per query term and scoring them with BM25, decrypting payloads only for the top candidate pool; when semantic retrieval is enabled, pages and the query are both embedded through the user-configured default provider endpoint, and lexical and semantic candidates are merged with reciprocal-rank fusion (RRF) before citations are revalidated. Persistent pages remain encrypted; the lexical index is a SQLite inverted table inside the Agent store (tokens and tf counts only), while the semantic index is an in-memory structure, and both are rebuildable from pages and source events.

Suggested flow:

1. Normalize query and constrain length, accounts, time/folder filters, and result count.
2. Read active current-generation pages, calculate lexical candidates, and — when semantic retrieval is enabled — semantic candidates for the same query vector.
3. Fuse and order candidates, revalidate by source/revision, and apply result/page limits.
4. Verify pages remain decryptable and sources still belong to current scope.
5. Return results with stable score explanation and citations; only selected minimum context reaches a provider.

## Citations

Each result includes account, message/page identity, source revision, chunk index, necessary excerpt, and an in-app target. A citation is not proof that a model answer is trustworthy: UI permits opening the original mail and selecting/copying text, while indicating that indexing may be stale or cleaned.

## Semantic retrieval and the embedding boundary

Semantic retrieval is a wired, optional capability: when the default model provider is `openai-compatible` or `ollama`, an `embeddingModel` is configured (falling back to the chat model), and cloud endpoints have explicit authorization, the RAG worker sends each retrieval page's subject, sender, and body to that provider's embedding endpoint, stores the vectors in an in-memory semantic index, and embeds the query text through the same endpoint before fusing the results with lexical candidates via RRF.

Privacy boundary:

- Embedded mail text goes only to the user-configured default provider endpoint; for local services such as Ollama the endpoint is restricted to loopback, so mail text never leaves the machine.
- Cloud endpoints (such as HTTPS OpenAI-compatible services) share the same authorization boundary as chat and lexical retrieval for mail-text egress: the user must explicitly enable "allow cloud processing of mail content" (`allowCloudMailContent`) in the model configuration.
- Vectors live in memory only: they are never persisted or stored as a second plaintext copy, are cleared when pages are removed, generations change, or the provider switches, and are rebuilt from active pages after a cold start.
- Embedding is best-effort: a failed page embedding only excludes that page from the semantic index (lexical coverage remains); a failed query embedding or fusion degrades the whole query to pure lexical retrieval, so retrieval never breaks because the semantic path is unavailable.

## Performance and degradation

Queries have time, memory, and candidate budgets. Missing or corrupted inverted indexes, unavailable providers, unready pages, or deleting accounts return an explainable state rather than partial scope-escaping results. Do not improve cold start by persisting plaintext caches; persisting the lexical index does not change this boundary — the index table holds derived tokens only, and message text remains confined to encrypted pages and memory.

See [Consistency](consistency.en.md) and [Security](../agent/security.en.md).
