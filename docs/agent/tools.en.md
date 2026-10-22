# Agent Tools

[Chinese](tools.zh-CN.md) | [English](tools.en.md)

## One registry

Tools register with lower-case dotted identifiers and versioned descriptors. A descriptor declares category, execution mode, required scopes, account access, external availability, timeout, and confirmation policy. A provider only proposes a tool call; only the host Tool Registry and Permission Engine can resolve and execute it.

| Mode | Typical use | External CLI/MCP v1 | Confirmation |
| --- | --- | --- | --- |
| `read` | Accounts, folders, messages, threads, attachment metadata, RAG queries | Allowed only inside paired scope | None |
| `draft` | Create, update, or delete drafts, reply drafts | Allowed at `send-confirmed` and above (one of the seven write tools) | Operations with `required` policy require visible confirmation until `full-access` |
| `write` | Mark, move, archive, update memory or settings | Allowed at `send-confirmed` and above | Operations with `required` policy require visible confirmation until `full-access` (safe writes like `memory.*` are exempt) |
| `high-risk` | Send, forward, permanent delete, bulk writes, content egress | Only `messages.send` is external | Durable audit and one-time GUI confirmation required |

External CLI/MCP v1 exposes 16 tools: nine read-only plus seven bounded writes (draft create/update/delete, move, flag, send, reply draft). The default `read-only` level keeps only reads available; elevating the level enables the write tools. `--yes`, MCP arguments, a paired identity, or model output never relaxes the access level or replace confirmation.

## Built-in Domain Toolsets

The host comes with a complete suite of built-in domain tools spanning mail, calendar, contacts, long-term memory, auto-reply auditing, and system utilities. All tool inputs and outputs are validated with strict Zod schemas and enforced by the permission engine and one-time confirmation lifecycle.

### 1. Mail Tools (`mail.*` / `messages.*` / `accounts.*` / `folders.*` / `threads.*` / `attachments.*`)

Mail tools connect to the existing `MailApplicationService` facade, reusing remote sync, outbox submission, and reconciliation pipelines without opening duplicate SQLite/SMTP paths.

| Tool Identifier | Mode | Required Scopes | External CLI/MCP | Confirmation Policy | Description |
| --- | --- | --- | --- | --- | --- |
| `accounts.list` | `read` | `read:accounts` | Allowed | None | Lists configured mail accounts and sync states visible to the caller. |
| `accounts.delete` | `high-risk` | `write:accounts` | Internal only | One-time GUI confirmation (`delete-account`, irreversible, confirmed even under `full-access`) | Removes a mail account and purges its local cache. |
| `folders.list` | `read` | `read:folders` | Allowed | None | Lists mail folders for a specified account. |
| `messages.list` | `read` | `read:messages` | Allowed | None | Paginated listing of message metadata (filters: sender, unread, flagged, etc.). |
| `messages.get` | `read` | `read:messages` | Allowed | None | Fetches message details and body text (bounded truncation). |
| `messages.batch_get` | `read` | `read:messages` | Allowed | None | Batch reads plain text bodies for up to 10 authorized messages. |
| `messages.search` | `read` | `read:messages` | Allowed | None | Full-text search with bounded excerpt snippets around query keywords. |
| `mail.summarize` | `read` | `read:messages` | Allowed | None | Compact summaries of recent matching messages suited for LLM synthesis. |
| `threads.get` | `read` | `read:messages` | Allowed | None | Reads message conversations within an authorized thread. |
| `attachments.list` | `read` | `read:attachments` | Allowed | None | Lists attachment metadata for an authorized message. |
| `mail.draft.create` | `draft` | `write:drafts` | Allowed | One-time GUI confirmation (`create-draft`) | Creates a new draft without sending. |
| `mail.draft.update` | `draft` | `write:drafts` | Allowed | One-time GUI confirmation (`update-draft`) | Updates recipients, subject, or body of an existing draft. |
| `mail.draft.delete` | `draft` | `write:drafts` | Allowed | One-time GUI confirmation (`delete-draft`) | Deletes an authorized draft. |
| `messages.move` | `write` | `write:messages` | Allowed | One-time GUI confirmation (`move-mail`) | Moves messages to Archive, Trash, or a destination folder. |
| `messages.set-flag` | `write` | `write:messages` | Allowed | One-time GUI confirmation (`set-flag`) | Updates read (`seen`) or flagged status. |
| `messages.send` | `high-risk` | `write:messages` | Allowed | One-time GUI confirmation (`send-mail`) | Composes and sends a new message through the account's SMTP provider. |
| `mail.reply` | `draft` | `write:messages` | Allowed | One-time GUI confirmation (`reply-mail`) | Creates a reply draft to an existing message (does not send). |

### 2. Calendar Tools (`calendar.*`)

Calendar tools manage and inspect local schedule events. All event data is stored encrypted on-device via AES-256-GCM and never synced to external calendar services.

| Tool Identifier | Mode | Required Scopes | External CLI/MCP | Confirmation Policy | Description |
| --- | --- | --- | --- | --- | --- |
| `calendar.list` | `read` | `read:calendar` | Internal only | None | Lists calendar events overlapping the optional `after`/`before` range. |
| `calendar.create` | `write` | `write:calendar` | Internal only | One-time GUI confirmation (`create-calendar-event`) | Creates a local calendar event (title, time, location, all-day flag, etc.). |
| `calendar.update` | `write` | `write:calendar` | Internal only | One-time GUI confirmation (`update-calendar-event`) | Updates event timing, title, or details by event ID. |
| `calendar.delete` | `write` | `write:calendar` | Internal only | One-time GUI confirmation (`delete-calendar-event`) | Deletes an existing local calendar event by ID. |

### 3. Contact Tools (`contacts.*`)

Address book tools search and curate local contacts. Data is encrypted on disk with the master key.

| Tool Identifier | Mode | Required Scopes | External CLI/MCP | Confirmation Policy | Description |
| --- | --- | --- | --- | --- | --- |
| `contacts.search` | `read` | `read:contacts` | Internal only | None | Searches address book contacts matching a name or email substring. |
| `contacts.create` | `write` | `write:contacts` | Internal only | One-time GUI confirmation (`create-contact`) | Adds a new contact to the local address book. |
| `contacts.update` | `write` | `write:contacts` | Internal only | One-time GUI confirmation (`update-contact`) | Updates contact details (name, email, notes). |
| `contacts.delete` | `write` | `write:contacts` | Internal only | One-time GUI confirmation (`delete-contact`) | Removes a contact from the address book. |

### 4. Memory Tools (`memory.*`)

Long-term memory tools allow the Agent to store cross-conversation user facts, preferences, and recurring context. Records are device-local and encrypted and support query, create, update, and delete; **an update overwrites the previous value (no history is kept), and a delete removes the record outright (there is no trash)**. Memory shares its store with the auto-reply ledger, and `memory.update` does not filter by kind, so ledger entries can be rewritten too (see [known limitations](../development/known-limitations.en.md) item 6).

| Tool Identifier | Mode | Required Scopes | External CLI/MCP | Confirmation Policy | Description |
| --- | --- | --- | --- | --- | --- |
| `memory.list` | `read` | `manage:memory` | Internal only | None | Lists stored memory items with optional query filter. |
| `memory.save` | `write` | `manage:memory` | Internal only | None | Stores a concise, durable fact or preference note across sessions. |
| `memory.update` | `write` | `manage:memory` | Internal only | None | Updates or merges existing memory records to prevent stale duplicates. |
| `memory.delete` | `write` | `manage:memory` | Internal only | None | Purges a stored memory note by ID. |

### 5. Auto-Reply Audit Tools (`auto-reply.*`)

| Tool Identifier | Mode | Required Scopes | External CLI/MCP | Confirmation Policy | Description |
| --- | --- | --- | --- | --- | --- |
| `auto-reply.declined.search` | `read` | `audit:auto-reply` | Internal only | None | Searches audit records of declined auto-replies and reasons (offline rule screening, model evaluation). |

### 6. System & Utility Tools (`time.*` / `web.*` / `settings.*`)

| Tool Identifier | Mode | Required Scopes | External CLI/MCP | Confirmation Policy | Description |
| --- | --- | --- | --- | --- | --- |
| `time.now` | `read` | `time:read` | Allowed | None | Returns the exact local wall-clock time, ISO string, and UTC offset. |
| `web.search` | `read` | `web:search` | Internal only | None | Queries public DuckDuckGo search results; never includes private email text. |
| `settings.update` | `write` | `manage:settings` | Internal only | None | Updates appearance (theme, background preset, density) and notification preferences. |

### 7. Dynamic MCP Tool Extensions

When third-party MCP servers are configured in desktop settings, the host `AgentMcpServerManager` dynamically connects, queries tool capabilities, and registers them in the agent runtime under independent credential and authorization policies.

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
