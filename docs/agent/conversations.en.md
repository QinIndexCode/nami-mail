# Agent Conversations

[Chinese](conversations.md) | [English](conversations.en.md)

## Data model

Conversation metadata and scope live in `agent_conversations` and `agent_conversation_scopes`; messages, tool records, and required context records live in account/generation-encrypted `agent_conversation_records`. Records are append-only, and database triggers prohibit updating or deleting written records.

A conversation manages local context only. It does not mutate original mail, drafts, or the send queue. Deleting a conversation is logical deletion; it neither clears mail nor replaces an account-deletion key fence.

## Scope and context

When a conversation is created, a user chooses one or more account scopes. Every record binds account ID and current generation, and reads recheck lifecycle availability. Cross-account summaries use only accounts explicitly chosen by the user; citations retain that scope.

Context construction is minimized: favor user-selected messages, authorized RAG pages, and structured metadata, then trim by provider capability and budget. Mail text remains external data. It cannot ask Runtime to ignore safety rules, call tools, or send more content externally.

## Lifecycle

1. Create a conversation and freeze its initial scope.
2. Append user messages, Assistant stream events, tool results, citations, and confirmation state.
3. Cancellation stops the current request and does not delete prior persisted records.
4. Mark/delete hides a conversation from normal lists while preserving necessary audit linkage.
5. Once account deletion advances generation and discards its DEK, old conversation records become undecryptable and cannot be shown again by a restore feature.

The current source includes embedded GUI conversation routes, stream events, and confirmation cards as well as independently testable conversation, confirmation, and audit stores. They are not a delivery claim: the same build still needs integration tests, packaged-desktop smoke, real Provider/account paths, and deletion/rebuild boundary validation.

## UX requirements

- Streamed answers, citations, and errors are selectable and copyable.
- A citation can open its source mail without changing read state unless the user performs an existing explicit mail action.
- Stop, retry, delete, and confirmation show their actual state; a provider timeout is never shown as completion.
- Missing provider, missing egress consent, or an unready index preserves input and conversation with a clear next step.

## Retention and cleanup

Audit or pending operations are not silently truncated to save space. Physical cleanup is an explicit maintenance operation and must prove it does not break non-deleted account conversation, confirmation, or audit linkage. Once an account DEK is removed, ciphertext is not recoverable; do not restore an old DEK from backup to “fix” a conversation.

See [RAG deletion sync](../rag/deletion-sync.en.md) and [Security](security.en.md).
