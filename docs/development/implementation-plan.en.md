# NamiMail Agent Implementation Plan

[Chinese](implementation-plan.zh-CN.md) | [English](implementation-plan.en.md)

## Scope and invariants

This plan defines the implementation order for the local-first NamiMail Agent, mail retrieval, CLI, and MCP integration. It does not change existing IMAP sync, SMTP idempotency, or Sent-folder reconciliation semantics.

- Electron `AgentHost` is the sole production owner of the DPAPI-unwrapped master key, SQLite, sync, update lifecycle, and Agent Runtime.
- GUI, CLI, and MCP share the `@nami/agent-core` tool registry and permission engine. CLI/MCP never open SQLite or reuse the renderer local API token.
- External callers use only a paired local Broker. If a current-user SID-DACL named pipe cannot be secured, startup fails closed with no TCP or HTTP fallback.
- Mail and attachments are untrusted data. Models may receive them only as context, never as instructions or authorization.
- Cloud-model egress is off by default. A user must visibly consent for a provider before selected context may be sent to it.
- Send, forward, permanent delete, and bulk writes require a visible, immutable, one-time GUI confirmation. `--yes`, MCP, and model output cannot bypass it.
- Experimental local NLLB-200 translation remains separate and optional. It is not the default Agent model, does not translate mail automatically, and preserves the existing explicit translation notice.

## Phases

| Phase | Deliverable | Acceptance | Rollback |
| --- | --- | --- | --- |
| 1. Shared foundation | Versioned contracts, tool registry, default-deny permissions, provider capability model | Contract/core tests; clear failure without a provider | Disable before Agent data exists |
| 2. Secure persistence | Agent schema version, account generation fence, encrypted DEKs, source-event outbox, conversations and audit records | Repeatable migration; deleted account keys cannot decrypt | Stop Runtime; mail store is unaffected |
| 3. Read tools and RAG | Cleaning, structured chunks, encrypted pages, in-memory retrieval, citations, incremental/delete processing | Sync mutations and deletions produce auditable events; retrieval excludes deleted data | Clear and rebuild Agent index |
| 4. In-app chat | Conversations, stream state, citations, scope/context selection, stop/retry, confirmation panel | Keyboard access, theme consistency, recoverable no-provider state | Close Agent workspace without affecting mail |
| 5. Write tools | Draft, reply/forward draft, flags, move, archive, send confirmation | High-risk write is denied until confirmed; SMTP idempotency is reused | Disable write tools and retain read-only Agent |
| 6. CLI and MCP | Pairing, Broker, read-only CLI/MCP, stable JSON errors and audit | Clear GUI-off behavior; no direct SQLite | Remove PATH shim and revoke pairing |
| 7. Release readiness | Docs, migration/failure tests, Electron/installer validation | Node, Electron, installed app, and update-drain paths verified | No remote push or release action |

## Ownership

| Module | Location | Responsibility |
| --- | --- | --- |
| Protocol | `packages/agent-contracts` | Versioned schemas, errors, events, caller and confirmation contracts |
| Core | `packages/agent-core` | Tool registry, permission decisions, provider adapters, runtime orchestration |
| RAG storage | `apps/server/src/agent` | SQLite schema, encryption, lifecycle fence, events, retrieval |
| Mail integration | `apps/server/src` | Transactional sync/deletion events, GUI HTTP adapter, reuse of mail services |
| Desktop host | `apps/desktop/src/agent`, `main.mts` | SID-DACL lease, Broker, update drain, single instance, CLI service mode |
| UI | `apps/web/src` | Chat workspace, visible confirmation, citations, provider/privacy settings, localization |
| Docs | `docs/{agent,rag,cli,mcp,development}` | Contracts, boundaries, migration, troubleshooting, acceptance evidence |

## Test matrix

1. Unit: schemas, normalization, cleaning, chunks, crypto AAD, permissions, provider errors, CLI parsing, MCP schemas.
2. Integration: transactional mail mutation/outbox, account-deletion fence, retry, retrieval filtering, GUI confirmation, Broker pairing.
3. End-to-end: open Agent, choose scope, ask, inspect citations, save a draft, confirm send, issue read-only CLI/MCP queries.
4. Failure: model timeout/rate limit, offline network, database lock, sync deletion, duplicate event, crash recovery, failed update drain, malicious prompt injection in mail.
5. Release: Node typecheck/tests, Web build, Electron SQLite check, desktop smoke, install/uninstall, update ZIP cleanup.

## Rejected options

- A browser-reachable local HTTP Agent endpoint is not added: it cannot replace a SID-DACL pipe and pairing-authenticated Broker.
- The first release does not ship a separate persistent vector service. Encrypted persistent pages plus in-memory retrieval structures share the mail database lifecycle and avoid Electron native-module distribution risk. The embedding index remains replaceable.
- Models and external CLI callers do not send through SMTP directly. They can create intent and drafts; the existing mail path is invoked only after one-time GUI confirmation.
