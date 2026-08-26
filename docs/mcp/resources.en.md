# MCP Resources

[Chinese](resources.zh-CN.md) | [Tools](tools.en.md) | [Security](security.en.md)

> **Current-build status: enforced.** The 0.3.0 build ships the MCP server and Broker with discoverable tools. The Resources boundary below is live: v1 exposes no callable mail Resources.

NamiMail MCP v1 publishes no `namimail://accounts`, `namimail://messages/...`, or other mail-data MCP Resources.

This is an intentional security boundary. Resource URIs are easy for clients to prefetch, cache, place in context, or reread without a bound account scope. Mail bodies, attachments, and threads return only through read tools that validate caller scope, account scope, Broker audit, and the current Tool Schema.

## Use tools instead

| Need | Tool |
| --- | --- |
| Enumerate accounts | `namimail_accounts_list` |
| Inspect folders | `namimail_folders_list` |
| Read a message or thread | `namimail_message_get`, `namimail_threads_get` |
| List message metadata | `namimail_messages_list` |
| List attachment metadata | `namimail_attachments_list` |

A client must not persist tool output as a pseudo-Resource, share it across users, or continue to use it after pairing revocation, account-scope change, account deletion, or an application update. Discover tools again for each new session and call a constrained tool only when data is needed.

Any future Resource must provide caller/account scope checks, non-guessable URIs, minimum content exposure, expiry/invalidation semantics, audit, deletion synchronization, and explicit cache constraints. Resources remain empty until those conditions hold.
