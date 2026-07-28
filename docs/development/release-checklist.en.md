# Agent/RAG Release Checklist

[Chinese](release-checklist.md) | [English](release-checklist.en.md)

This checklist is a release gate, not a future-work wish list. Do not publish an installer, GitHub Release, or update manifest claiming Agent/RAG/CLI/MCP while any blocker remains.

## Code and documentation

- [ ] Chinese/English documentation pairs, relative links, and commands are checked; planned capabilities are not written as shipped.
- [ ] Agent/RAG/CLI/MCP schemas, error codes, permissions, and user copy are reviewed.
- [ ] All new code comments are English; no debug keys, test credentials, real mail, or local databases enter version control.
- [ ] Local NLLB-200 translation remains explicitly experimental, opt-in, and not an Agent provider.

## Security blockers

- [ ] Windows production Broker uses a real current-user SID-DACL exclusive named pipe, verified in an installed build.
- [ ] Missing adapter, failed pairing/signature/replay, and update drain fail closed; no TCP/HTTP/SQLite downgrade path exists.
- [ ] CLI/MCP v1 is read-only and cannot write/send through `--yes`, arguments, or model output.
- [ ] GUI high-risk confirmation is immutable, one-time, visible, and durably audited; account-generation change invalidates it.
- [ ] Cloud mail-content egress is off by default; consent, provider configuration, and credential storage are manually validated.

## Data and RAG blockers

- [ ] `applyAgentStoreSchema` runs in the real AgentHost lifecycle before any Agent access.
- [ ] V1-to-current schema, injected failure, and backup/recovery are tested; unknown versions fail closed.
- [ ] Mail upsert/delete, move, archive, and account deletion generate correct source events in the same transaction as local mail state.
- [ ] Deleted/old-generation pages do not enter retrieval, conversations, or provider context.
- [ ] Crash recovery, retry, rebuild, memory-index clearing, and `rag verify` have real evidence.

## Product and runtime blockers

- [ ] GUI scope, citations, selection/copy, errors, cancellation, confirmation, and empty state are verified in a real desktop window.
- [ ] No provider, no consent, network/TLS, auth, rate limit, and unknown-send state show accurate actionable user information.
- [ ] Agent does not change existing sync, SMTP idempotency, Sent-folder reconciliation, archive, or draft semantics.
- [ ] Single instance, service mode, update drain, and installer-failure recovery are verified in an installed build.

## Build and delivery

- [ ] `npm.cmd run typecheck`, `npm.cmd test`, and `npm.cmd run build` succeed.
- [ ] Node/Electron SQLite ABI verification plus runtime, desktop, package, and installer smoke each succeed separately.
- [ ] Fresh install, existing-version handling, uninstall retain/delete-data choices, and update ZIP download/validation/removal are verified.
- [ ] Update metadata, GitHub Release assets, version, and signing/trust material point to one build; an unsigned build is not called signed.

## Release record

Record build commit, version, test commands, installed-app environment, verified security adapter, known limits, and rollback-material location in release notes. Anything not verified is a blocker or residual risk, never silently omitted.

See the [testing plan](testing-plan.en.md), [migration plan](migration-plan.en.md), and [Agent security](../agent/security.en.md).
