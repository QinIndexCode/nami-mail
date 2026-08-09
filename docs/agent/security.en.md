# Agent Security

[Chinese](security.zh-CN.md) | [English](security.en.md)

> **Current-build status: enforced.** The 0.3.0 build ships the `namimail` CLI, MCP stdio adapter, Broker, pairing records, and the external AgentHost path behind a paired current-user SID-DACL named pipe. The security boundaries below are enforced by the shipped build; violating external entry points fail closed rather than degrading. Experimental local NLLB translation remains separate, explicit, and opt-in.

## Threat model

Mail bodies, HTML, attachment names, citations, provider output, CLI arguments, and MCP JSON are untrusted input. They can attempt prompt injection, unauthorized reads, path traversal, parameter pollution, log disclosure, or send inducement. Security decisions come only from verified host code, scope, and durable confirmation records.

## Local trust boundary

- Production SQLite and the DPAPI-unwrapped master key may exist only in a released Electron `AgentHost`.
- CLI/MCP use a paired current-user SID-DACL named pipe; Broker binds host/boot identity, monotonic counters, signed proof, and replay checks.
- When a secure pipe adapter is absent, service is refused. A default Node named pipe, loopback HTTP, or browser token is not an equivalent substitute.
- Single-instance ownership and update drain prevent a second host or stale process from sharing database/key ownership.

## Data protection

Each account has an independent data-encryption key (DEK), whose wrapper is protected by the master key. RAG pages, conversations, confirmations, provider configuration, and sensitive source locators use versioned/AAD-bound envelopes. Account deletion advances generation and discards the old DEK before cancelling old tasks, making old Agent ciphertext unreadable.

Encryption does not replace access control: reads still require caller scope, account generation, and permission. Logs and errors must not disclose bodies, attachments, complete address books, OAuth credentials, API keys, or passwords.

## Model and egress

The model is untrusted and owns no tool permission. Runtime labels mail as data, limits tool descriptors, argument size, timeout, and call count, and validates every model tool call. Cloud mail-content egress is off by default and needs visible, explicit, revocable consent for the target provider. Local NLLB translation is not part of this provider path.

## Human confirmation

High-risk actions use immutable content digests and one-time tokens. Confirmation UI must be a visible foreground app window that shows target, scope, and summary; headless processes, CLI, MCP, and models cannot simulate approval. SMTP outcome remains determined by the existing outbox and Sent-folder reconciliation.

## Security incident handling

1. On `BROKER_SECURITY_UNAVAILABLE`, failed signature verification, replay, or scope denial, stop the request and do not seek protocol downgrade.
2. On suspected credential exposure, revoke/replace the provider or OAuth credential and invalidate related pairings; never paste keys into issues or logs.
3. On database or migration failure, stop the host, preserve an evidence copy, and recover under the migration plan; do not manually delete `agent_*` tables as a fix.
4. Treat suspicious mail text as security evidence, never as a command to execute.

See [RAG troubleshooting](../rag/troubleshooting.en.md) and the [release checklist](../development/release-checklist.en.md).
