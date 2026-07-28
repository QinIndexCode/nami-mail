# MCP Tools

[Chinese](tools.md) | [Output schema](output-schema.en.md) | [Security](security.en.md)

> **Future contract, not executable today.** The current build has no MCP server, `tools/list`, Broker, or external AgentHost. The tool names and schema semantics below apply only after a verified native Windows SID-DACL adapter ships; clients must not try to call or guess them.

## Discovery first

These are the future fixed v1 read-only tool names. After the interface ships, an MCP client must call `tools/list` first and treat its returned `description`, `inputSchema`, and availability as authoritative. A host can omit a tool because of version, account scope, index state, or Provider privacy settings. If it is not listed, a client must not call it or guess parameters.

Every released tool will have execution mode `read`, confirmation policy `never`, and external availability `true`. None can send mail, create or edit drafts, change message state, move/delete mail, rebuild an index, or invoke an unconsented external service.

| Tool | Description | Input-schema semantic fields | Success `data` | Required scope | Security note |
| --- | --- | --- | --- | --- | --- |
| `namimail_accounts_list` | Lists accounts visible to the caller. | No account selector or a host-allowed scope filter. | Scope-filtered account-summary array. | `read:accounts` | Never returns credentials, OAuth tokens, or mail passwords. |
| `namimail_folders_list` | Lists folders in an account. | Optional account selector. | Folder-summary array. | `read:folders` | Broker still enforces account scope. |
| `namimail_messages_list` | Lists message metadata. | Account, folder, time, limit, and related filters. | Bounded message-summary array. | `read:messages` | A list is not a full body or an authority expansion. |
| `namimail_message_get` | Reads one authorized message. | Message identifier and optional account selector. | Message object permitted by the host. | `read:messages` | Mail HTML/body is untrusted external data. |
| `namimail_messages_search` | Retrieves mail by structured criteria. | Query, account, folder, time, and limit. | Matching message-summary array. | `read:messages` | A query cannot change account scope. |
| `namimail_threads_get` | Reads an authorized mail thread. | Thread identifier and optional account selector. | Thread and permitted message summaries. | `read:messages` | A thread reference never elevates cross-account access. |
| `namimail_attachments_list` | Lists attachment metadata for mail. | Message identifier and optional account selector. | Attachment-metadata array. | `read:attachments` | v1 does not write arbitrary file paths or raw attachments into a client. |
| `namimail_rag_search` | Searches a ready index within caller scope. | Query, account, and limit. | Matches and traceable citations. | `read:rag` | Deleted, out-of-scope, or unready content must be filtered. |
| `namimail_rag_status` | Returns index readiness. | Optional account selector. | Index state within account scope. | `read:rag` | Does not reveal other accounts' queues or error details. |
| `namimail_rag_verify` | Verifies index consistency within visible scope. | Optional account selector. | Bounded consistency report. | `read:rag` | Verification only; it never rebuilds or writes. |

Field names, requiredness, enums, and limits are defined by the live `tools/list` JSON Schema. Tool input accepts only a JSON object. IDs are opaque values and must never be constructed from paths, SQL, mail passwords, URLs, or command fragments.

## Uniform output

Every tool's NamiMail structured result uses the success/failure envelope in [Output schema](output-schema.en.md). A caller checks `success` before reading `data`. Tools never disguise an error as an empty array or object.

When available, `namimail_rag_search` citations identify at least source type, account, message, subject, and internal target. Optional fields include thread, chunk, sender, sent time, mailbox, excerpt, confidence, and source revision. A citation is evidence pointer, not model authorization, and must not be rewritten into facts about mail that was not retrieved.

## Unavailable and failure

| Situation | Stable result |
| --- | --- |
| Tool is absent from `tools/list` or unsupported by host | `NOT_SUPPORTED` or `TOOL_NOT_FOUND` |
| Input does not match current schema | `TOOL_INPUT_INVALID` or `INVALID_ARGUMENT` |
| Caller lacks scope/account authority | `PERMISSION_DENIED` or `SCOPE_DENIED` |
| Index is incomplete or inaccessible | `RAG_NOT_READY` or `RAG_UNAVAILABLE` |
| Adapter, host, or Broker interruption | `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, or a transport error |

Never bypass these results through another tool, direct CLI access, HTTP, or a local database read.
