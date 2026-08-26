# Agent/RAG Testing Plan

[Chinese](testing-plan.zh-CN.md) | [English](testing-plan.en.md)

## Principle

Test results prove only the layer run. Node unit tests, Web build, Electron main process, installer, real update, and actual secure IPC are distinct evidence and cannot replace each other. Fixtures are synthetic mail only, with no real bodies, credentials, or verification codes.

## Common commands

On Windows use `npm.cmd`:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run verify:node-sqlite
npm.cmd run verify:electron-sqlite
npm.cmd run smoke:runtime
npm.cmd run smoke:desktop
npm.cmd run smoke:package
npm.cmd run smoke:installer
```

Run a single workspace as risk requires, for example `npm.cmd --workspace @nami/server run test`. Electron `better-sqlite3` ABI differs from Node ABI; run the matching verification/rebuild before Electron smoke and do not label an ABI failure as Agent logic failure.

## Test matrix

| Layer | Focus |
| --- | --- |
| Contract/core unit | Schemas, error envelopes, tool resolution, default deny, confirmation hash, missing-audit refusal, provider error mapping |
| RAG unit | HTML/plain-text cleaning, quotes/signatures, CJK token estimate, deterministic chunks, crypto AAD, source-event claim/retry/deduplication |
| Store integration | V1/V2 migration, account generation, DEK discard, immutable conversation/confirmation/audit, same-transaction mail events |
| Mail integration | Sync upsert/delete, move/archive, unknown delivery, Sent-folder reconciliation untouched by Agent |
| Provider/Runtime | Unconfigured, no egress consent, timeout, TLS/network, auth, rate limit, cancellation, invalid tool call, stream termination |
| CLI/MCP | Parser, JSON envelope, read-only denial, pairing/replay/scope, stdio schema, GUI-not-running error |
| GUI | Scope selector, loading/error/empty state, selectable/copyable text and citations, visible confirmation, no blur overlay/white focus rail |
| Desktop/installer | Single instance, service mode, SID-DACL adapter, update drain/recovery, SQLite ABI, install/uninstall/update ZIP cleanup |

## Required attacks and failures

- Mail HTML/body that fakes a system instruction or tool call.
- CLI/MCP forged scope, replayed counter, and wrong host/boot signature.
- Account deletion concurrent with ingestion, query, confirmation, and sending.
- Database lock, crash, duplicate/out-of-order source event, migration fault, and lost memory index.
- Provider invalid JSON, oversized frame, oversized tool argument, 401/429/5xx, TLS/offline.
- New request after update starts, failed drain, failed installer start, and recovery.

## Manual release evidence

At minimum, validate a real SID-DACL (not a mock) in the installed Windows app, CLI/MCP read-only access, visible confirmation, unreadability after account deletion, update drain, RAG rebuild after restart, and that local NLLB translation remains opt-in/user-triggered. Without that evidence, do not mark the feature release-ready.

See the [release checklist](release-checklist.en.md) and [RAG troubleshooting](../rag/troubleshooting.en.md).
