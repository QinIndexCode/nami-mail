# Mail Assistant Usage Guide (NamiMail Agent)

[简体中文](usage.zh-CN.md) | [Model configuration](providers.en.md) | [Architecture](architecture.en.md)

NamiMail Agent is the built-in mail AI workspace: local retrieval, source citations, and draft management within an explicit account scope. Before using it, [configure at least one usable model](providers.en.md).

## Conversations

- **New conversation**: create one from the workspace header; a new conversation prefers the default model.
- **Search / rename / delete**: the conversation list supports search; rename and delete both require a second confirmation.
- When no model is configured or the model service is unavailable, the conversation and your input are preserved with a recoverable next step; a provider timeout is never shown as completion.

## Mail Scope

Choose a scope before asking. The scope defines which mail the assistant may retrieve and which tools it may call:

| Scope | Meaning |
| --- | --- |
| All accounts | Analyzes mail across all accounts; suitable for cross-account summaries |
| Current account | Only the account of the currently selected message (a message must be selected) |
| Current message | Only the currently selected single message (a message must be selected) |

Mail outside the scope is never retrieved or sent; content sent to cloud models is always bounded by the selected scope.

## Asking and Generation

- Type a question and send; click **Stop** while generating.
- You can **attach files** as conversation context; removing an attachment takes it out of the context.
- Local models never send mail content to the cloud; before cloud consent, a cloud model only receives text you actively type, and after consent it still only receives content within the selected scope.
- Sending mail and high-risk operations always require your confirmation.

## Source Citations

When the assistant cites mail, the reply shows a **Source mail** panel that can be expanded to view the cited message, subject, and sender. Retrieval uses the locally encrypted RAG index and covers only mail within the conversation scope.

## Drafts and High-Risk Operations

- The assistant can create and edit drafts within scope; sending always reuses the existing mail service's idempotent submission semantics.
- Write operations (send, delete, etc.) show a **Confirmation required** dialog before execution: you can **Approve** or **Reject**; confirmations expire, and an expired confirmation does not execute the operation.
- After a rejection or expiry, the reply clearly shows "This operation was not executed."

## Recovery

- When no model is configured, mail content is not authorized, or a provider health check fails, the UI preserves the conversation with a recoverable hint.
- If streaming is interrupted, retry; "Assistant temporarily unavailable" means the local service is unreachable, so confirm the app is still running.

## Related Documentation

- [Model provider configuration](providers.en.md): interface types, API keys, and cloud mail-content consent.
- [Connecting external MCP servers](mcp-servers.en.md): extending the assistant with external tools.
- [Conversations and context](conversations.en.md), [Permissions](permissions.en.md), and [Security](security.en.md): context construction and execution boundaries.
