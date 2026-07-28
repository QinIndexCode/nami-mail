# Future MCP Protocol Examples

[Chinese](examples.md) | [Configuration](configuration.en.md) | [Tools](tools.en.md)

> **Current-build status: the requests below cannot be sent.** The current installer has no MCP stdio process, `namimail` command, Broker, pairing UI, or callable `tools/list`. The JSON describes only the protocol shape after a verified native Windows SID-DACL adapter ships and cannot be used in an IDE, SDK, or terminal.

## Future tool discovery

A released MCP client will complete standard initialization before sending a logical request like this:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Future runtime names, descriptions, `inputSchema`, and availability will take precedence over this document. A client must not infer an unlisted tool from this document, a cache, or CLI options.

## Future read-only calls

A released paired client may call read-only tools such as `namimail_accounts_list`, `namimail_messages_search`, and `namimail_rag_search`. Every request will be validated by account scope, scopes, tool schema, and Broker audit. Account IDs, query text, and limits are illustrative data only and cannot expand authority.

Callers must decide outcome from `structuredContent.success` and retain `requestId` and message/thread citations. When the index is not ready, they must handle `RAG_NOT_READY` and never turn an empty result into a claim that no relevant mail exists.

## Future failure and write boundary

A released client will use bounded backoff only for retryable errors; it cannot use `HOST_UNAVAILABLE` to auto-start service, bypass pairing, or fall back to HTTP. Write tools such as `namimail_mail_send` will not be exposed to external MCP. Drafting, review, sending, and high-risk actions remain available only in visible NamiMail UI.
