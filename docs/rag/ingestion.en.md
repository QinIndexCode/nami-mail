# RAG Ingestion

[Chinese](ingestion.zh-CN.md) | [English](ingestion.en.md)

## Source events

RAG does not poll and guess mail changes. Existing sync or mail operations commit a mail-state change and enqueue an Agent source event in the same local SQLite transaction. Current mail-state wiring emits message upsert/delete and account-generation/deletion events; attachment event types are reserved contracts for a later extractor, and the current producer does not create standalone attachment-text events.

Events carry event ID, account, generation, source revision, occurrence time, type, and digest. Sensitive source locators are encrypted; public store views expose only opaque summaries so a background queue does not disclose message IDs or bodies.

## Atomicity and retry

- `enqueueWithinTransaction` must be called by the already-open database transaction; a rolled-back mail write also rolls back its event.
- This does not claim a global distributed transaction with IMAP or SMTP. Existing sync/send reconciliation resolves remote uncertainty.
- Workers claim only `pending` or retryable failed events, mark completed work `completed`, and record an error code/next attempt for recoverable faults.
- Source, revision, and event type deduplicate. Duplicate delivery must be idempotent and cannot create duplicate pages or citations.

## Ingestion steps

1. Validate event account/current generation and register a cancellable task.
2. Read the current source through restricted existing mail services, not an event body.
3. Create a retrieval copy, chunk deterministically, and calculate versions/content digests.
4. Write encrypted pages in the same generation and update in-memory retrieval structures.
5. Recheck that work is current, then complete the event; stale work must cancel rather than commit.

Current RAG does not create pages from attachment bodies. Attachment-metadata changes only cause the worker to process the parent message again; binary, encrypted, corrupt, oversized, or failed attachments are not parsed, uploaded, or made searchable as body text. A future attachment extractor needs separate authorization, type/size bounds, explainable failure states, and tests, and must not block an account or silently egress content.

## Backfill and rebuild

Initial enablement, cleaner/chunker version changes, or index damage may create bounded backfill. It needs account scope, rate/memory budget, cancellation, and observable progress; it cannot cross a deletion generation or overwrite a newer revision that is committing. Rebuild affects Agent pages and memory structures only, never migrates or rewrites original mail.

See [Cleaning](cleaning.en.md), [Chunking](chunking.en.md), and [Deletion sync](deletion-sync.en.md).
