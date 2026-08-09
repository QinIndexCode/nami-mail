# CLI Permissions And Security

[Chinese](permissions.zh-CN.md) | [MCP security](../mcp/security.en.md)

> **Current-build status: enforced.** The 0.3.0 build ships the external CLI with a Broker, pairing records, and per-entry client permission grants. The access levels, scope, and audit requirements below apply to the external interface; requests that exceed the configured level fail closed.

## Access levels

The three entry points each configure an access level independently: the built-in Agent (`agentAccessLevel`, default `send-confirmed`), the external CLI (`agentCliAccessLevel`, default `read-only`), and the external MCP (`agentMcpAccessLevel`, default `read-only`). The options live in the "Permissions" group of the desktop app settings as three adjacent dropdowns; CLI and MCP are two independent settings with identical content.

For every request, the Broker creates caller context that command-line arguments cannot forge: client identity, entry point (`cli` / `mcp` / `agent`), approved scopes, account scope, interaction capability, and request ID. The Tool Schema and Permission Engine validate those fields again before mail services are reached.

| Access level | Permitted capability | CLI v1 status |
| --- | --- | --- |
| `read-only` | Read-only access to accounts, folders, messages, threads, and attachment metadata. | Default level. |
| `send-confirmed` | Write operations (draft create/update/delete, move, flag, send, reply) each raise a visible confirmation in the Nami Mail desktop app. | Can be enabled in settings; every write needs a desktop confirmation and `--yes` cannot bypass it. |
| `full-access` | Executes all operations automatically within the approved account scope (including send and delete), without per-item confirmation. | Requires reading a warning and explicitly confirming in the UI before enabling; afterwards runs automatically. |

The host constructs an access level for the external caller and clamps it to the configured level; a paired client cannot raise its own level. Requests that exceed the configured level return `PERMISSION_DENIED`. Interaction capability (`interactive` / `canRequestConfirmation`) is only `true` for external callers at the `send-confirmed` level.

The external tool surface is 15 tools (v1): the eight read-only tools use the scopes `read:accounts`, `read:folders`, `read:messages`, and `read:attachments`; the seven write tools (`mail.draft.create`, `mail.draft.update`, `mail.draft.delete`, `messages.move`, `messages.set-flag`, `messages.send`, `mail.reply`) are available at `send-confirmed` and above. Calling a write tool at `read-only` returns `PERMISSION_DENIED`.

## Error codes

Error codes consistent with the current model include:

- `NOT_SUPPORTED`: the tool is not available to an external caller.
- `PERMISSION_DENIED`: access level or scope is not satisfied (including exceeding the configured level).
- `SCOPE_DENIED`: the account is outside the approved scope.
- `CONFIRMATION_REQUIRED`: a visible desktop confirmation is required.
- `TOOL_INPUT_INVALID` / `INVALID_ARGUMENT`: the input does not match the Tool Schema.
- `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` / `BROKER_SECURITY_UNAVAILABLE`: Broker security checks failed.
- `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, `PAIRING_REQUIRED` / `PAIRING_REVOKED`: host, update, or pairing state issues.

The `READ_ONLY` error code is no longer used.

## Account scope

A pairing record may permit all accounts, selected accounts, or no accounts. Every request account ID must belong to that scope:

- A caller with no account scope cannot read account data.
- A selected scope cannot be expanded by omitting `--account`, passing multiple IDs, or constructing positionals.
- Deleting an account invalidates its Agent lifecycle generation, so old context and old confirmation cannot be reused.
- The scope constraint applies at every level, including `full-access`.

## Visible confirmation

At the `send-confirmed` level, write operations (draft create/update/delete, move, flag, send, reply) each raise a visible, one-time, immutable confirmation in the Nami Mail desktop app. The confirmation contains a summary, field preview, accounts, a content SHA-256 digest, expiry, and single-use constraint; it must be completed by the user in the desktop UI.

An external CLI at the `send-confirmed` level may initiate write operations, but every one must wait for the desktop confirmation before it executes; if no visible confirmation can be obtained, the request returns `CONFIRMATION_REQUIRED`. `--yes` is not an authorization token: the parser rejects `--yes` for external commands, so confirmation cannot be bypassed at any level. Once `full-access` is enabled, operations execute automatically without per-item confirmation, but scope and audit still apply.

## Transport and audit

- The Windows AgentHost acquires an exclusive named-pipe lease limited to the current user SID before opening a Runtime or database.
- Client requests and host responses are both Ed25519-signed. A request binds the current `bootId` and strictly increasing durable counter to prevent replay.
- The Broker, CLI, and MCP never accept a renderer Fastify token and never allow HTTP, TCP, SQLite, or filesystem fallback paths.
- Audit records retain `requestId`, entry point, tool, account scope, permission decision, result, and restricted summaries. They do not retain mail bodies, attachment content, OAuth tokens, API keys, mail passwords, or private keys.

Mail and attachments are always untrusted external data. They may become bounded context but never system instructions or tool authorization.
