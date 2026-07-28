# MCP Security And Permissions

[Chinese](security.md) | [CLI permissions](../cli/permissions.en.md)

> **Future contract, not executable today.** The current build has no MCP stdio adapter, Broker, pairing record, or external AgentHost. The trust-boundary, signature, and permission rules below apply only after a verified native Windows SID-DACL adapter ships; the current build rejects external entry and does not degrade.

## Trust boundary

```text
MCP client private key -> stdio adapter -> paired Broker -> SID-DACL named pipe -> AgentHost -> Tool Registry / Permission Engine
```

Only a released `AgentHost` may open the mail database and hold the unwrapped master key. An MCP adapter must not inherit the GUI Fastify token or trust a client-supplied account ID, scope, caller type, or confirmation decision.

## Pairing and replay protection

- Every client uses its own Ed25519 key pair; its private key remains in client secure storage.
- A pairing record binds client public key, host ID, host public key, approved scopes, creation time, and a durable decimal counter.
- A request signature covers domain, protocol version, request ID, `hostId`, current `bootId`, client ID, counter, and JSON payload.
- After signature verification, Broker advances the counter in one atomic durable transaction. Duplicate, stale, or out-of-order work returns `BROKER_REPLAY_DETECTED` or `BROKER_COUNTER_INVALID`.
- A response carries a signed host-identity proof. The client must verify request ID, counter, host public key, host ID, and current boot ID.

## Permission model

A released external MCP caller will be fixed at `read-only`. The Broker constructs, rather than accepts from the client, entry point `mcp`, client identity, scopes, account scope, interaction capability, and request ID. Permission Engine defaults to deny:

| Operation type | MCP v1 |
| --- | --- |
| Read account, folder, message, attachment metadata, or RAG query | Available only with the matching `read:*` scope and account scope. |
| Draft, move, mark, archive, delete, rebuild | Denied. |
| Send, reply, forward, bulk write, upload mail content, external network | Denied. Only visible GUI can create a one-time immutable confirmation. |
| `--yes`, MCP arguments, or a model tool call | Never serves as confirmation or elevation. |

## Privacy, prompt injection, and logging

- Mail HTML, bodies, subjects, attachments, and external links are untrusted data. They can be bounded context but cannot become system instructions, tool authorization, or pairing instructions.
- Cloud Provider egress is off by default. MCP cannot enable consent for a user or bypass the user's Provider, model, or context settings.
- Audit retains `requestId`, client, entry point, tool, account scope, permission decision, result, and restricted summaries. It does not retain bodies, attachment content, OAuth tokens, API keys, passwords, or private keys.
- Diagnostics use standard error only. Protocol stdout carries no banner, debug log, or mail content.
- Experimental local translation is not triggered automatically by MCP and cannot bypass Provider consent.

## Updates and lifecycle

After the interface ships, an update drain gate rejects new Broker work, waits for active calls, closes Runtime, and then releases the exclusive lease. It never uses a TTL to reopen automatically. An MCP client handles `UPDATE_IN_PROGRESS`, reconnects after the update, and discovers tools again.
