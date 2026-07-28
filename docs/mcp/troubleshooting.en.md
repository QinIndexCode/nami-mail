# MCP Status and Future Troubleshooting

[Chinese](troubleshooting.md) | [Security](security.en.md)

> **Current-build status: unavailable MCP is expected.** The current installer has no `namimail` command, PATH shim, MCP stdio child process, Broker, service mode, or pairing UI. Do not copy an executable, run a development service, guess a pipe, or configure HTTP to bypass this limit; external service mode fails closed with `BROKER_SECURITY_UNAVAILABLE` before opening GUI, SQLite, a master key, or a translation model.

## What to do today

Use the normal Nami Mail desktop UI. Do not paste any `namimail mcp start`, `service start`, or MCP JSON configuration into a client. If another document presents MCP as startable, report that documentation issue.

## Future error contract (non-executable)

Only after a verified native Windows SID-DACL adapter ships will the following errors be recovery signals for an MCP client:

| Code | Future meaning | Future action |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | The released host is not running or its exclusive lease is unavailable. | Open NamiMail or use the supported service-start path; do not create a second Runtime. |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | The client is unapproved or revoked. | Complete or repeat pairing only in visible NamiMail UI. |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | Signature, identity, or counter state is invalid. | Stop the connection, repair secure storage, or pair again with user approval; do not add URL/TCP fallback. |
| `UNSUPPORTED_PROTOCOL` / `VERSION_MISMATCH` | Adapter and host protocol are incompatible. | Update to the same NamiMail installation version, restart the client, and discover tools again. |
| `TOOL_NOT_FOUND` / `SCOPE_DENIED` / `PERMISSION_DENIED` | The tool, account, or read scope was not approved. | Treat `tools/list` as authoritative and use only allowed scope; do not guess tools or arguments. |
| `RAG_NOT_READY` / `RAG_UNAVAILABLE` | The index is not ready or unavailable. | Wait before retrieving; never turn an empty result into a claim that no relevant mail exists. |

Future support reports may contain only MCP-client version, NamiMail version, Windows version, error `code`, `requestId`, and non-sensitive reproduction steps. They must not send raw JSON sessions, mail, attachments, tokens, private keys, pairing records, databases, or pipe information.
