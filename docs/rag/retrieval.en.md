# RAG Retrieval

[Chinese](retrieval.md) | [English](retrieval.en.md)

## Query boundary

A retrieval request needs a verified caller, account scope, and current account generation first. Apply permission and scope before querying pages; do not recall an entire store and filter only in UI. Deleted pages, old generations, digest-mismatched pages, and undecryptable pages are never candidates.

## Current retrieval

The current runtime uses lexical term scoring and structured scope filters only. It verifies account scope, current generation, message restrictions, and page state before scoring active decrypted pages held in memory, then revalidates citations. Persistent pages remain encrypted and the lexical memory index can be rebuilt from pages and source events; there is no wired production embedding provider, semantic index, or vector database.

Suggested flow:

1. Normalize query and constrain length, accounts, time/folder filters, and result count.
2. Read active current-generation pages, calculate lexical candidates, and order them by score.
3. Revalidate candidates by source/revision and apply result/page limits.
4. Verify pages remain decryptable and sources still belong to current scope.
5. Return results with stable score explanation and citations; only selected minimum context reaches a provider.

## Citations

Each result includes account, message/page identity, source revision, chunk index, necessary excerpt, and an in-app target. A citation is not proof that a model answer is trustworthy: UI permits opening the original mail and selecting/copying text, while indicating that indexing may be stale or cleaned.

## Future embedding boundary

Embeddings are a reserved replaceable boundary, not a current runtime capability. A future cloud embedding integration needs separate visible consent for mail-text egress and must name provider/scope; until it is implemented, reviewed, and verified, do not present semantic results or cloud embeddings as available.

## Performance and degradation

Queries have time, memory, and candidate budgets. Missing memory indexes, unavailable providers, unready pages, or deleting accounts return an explainable state rather than partial scope-escaping results. Do not improve cold start by persisting plaintext caches.

See [Consistency](consistency.en.md) and [Security](../agent/security.en.md).
