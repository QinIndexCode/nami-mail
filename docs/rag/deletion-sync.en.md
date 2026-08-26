# RAG Deletion Sync

[Chinese](deletion-sync.zh-CN.md) | [English](deletion-sync.en.md)

## Message deletion and attachment-metadata changes

When local mail state is deleted, a draft is deleted, or remote sync confirms deletion, write a delete source event in the same SQLite transaction. A worker deactivates matching pages/removes in-memory candidates by source ID/revision; repeated deletion is safe and idempotent. Retrieval always filters `deleted` pages rather than waiting for asynchronous physical cleanup to hide results.

The current runtime does not maintain attachment-body pages. Attachment-metadata changes reprocess the parent message, while message deletion deactivates that parent message's RAG pages; do not present the reserved attachment-event contract as a shipped attachment-index or deletion path.

Move, archive, and UID changes are not simple deletes. Reuse existing mail-sync semantics and emit upsert/delete events from the actual local source revision. Especially with uncertain IMAP outcome, Agent index cleanliness must not cause mail or pages to be falsely declared deleted.

## Account deletion fence

Account deletion proceeds in this order:

1. In a controlled transaction, advance the account to a new `generation`, set deleting state, and discard the old DEK wrapper.
2. Cancel old-generation source events and active index/query tasks.
3. Write account-generation/deletion events for memory-structure eviction and maintenance record.
4. Perform existing mail-account deletion; mark Agent lifecycle deleted only on success.
5. If mail deletion is cancelled or fails, create a fresh DEK at the deletion generation and rebuild Agent data. Never restore the old DEK.

This is not a promise of immediate physical-row erasure: after DEK discard, old ciphertext is unreadable. A physical purge may run only as explicit maintenance and cannot cross records still needed for audit or destroy migration evidence.

## Generation checks

Every page write, event claim/completion, conversation read, confirmation consumption, and retrieval compares account ID and generation. Old work checks again immediately before commit; on mismatch it cancels with an explainable `account_generation_revoked`/`stale_account_generation` state.

## Acceptance scenarios

- After deleting a message, queries immediately exclude its pages even before asynchronous physical cleanup.
- After deleting an account, old page/conversation ciphertext cannot be unwrapped with the current master key.
- On failed account deletion, old data keys are not silently restored; rebuild only from remaining mail sources.
- Duplicate/out-of-order deletes cannot remove a newer-revision page.

See [Ingestion](ingestion.en.md) and [Consistency](consistency.en.md).
