# Agent/RAG Migration Plan

[Chinese](migration-plan.md) | [English](migration-plan.en.md)

## Scope

This plan covers only Agent-owned `agent_*` tables, encrypted pages, source events, conversations, confirmations, audit, and provider configuration. It does not rewrite existing mail schema, IMAP cache, SMTP outbox, or experimental local NLLB translation data.

## Preconditions

1. Only `AgentHost` may open the production database after obtaining its secure lease.
2. Run `applyAgentStoreSchema` before any Agent read/write.
3. Migration needs one SQLite transaction, enough disk, and sync/index work that can be stopped.
4. Before migration, make a recoverable database backup or retain an installer-verified backup; backup access must not be broader than source data.

The current schema has an explicit version row. Version `2` supports an explicit upgrade from version `1`. Unknown table shape, a missing version row, a newer minimum reader, or an older Runtime must fail closed rather than guessing an `ALTER` sequence.

## Execution

1. Drain Agent ingress, stop new Broker/GUI work, and wait for existing writes.
2. Verify SQLite opens, master key is available, schema version is known, and backup completed.
3. Run versioned migration; update the version row only after all DDL/DML and shape checks succeed.
4. Run read-only integrity checks: account lifecycle, page primary key, source-event state/indexes, conversation/confirmation/audit triggers, and provider configuration columns.
5. Restart Runtime, run read-only health/read smoke first, then restore ingestion and GUI.

## V1 to V2 handling

V2 introduces encrypted source locators and stricter source-event claim semantics. Old incomplete events whose locators cannot be safely recovered are cancelled with an explanatory error rather than resumed with an ambiguous ID. Account-generation/deletion events may safely recover. Page tables are rebuilt through an explicit primary-key migration; schema version does not advance before completion.

Continuing every old pending task is therefore not a migration goal. Preventing the wrong mail from being indexed under the wrong account wins; affected active accounts can rebuild through controlled backfill.

## Rollback and recovery

On migration failure, rollback the transaction, keep the old version, stop the host, and retain error code/backup. Once a new version wrote successfully, rolling back an app binary does not safely roll back the database: run only a tested reverse migration or restore backup. Never manually delete `agent_*` tables, edit the version row, copy an old DEK, or force an old Runtime to open a newer schema.

## Data retention

An account deletion making an old DEK unavailable is intentional. Migration, rollback, and backup restore must not resurrect a deleted account's DEK or Agent plaintext. Physical ciphertext deletion occurs only in explicit maintenance that meets retention-window and audit requirements.

## Acceptance

- Validate startup from empty database, V1 fixture, and current-version database.
- After each injected failure, version row and table shape remain consistent.
- Existing mail sync/send paths remain unchanged after migration.
- Affected RAG pages rebuild from existing sources; deleted accounts remain undecryptable.

See the [implementation plan](implementation-plan.en.md) and [RAG consistency](../rag/consistency.en.md).
