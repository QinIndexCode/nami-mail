# MCP Security And Permissions

[Chinese](security.zh-CN.md) | [CLI permissions](../cli/permissions.en.md)

> **Current-build status: enforced.** The 0.3.0 build ships the MCP stdio adapter, Broker, pairing records, and external AgentHost. The trust-boundary, signature, and permission rules below are live; external entry that violates them fails closed.

## Trust boundary

```text
MCP client private key -> stdio adapter -> paired Broker -> SID-DACL named pipe -> AgentHost -> Tool Registry / Permission Engine
```

Only the `AgentHost` may open the mail database and hold the unwrapped master key. An MCP adapter must not inherit the GUI Fastify token or trust a client-supplied account ID, scope, caller type, or confirmation decision.

## Pairing and replay protection

- Every client uses its own Ed25519 key pair; its private key remains in client secure storage.
- A pairing record binds client public key, host ID, host public key, approved scopes, creation time, and a durable decimal counter.
- A request signature covers domain, protocol version, request ID, `hostId`, current `bootId`, client ID, counter, and JSON payload.
- After signature verification, Broker advances the counter in one atomic durable transaction. Duplicate, stale, or out-of-order work returns `BROKER_REPLAY_DETECTED` or `BROKER_COUNTER_INVALID`.
- A response carries a signed host-identity proof. The client must verify request ID, counter, host public key, host ID, and current boot ID.

## Permission model

The three entry points are configured independently in the "Permissions" group of the desktop app settings, with three adjacent dropdowns; CLI and MCP are two independent settings with identical options:

- Built-in Agent: `agentAccessLevel`, default `send-confirmed`.
- External CLI: `agentCliAccessLevel`, default `read-only`.
- External MCP: `agentMcpAccessLevel` (the "External MCP permissions" dropdown), default `read-only`.

The levels are `read-only` / `send-confirmed` / `full-access`:

- `read-only`: can only read account, folder, message, thread, and attachment metadata.
- `send-confirmed`: every write operation (draft create/update/delete, move, flag, send, reply) raises a visible confirmation in the Nami Mail desktop app.
- `full-access`: the user must read a warning and explicitly accept it in the UI before enabling this level. Once enabled, all operations (including send and delete) run automatically within approved account scope, without per-operation confirmation. Account scope and audit still apply.

The Broker constructs, rather than accepts from the client, entry point `mcp`, client identity, scopes, account scope, interaction capability, and request ID. The host constructs the external caller's access level and clamps it to the configured level: a paired client cannot raise its own level, and a request above the configured level returns `PERMISSION_DENIED`. Interaction capability (`interactive` / `canRequestConfirmation`) is `true` for external callers only at `send-confirmed`. Permission Engine defaults to deny:

| Level | Available operations | Confirmation policy |
| --- | --- | --- |
| `read-only` | The eight read-only tools only (account, folder, message digest, single and batch message read, thread, attachment metadata). | None. |
| `send-confirmed` | Read tools plus the seven write tools (draft create/update/delete, move, flag, send, reply). | Every write operation requires a one-time immutable confirmation raised in the Nami Mail desktop app (the tool returns a confirmation flow; the client cannot approve on its own). |
| `full-access` | Read tools plus the seven write tools. | Write tools execute automatically (send, delete, and all others), without per-operation confirmation. |

`--yes`, MCP arguments, or a model tool call never serve as confirmation or elevation. Current error codes: `PERMISSION_DENIED` (level or scope not satisfied, including requests above the configured level), `SCOPE_DENIED` (account outside scope), `CONFIRMATION_REQUIRED` (a visible desktop confirmation is required), `NOT_SUPPORTED` (tool not available to external callers), `TOOL_INPUT_INVALID` / `INVALID_ARGUMENT` (input mismatch), `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` / `BROKER_SECURITY_UNAVAILABLE`, `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, `PAIRING_REQUIRED` / `PAIRING_REVOKED`. The `READ_ONLY` error code is no longer used.

## Privacy, prompt injection, and logging

- Mail HTML, bodies, subjects, attachments, and external links are untrusted data. They can be bounded context but cannot become system instructions, tool authorization, or pairing instructions.
- Cloud Provider egress is off by default. MCP cannot enable consent for a user or bypass the user's Provider, model, or context settings.
- Audit retains `requestId`, client, entry point, tool, account scope, permission decision, result, and restricted summaries. It does not retain bodies, attachment content, OAuth tokens, API keys, passwords, or private keys.
- Diagnostics use standard error only. Protocol stdout carries no banner, debug log, or mail content.
- Experimental local translation is not triggered automatically by MCP and cannot bypass Provider consent.

## Updates and lifecycle

An update drain gate rejects new Broker work, waits for active calls, closes Runtime, and then releases the exclusive lease. It never uses a TTL to reopen automatically. An MCP client handles `UPDATE_IN_PROGRESS`, reconnects after the update, and discovers tools again.
