# Agent Tools

[Chinese](tools.zh-CN.md) | [English](tools.en.md)

## One registry

Tools register with lower-case dotted identifiers and versioned descriptors. A descriptor declares category, execution mode, required scopes, account access, external availability, timeout, and confirmation policy. A provider only proposes a tool call; only the host Tool Registry and Permission Engine can resolve and execute it.

| Mode | Typical use | External CLI/MCP v1 | Confirmation |
| --- | --- | --- | --- |
| `read` | Accounts, folders, messages, threads, attachment metadata, RAG queries | Allowed only inside paired scope | None |
| `draft` | Create, update, or delete drafts | Not allowed | Audited; operation policy applies |
| `write` | Mark, move, or archive | Not allowed | Descriptor and GUI policy decide |
| `high-risk` | Send, forward, permanent delete, bulk writes, content egress | Not allowed | Durable audit and one-time GUI confirmation required |

CLI/MCP v1 exposes read-only tools only. `--yes`, MCP arguments, a paired identity, or model output never relaxes that rule.

## Mail-service boundary

Tools connect to existing mail application services rather than duplicating SQL or SMTP:

- Reads: accounts, folders, messages, threads, attachment metadata, and sync state.
- Drafts: saved through the existing draft model; they cannot claim a send completed.
- The embedded Agent registers move, flag, send, and reply tools (`messages.move`, `messages.set-flag`, `messages.send`, `mail.reply`) that reuse the existing remote-sync, outbox, and reconciliation paths.

`MailApplicationService` is the facade used by the embedded Agent. Its registered tools include reading accounts, folders, messages, threads, and attachment metadata; creating, updating, and deleting drafts; plus move, flag, send, and reply operations.

## Input, output, and citations

Inputs are validated with Zod schemas and must constrain account IDs, message IDs, list page sizes, and cancellation. Results have unified success, denied, failed, unsupported, or cancelled states with stable codes and suggestions.

When a tool reads mail bodies or RAG pages, it returns citations that lead back to an in-app message rather than silently injecting unrestricted mail into a model. Citations identify account, message/page, revision, and a necessary excerpt; UI must permit selection, copy, and opening the source.

## Admission checklist for a new tool

1. Use an existing mail service or explicit read query; do not create parallel SMTP, IMAP, or SQLite access.
2. Define descriptor, input schema, scope resolution, maximum cost, and cancellation behavior.
3. Use the narrowest permission scope; default to `availableToExternal: false`.
4. High-risk work needs immutable preview, content digest, confirmation action, and audit events.
5. Test authorization, scope escape, cancellation, duplicate submission, account deletion, and forged provider calls.

See [Permissions and confirmations](permissions.en.md) and [CLI/MCP documentation](../cli/README.en.md).
