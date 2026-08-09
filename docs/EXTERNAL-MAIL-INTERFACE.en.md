# External Mail Interface

[Simplified Chinese](EXTERNAL-MAIL-INTERFACE.zh-CN.md) | [Documentation](README.en.md) | [CLI](cli/README.en.md) | [MCP](mcp/README.en.md)

External Mail v1 is Nami Mail's local, paired interface for the Windows desktop app (read-only by default; it can be elevated in the desktop settings). It is for local scripts and MCP clients. It is not a web API and does not replace the desktop app.

## Get Started

1. Install and open Nami Mail, or explicitly run `namimail service start` to start the local AgentHost.
2. Start a pairing request from the CLI or MCP client and review and approve that client in the visible Nami Mail window. First approval snapshots the approved account-ID list; each client profile has its own identity and grant.
3. Use the paired profile for the v1 tools below. Ordinary reads never start a host implicitly; MCP stdio neither creates a pairing nor starts the service.
4. For an unused or suspected-compromised client, or to expand its account range, run `namimail revoke --profile <name>`, then run `namimail pair --profile <name>` and approve it in the desktop window. Revocation blocks later requests immediately; a newly added account never enters an old profile automatically.

Do not copy the database, discovery file, pipe name, pairing state, or local API token into client configuration, environment variables, logs, or issues. Nami Mail does not accept any of these as substitute credentials.

## V1 Tool Surface

These fifteen tools (eight read-only plus seven write) are the complete External Mail v1 surface. Input objects use strict schemas and reject unknown fields. The account-ID snapshot from first pairing determines scope, and request values can never expand it. An account added later is not accessible by the old profile until it is revoked and paired again.

| Tool | CLI | MCP | Strict input | Scope |
| --- | --- | --- | --- | --- |
| `accounts.list` | `accounts list` | `namimail_accounts_list` | `{}` | `read:accounts` |
| `folders.list` | `folders list --account <accountId>` | `namimail_folders_list` | `{ "accountId": "..." }` | `read:folders` |
| `messages.list` | `messages list` | `namimail_messages_list` | Optional `mailbox`, `unread`, `flagged`, `sender`, `after`, `before`, `limit`, `cursor` | `read:messages` |
| `mail.summarize` | `mail summarize` | `namimail_mail_summarize` | Optional `mailbox`, `unread`, `sender`, `after`, `before`, `limit` | `read:messages` |
| `messages.get` | `messages get --message <messageId>` | `namimail_message_get` | `{ "messageId": "..." }` | `read:messages` |
| `messages.batch_get` | `messages batch-get --message <id1,id2,...>` | `namimail_messages_batch_get` | `{ "messageIds": ["...", ...] }` (1..10) | `read:messages` |
| `threads.get` | `threads get --thread <threadId>` | `namimail_threads_get` | `{ "threadId": "..." }` | `read:messages` |
| `attachments.list` | `attachments list --message <messageId>` | `namimail_attachments_list` | `{ "messageId": "..." }` | `read:attachments` |
| `mail.draft.create` | `draft create` | `namimail_draft_create` | `{ "accountId": "...", "to": [{ "address": "...", "name"? }], "cc"?, "subject": "...", "text": "...", "attachmentTokens"? }` | `write:drafts` |
| `mail.draft.update` | `draft update` | `namimail_draft_update` | `{ "draftId": "...", "accountId": "...", "to": [{ "address": "...", "name"? }], "cc"?, "subject": "...", "text": "...", "attachmentTokens"? }` | `write:drafts` |
| `mail.draft.delete` | `draft delete` | `namimail_draft_delete` | `{ "accountId": "...", "draftId": "..." }` | `write:drafts` |
| `messages.move` | `messages move` | `namimail_messages_move` | `{ "messageId": "...", "target": "archive" \| "trash" }` | `write:mail` |
| `messages.set-flag` | `messages set-flag` | `namimail_messages_set_flag` | `{ "messageId": "...", "flag": "seen" \| "flagged", "value": true \| false }` | `write:mail` |
| `messages.send` | `messages send` | `namimail_messages_send` | `{ "accountId": "...", "to": [{ "address": "...", "name"? }], "cc"?, "subject": "...", "text": "...", "attachmentTokens"? }` | `write:mail` |
| `mail.reply` | `mail reply` | `namimail_mail_reply` | `{ "accountId": "...", "messageId": "...", "to"?, "cc"?, "subject"?, "text": "...", "attachmentTokens"? }` | `write:mail` + `read:messages` |

`after` and `before` must be ISO 8601 timestamps with offsets, and `before` must not precede `after`; `limit` is `1..50`. The host bounds message and thread bodies. The attachment operation returns metadata only and never exports a file.

## Write Operations and Permission Levels

The external CLI and external MCP each configure their access level independently in the "Permissions" group of the desktop settings (`agentCliAccessLevel` and `agentMcpAccessLevel`, both `read-only` by default), using the same levels as the built-in Agent: `read-only` / `send-confirmed` / `full-access`.

- `read-only`: all seven write tools are unavailable and return `PERMISSION_DENIED`; the eight read-only tools are available at every level and never require confirmation.
- `send-confirmed`: every write (draft create/update/delete, move, set-flag, send, reply) pops a visible, one-time, immutable confirmation in the Nami Mail desktop app before it runs.
- `full-access`: the user must read an explicit warning in the UI and confirm before enabling; after that, all operations (including sending and deletion) run automatically within the approved account scope without per-action confirmation. Scope and audit still apply.

Permission decisions live in the host: the host constructs the external caller's access level and clamps it to the configured level, and a paired client cannot raise its own; a request beyond the configured level returns `PERMISSION_DENIED`. CLI `--yes`, MCP arguments, or model tool calls can neither confirm nor elevate.

## Versioned Success Data

Every successful response `data` is strictly validated by the shared v1 schema and cannot contain unknown fields. CLI JSON and MCP `structureContent.data` use the same shapes:

| Tool | `data` shape | Principal fields |
| --- | --- | --- |
| `accounts.list` | `{ "accounts": [...] }` | Each entry has `id`, `email`, `provider`, `displayName`, `status`, and `lastSyncedAt`. |
| `folders.list` | `{ "folders": [...] }` | Each entry has `accountId`, `path`, `name`, `specialUse`, `total`, and `unseen`. |
| `messages.list` | `{ "messages": [...], "nextCursor"?, "truncated": boolean }` | Metadata has `id`, `accountId`, `mailbox`, `threadId`, `subject`, `from`, `sentAt`, `snippet`, `flags`, and `hasAttachments`. |
| `mail.summarize` | `{ "messages": [...], "truncated": boolean }` | Each entry has `messageId`, `threadId`, `mailbox`, `subject`, `from`, `sentAt`, and a bounded `excerpt`. |
| `messages.get` | `{ "message": { ... } }` | Message detail adds `to`, `cc`, plain-text `text`, and `bodyTruncated` to metadata. |
| `messages.batch_get` | `{ "messages": [...], "notFound": [...] }` | `messages` contains the bounded message detail above (1..10); `notFound` lists requested ids that could not be located. |
| `threads.get` | `{ "threadId": "...", "messages": [...], "truncated": boolean }` | `messages` contains the bounded message detail above. |
| `attachments.list` | `{ "messageId": "...", "attachments": [...], "truncated": boolean }` | Each entry has `partId`, `filename`, `contentType`, `size`, and `disposition`. |

Public data never includes `htmlBody`, raw attachments, credentials, database paths, file paths, or redaction objects. Current v1 limits are 100 accounts, 500 folders, 50 listed messages, 10 messages per batch_get call, 100 attachments, 25 messages per thread, an 8,000-character body, and a 1,500-character snippet. When `truncated` or `bodyTruncated` is `true`, treat the data as a bounded result, never as a complete mailbox copy.

`messages.search`, every `rag.*` operation, attachment export, `agent.chat`, and `agent.run` are outside External Mail v1. They are unaffected by permission levels and stay unavailable at every level; they do not appear in MCP `tools/list` and cannot be bypassed through CLI flags, HTTP, TCP, file URIs, SQLite, or the local Fastify token.

## Trust Boundary

- The Broker uses a named pipe restricted to the current Windows user SID. CLI and MCP reach the running host only through that pipe.
- Each client has an independent protected identity, host-identity binding, signature, and monotonic counter. Replays, identity mismatches, and revoked pairings are rejected.
- The Broker constructs caller identity, scopes, and account scope from the pairing record. It does not trust CLI or MCP permissions, account scope, database paths, or tokens.
- The local Fastify service serves only the desktop renderer. Its dynamic loopback port and `x-nami-api-token` are not third-party credentials. See the [Local Mail API contract](LOCAL-API.en.md).
- During an update, the Broker stops accepting new work and waits for accepted work to finish. Handle `UPDATE_IN_PROGRESS` and make a new request after recovery; never replay a signed frame.
- Any paired client may call `host.shutdown` at any permission level. It is a Broker-internal control command, not an External Mail v1 tool: it replies `{ "status": "stopping" }` and asks the host to stop, never passes through the external tool allow-list or the mail bridge, and grants no mail access by itself.

## Results and Recovery

A successful response has `success: true` and `error: null`; a failure has `success: false` and `data: null`. Automation must branch on stable error codes, not user-facing message text.

| Error | Recovery |
| --- | --- |
| `HOST_UNAVAILABLE` | Open Nami Mail or explicitly run `namimail service start`, then make a new request. |
| `UPDATE_IN_PROGRESS` | Wait for update completion or recovery, then call again; do not replay a signed request. |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | Complete or repeat pairing in the visible Nami Mail window. |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` | Stop calling, inspect local client secure storage, and revoke/re-pair when necessary; never downgrade to HTTP. |
| `SCOPE_DENIED` / `PERMISSION_DENIED` | The target account is outside scope, or the caller's level/scopes are insufficient or exceed the configured level; adjust the permission settings, or perform the action in the desktop app. |
| `TOOL_INPUT_INVALID` / `NOT_SUPPORTED` | Follow this page and the MCP `tools/list` schema; `NOT_SUPPORTED` means the tool is not available to external callers. Remove unsupported fields or operations. |

Errors, audit data, and support reports must not contain mail bodies, attachments, OAuth tokens, passwords, private keys, database paths, or the local API token.

## Translation Boundary

Experimental local NLLB-200 translation is separate from External Mail v1. It is prepared and triggered explicitly in the desktop reader; an unready model does not implicitly download or send message content. It is not a CLI/MCP tool and pairing does not enable it. See [message translation](TRANSLATION.en.md).
