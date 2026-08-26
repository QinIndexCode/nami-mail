# MCP Protocol Examples

[Chinese](examples.zh-CN.md) | [Configuration](configuration.en.md) | [Tools](tools.en.md)

> **Current-build status: sendable.** The 0.3.0 installer ships the MCP stdio process, `namimail` command, Broker, pairing UI, and a callable `tools/list`. The JSON below runs against a paired, running Agent host.

## Tool discovery

An MCP client completes standard initialization before sending a logical request like this:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Runtime names, descriptions, `inputSchema`, and availability take precedence over this document. A client must not infer an unlisted tool from this document, a cache, or CLI options.

## Read-only calls

At the default read-only level, a paired client may call the eight read-only tools: `namimail_accounts_list`, `namimail_folders_list`, `namimail_messages_list`, `namimail_mail_summarize`, `namimail_message_get`, `namimail_messages_batch_get`, `namimail_threads_get`, and `namimail_attachments_list`. After raising "External MCP permission" to "Confirm each action" or "Full automatic" in the Permissions section of desktop settings, `tools/list` also lists seven write tools (draft create/update/delete, move, set-flag, send, reply): the confirm-each-action level pops a Nami Mail desktop confirmation for every write, while full automatic runs them directly. Every request is validated by account scope, scopes, tool schema, and Broker audit. Account IDs, query text, and limits are illustrative data only and cannot expand authority.

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"namimail_folders_list","arguments":{"accountId":"account_1"}}}
```

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"namimail_messages_list","arguments":{"mailbox":"INBOX","after":"2026-07-01T00:00:00Z","limit":20}}}
```

Callers must decide outcome from `structuredContent.success` and retain `requestId`. A tool result never reports success for a denied or failed call; read `error.code` when it fails.

## Failure and write boundary

A client uses bounded backoff only for retryable errors; it cannot use `HOST_UNAVAILABLE` to auto-start service, bypass pairing, or fall back to HTTP. Write tools such as `namimail_messages_send` require the `send-confirmed` or `full-access` level and are never available at `read-only`. Drafting, review, sending, and high-risk actions remain available only in visible NamiMail UI.
