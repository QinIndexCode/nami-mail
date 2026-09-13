# RAG Retrieval

[Chinese](retrieval.zh-CN.md) | [English](retrieval.en.md)

## Query boundary

A retrieval request needs a verified caller, account scope, and current account generation first. Apply permission and scope before querying pages; do not recall an entire store and filter only in UI. Deleted pages, old generations, digest-mismatched pages, and undecryptable pages are never candidates.

## Current retrieval

The current runtime uses lexical term scoring and structured scope filters, and falls back to **query expansion** as its second arm when the lexical one returns nothing. It verifies account scope, current generation, message restrictions, and page state, then generates lexical candidates from the persisted SQLite inverted index (`agent_rag_index`) by fetching postings per query term and scoring them with BM25, decrypting payloads only for the top candidate pool; when the lexical arm has no candidate at all (or its best score falls below a threshold that is disabled by default), it asks the user-configured default **chat** provider for paraphrases of the question — synonyms, domain terms, other likely languages — and searches the same inverted index with those, merging both rankings with reciprocal-rank fusion (RRF) before citations are revalidated. Persistent pages remain encrypted; the lexical index is a SQLite inverted table inside the Agent store (tokens and tf counts only), and **query expansion produces no index-side storage at all — no vectors, no embeddings, no cold-start rebuild**.

Suggested flow:

1. Normalize query and constrain length, accounts, time/folder filters, and result count.
2. Read active current-generation pages and calculate lexical candidates; only when the lexical arm returns nothing (or scores below the threshold) request expanded terms and calculate the second ranking.
3. Fuse and order candidates, revalidate by source/revision, and apply result/page limits.
4. Verify pages remain decryptable and sources still belong to current scope.
5. Return results with stable score explanation and citations; only selected minimum context reaches a provider.

## Citations

Each result includes account, message/page identity, source revision, chunk index, necessary excerpt, and an in-app target. A citation is not proof that a model answer is trustworthy: UI permits opening the original mail and selecting/copying text, while indicating that indexing may be stale or cleaned.

## Query expansion and the privacy boundary

The second arm is **query expansion**, not vector search. In languages without word boundaries, the user's wording and the mail's wording routinely share no character at all (「报销」 versus 「费用申请」), and no amount of keyword tuning bridges that, so when the lexical arm returns nothing (or scores below the threshold, which is disabled by default) the worker uses the current default **chat** provider to produce a handful of search terms — synonyms, domain terms, translations — and searches the same local inverted index with them. **Only the user's question is sent to the provider; mail bodies and excerpts never leave the machine**: expansion reads no page content and ships none.

Privacy boundary:

- An expansion request carries the user's question text and nothing else, sent to the configured default provider; for local services such as Ollama the endpoint is restricted to loopback, so even the question stays on the machine.
- Cloud endpoints (such as HTTPS OpenAI-compatible services) share the same authorization boundary as chat: when a cloud provider has not explicitly enabled "allow cloud processing of mail content" (`allowCloudMailContent`), retrieval does not run at all and no expansion request is made.
- Expansion is best-effort and budgeted by case: **10s when the lexical arm found nothing** (a local or self-hosted model routinely needs 4–6s — measured 4.5–6s against a local `openai-compatible` endpoint — and the alternative to waiting is answering with no mail context at all), and **800ms for weak recall**, where candidates already exist and a slow model must not delay an answer that has one. A budget that expires mid-answer still parses whatever terms arrived instead of wasting the time spent.
- An unavailable provider, a malformed answer, or a cancel all mean "no extra terms", so retrieval falls back to lexical only — it neither breaks nor visibly slows a reply. Repeated questions are served from a bounded cache instead of a second call.
- The expansion prompt is deliberately one sentence: local models are very sensitive to prompt length (measured 4.5–12s for a five-sentence version versus 2.3–6.9s for one sentence at equal term quality), while a too-terse prompt lets the model drift into a conversation (measured 15s of unusable output).
- Expansion stores nothing: no vectors, no second plaintext copy, no cold-start rebuild. The retrieval surface remains the existing encrypted pages and the local inverted index.

## Performance and degradation

Queries have time, memory, and candidate budgets (the expansion call carries an 800ms hard cap). Missing or corrupted inverted indexes, unavailable providers, unready pages, or deleting accounts return an explainable state rather than partial scope-escaping results. Do not improve cold start by persisting plaintext caches; persisting the lexical index does not change this boundary — the index table holds derived tokens only, and message text remains confined to encrypted pages and memory.

The second arm's value is observable: `GET /api/agent/rag/verify` returns the consistency report with an `expansion` counter — `triggered` (searches where the lexical arm came back empty), `recovered` (those expansion rescued), and `empty` (those it could not). Read those three numbers before lowering the expansion threshold or widening the retrieval budget.

See [Consistency](consistency.en.md) and [Security](../agent/security.en.md).
