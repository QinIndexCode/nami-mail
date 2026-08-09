# MCP Tools

[Chinese](tools.zh-CN.md) | [Output schema](output-schema.en.md) | [Security](security.en.md)

> **Current-build status: available.** The 0.3.0 build ships the MCP server with a working `tools/list`. The fifteen tool names and schema semantics below are live (eight read-only plus seven write); `tools/list` is still the authoritative source for descriptions, input schemas, and availability.

## Discovery first

An MCP client must call `tools/list` first and treat its returned `description`, `inputSchema`, and availability as authoritative. A host can omit a tool because of version, account scope, or Provider privacy settings. If it is not listed, a client must not call it or guess parameters.

Released read tools have execution mode `read`, require no confirmation, and every one carries `annotations.readOnlyHint`. The seven write tools do not carry `readOnlyHint`; `namimail_draft_delete` carries `destructiveHint`. Their confirmation policy depends on the access level, as described in the Write tools section below. No tool rebuilds an index or invokes an unconsented external service.

| Tool | Description | Input-schema semantic fields | Success `data` | Required scope |
| --- | --- | --- | --- | --- |
| `namimail_accounts_list` | Lists accounts visible to the paired caller. | None. | `{ accounts, truncated }`. Bounded to 100 accounts. | `read:accounts` |
| `namimail_folders_list` | Lists folders in one account. | `accountId` (required). | `{ folders, truncated }`. Bounded to 500 folders. | `read:folders` |
| `namimail_messages_list` | Lists message metadata inside caller account scope. | `mailbox`, `unread`, `flagged`, `sender`, `after`, `before`, `limit`, `cursor`. | `{ messages, nextCursor?, truncated }`. Bounded to 50 messages. | `read:messages` |
| `namimail_mail_summarize` | Fetches a compact digest (subject, sender, date, bounded excerpt) of recent matching mail, suitable for the model to summarize. | `mailbox`, `unread`, `sender`, `after`, `before`, `limit`. | `{ messages }`. Bounded to 10 messages with 2000-character excerpts. | `read:messages` |
| `namimail_message_get` | Reads one authorized message's plain-text content. | `messageId` (required). | `{ message }`. Body bounded to 8000 characters with `bodyTruncated`. | `read:messages` |
| `namimail_messages_batch_get` | Reads up to 10 authorized messages' full plain-text content in one call. | `messageIds` (required, 1..10). | `{ messages, notFound }`. Each message body bounded to 8000 characters with `bodyTruncated`; `notFound` lists requested ids that could not be located. | `read:messages` |
| `namimail_threads_get` | Reads one authorized thread's plain-text content. | `threadId` (required). | `{ threadId, messages, truncated }`. Bounded to 25 messages. | `read:messages` |
| `namimail_attachments_list` | Lists attachment metadata for one message. | `messageId` (required). | `{ messageId, attachments, truncated }`. Bounded to 100 attachments. | `read:attachments` |

Field names, requiredness, enums, and limits are defined by the live `tools/list` JSON Schema. Tool input accepts only a JSON object. IDs are opaque values and must never be constructed from paths, SQL, mail passwords, URLs, or command fragments.

`after` and `before` accept ISO 8601 timestamps with offsets (for example `2026-07-01T10:00:00+08:00`). They are compared as real instants, not as text; the server returns `TOOL_INPUT_INVALID` when `before` precedes `after`.

## Write tools

The seven write tools are available only at `send-confirmed` and above (see [Security](security.en.md)); calling them at `read-only` returns `PERMISSION_DENIED`. Confirmation policy: at `send-confirmed`, every write operation requires a one-time immutable confirmation raised in the Nami Mail desktop app (the tool returns a confirmation flow; the client cannot approve on its own); at `full-access`, write tools execute automatically (send, delete, and all others) without per-operation confirmation. `--yes`, MCP arguments, or a model tool call never serve as confirmation or elevation.

| Tool | Description | Input-schema semantic fields | Success `data` | Required scope | Confirmation policy |
| --- | --- | --- | --- | --- | --- |
| `namimail_draft_create` | Creates a draft for one account inside the paired caller's scope; does not send. | `accountId`, `to[]`, `cc?`, `subject`, `text`, `attachmentTokens?`. | `{ draft: { id, accountId, subject, recipients, updatedAt } }`. | `write:drafts` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |
| `namimail_draft_update` | Replaces the recipients, subject, or body of one draft; does not send. | `draftId`, `accountId`, `to[]`, `cc?`, `subject`, `text`, `attachmentTokens?`. | `{ draft: { id, accountId, subject, recipients, updatedAt } }`. | `write:drafts` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |
| `namimail_draft_delete` | Deletes one draft inside the paired caller's scope. | `accountId`, `draftId`. | `{ accountId, draftId, deleted: true }`. | `write:drafts` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |
| `namimail_messages_move` | Moves one message to the archive or trash. | `messageId`, `target` (`"archive"` or `"trash"`). | `{ messageId, target }`. | `write:mail` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |
| `namimail_messages_set_flag` | Sets the seen or flagged state of one message. | `messageId`, `flag` (`"seen"` or `"flagged"`), `value` (boolean). | `{ messageId, flag, value }`. | `write:mail` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |
| `namimail_messages_send` | Composes and sends one message through the account's SMTP provider; the message is sent exactly once, and retries reuse the same durable submission. | `accountId`, `to[]`, `cc?`, `subject`, `text`, `attachmentTokens?`. | `{ submissionId, deliveryStatus }`. | `write:mail` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |
| `namimail_mail_reply` | Creates a reply draft for one original message; does not send. Recipients default to the original sender; the subject defaults to `Re: <original subject>`. | `accountId`, `messageId`, `to?`, `cc?`, `subject?`, `text`, `attachmentTokens?`. | `{ draft: { id, accountId, subject, recipients, updatedAt } }`. | `write:mail` + `read:messages` | Desktop confirmation at `send-confirmed`; automatic at `full-access`. |

`to[]` / `cc[]` elements are `{ address, name? }`; `attachmentTokens` are opaque `out_...` tokens of user-uploaded files, up to 10. Field names, requiredness, enums, and limits are defined by the live `tools/list` JSON Schema.

## Uniform output

Every tool's NamiMail structured result uses the success/failure envelope in [Output schema](output-schema.en.md). A caller checks `success` before reading `data`. Tools never disguise an error as an empty array or object. A `truncated` result never masquerades as a complete list.

## Unavailable and failure

| Situation | Stable result |
| --- | --- |
| Tool is absent from `tools/list` or unsupported by host | `NOT_SUPPORTED` or `TOOL_NOT_FOUND` |
| Input does not match current schema | `TOOL_INPUT_INVALID` or `INVALID_ARGUMENT` |
| A write tool is called at `read-only` access level | `PERMISSION_DENIED` |
| Caller lacks scope/account authority | `PERMISSION_DENIED` or `SCOPE_DENIED` |
| A write operation requires a visible desktop confirmation (`send-confirmed`) | `CONFIRMATION_REQUIRED` |
| Adapter, host, or Broker interruption | `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, or a transport error |

Never bypass these results through another tool, direct CLI access, HTTP, or a local database read.
