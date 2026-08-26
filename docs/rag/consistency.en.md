# RAG Consistency

[Chinese](consistency.zh-CN.md) | [English](consistency.en.md)

## Facts that must hold

1. Every active page belongs to an existing active account generation.
2. Every page revision traces to a message-source revision and cleaner/chunker versions; the current runtime has no attachment-body pages or attachment-page revisions.
3. Deleted pages and old generations never enter retrieval.
4. A local mail-state mutation and source event commit together or roll back together.
5. One worker claims a source event; retry, cancellation, and completion have recoverable state.
6. In-memory retrieval structures can be cleared and rebuilt; they are not the source of truth.
7. After a DEK is discarded, there is no “repair” route to restore old Agent plaintext.

## Verification layers

**Lightweight runtime checks** validate schema version, account generation, page state, content digest, and AAD on read/write. A mismatch denies the operation.

**Maintenance checks** in explicit `rag verify`/maintenance jobs count pending/failed/cancelled events, find missing pages or old-version active pages, check source revisions, and confirm memory structures contain only readable active pages. Verification is read-only by default; it must not silently rebuild or delete.

**Repair flow** stops new ingestion for the relevant account, records a diagnostic summary, selects bounded backfill/rebuild, verifies pages and citations, then retires old pages. Undecryptable deleted-account data is reported as revoked, not repaired.

## Crash recovery

Before transaction commit, neither mail nor event exists; after commit, work can continue from `pending` or recovered failure. A worker cannot treat “processing started” as “completed.” If restart loses an in-memory index, rebuild only from current decryptable pages; never recover mail body from logs or provider cache.

## Observability

Record non-sensitive metrics: event-state counts, oldest pending age, retries, pages per account, retrieval latency, memory-structure size, version distribution, and denial reasons. Over budget, slow or pause backfill rather than deleting user data to hide the issue.

See [Troubleshooting](troubleshooting.en.md) and the [testing plan](../development/testing-plan.en.md).
