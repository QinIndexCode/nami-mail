# CLI Permissions And Security

[Chinese](permissions.md) | [MCP security](../mcp/security.en.md)

> **Future contract, not executable today.** The current build has no external CLI, Broker, pairing record, or client permission grant. The default-deny, scope, and audit requirements below apply to external interfaces only after a verified native Windows SID-DACL adapter ships; the current build fails closed before that entry point.

## Default deny

The future v1 external CLI access level will be `read-only`. For every request, the Broker will create caller context that command-line arguments cannot forge: client identity, `cli` entry point, approved scopes, account scope, interaction capability, and request ID. Tool Registry and Permission Engine will validate those fields again before mail services are reached.

| Access level | Permitted tool modes | CLI v1 status |
| --- | --- | --- |
| `read-only` | `read` | The only external mode after release. |
| `draft-only` | `read`, `draft` | Reserved for desktop UI. |
| `mail-write` | Read, draft, ordinary write | Reserved for desktop UI. |
| `send-confirmed` | Including high-risk work | Reserved for desktop UI and still needs confirmation. |
| `full-access` | Administrative work | Not granted to external v1 CLI. |

Common scopes are `read:accounts`, `read:folders`, `read:messages`, `read:attachments`, and `read:rag`. Higher scopes such as `write:drafts`, `write:mail`, `send:mail`, `manage:rag`, `external:network`, or `admin:host` do not grant write capability to an external v1 CLI.

## Account scope

A future pairing record may permit all accounts, selected accounts, or no accounts. Every request account ID must belong to that scope:

- A caller with no account scope cannot read account data.
- A selected scope cannot be expanded by omitting `--account`, passing multiple IDs, or constructing positionals.
- Deleting an account invalidates its Agent lifecycle generation, so old context and old confirmation cannot be reused.

## Visible confirmation

Sending, replying, forwarding, permanent deletion, bulk move/state/label changes, uploading mail content, and external network calls require a visible NamiMail window to create a one-time immutable confirmation. The confirmation contains a summary, field preview, accounts, a content SHA-256 digest, expiry, and single-use constraint.

An external CLI cannot request, approve, reuse, or forge that confirmation. `--yes` is only an option, not an authorization token.

## Transport and audit

- A released Windows AgentHost must acquire an exclusive named-pipe lease limited to the current user SID before opening a Runtime or database.
- Released client requests and host responses must both be Ed25519-signed. A request binds the current `bootId` and strictly increasing durable counter to prevent replay.
- The released Broker, CLI, and MCP must never accept a renderer Fastify token or allow HTTP, TCP, SQLite, or filesystem fallback paths.
- Audit records retain `requestId`, entry point, tool, account scope, permission decision, result, and restricted summaries. They do not retain mail bodies, attachment content, OAuth tokens, API keys, mail passwords, or private keys.

Mail and attachments are always untrusted external data. They may become bounded context but never system instructions or tool authorization.
