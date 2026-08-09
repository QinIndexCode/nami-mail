# RAG Troubleshooting

[Chinese](troubleshooting.zh-CN.md) | [English](troubleshooting.en.md)

## A query returns no results

First check selected accounts, folder/date filters, and whether the account remains active. New mail may still be pending ingestion; deleted mail and old-generation content should be invisible. Do not “verify” by expanding to all accounts or querying SQLite directly.

## Index is not ready or repeatedly fails

Inspect non-sensitive event-state summaries, error codes, and oldest pending age. Network/provider errors affect optional cloud capability only and must not block lexical/local paths or mail sync. Current RAG does not parse attachment bodies, so do not present attachment-parser failures as a shipped runtime state; report undecryptable data and revoked generations separately. Run scoped `rag verify`, then decide on backfill or rebuild.

## Content remains visible after deletion

Stop sending that content to a provider immediately. Verify that the mail deletion transaction included a delete source event, the query filters deleted/generation, and the memory structure was rebuilt in the current host. If the account was deleted, never restore a DEK to recover a result; clear display cache and verify scope/generation checks.

## Results are wrong after a version upgrade

Check schema, cleaner, chunker, and page-revision versions. Unsupported migration, schema newer than Runtime, or incomplete table shape must fail closed. Preserve a database copy and error summary, then follow the migration plan; never manually drop `agent_*` tables or edit the schema-version row.

## Memory or performance is too high

Bound query/backfill scope, candidates, and concurrency; check for an unfinished full backfill or duplicate events. Memory structures can be released and rebuilt from decryptable pages. Do not persist plaintext vector caches or delete pages belonging to active accounts just to reduce memory.

## Reporting an issue

Provide app version, OS, error code, `requestId`, local/cloud provider status, account count, and reproduction steps. Do not attach mail body, verification codes visible in screenshots, attachments, OAuth tokens, API keys, passwords, or database files.

See [Agent security](../agent/security.en.md) and the [migration plan](../development/migration-plan.en.md).
