# MCP Status and Troubleshooting

[Chinese](troubleshooting.zh-CN.md) | [Security](security.en.md)

> **Current-build status: available.** The 0.3.0 installer ships the `namimail` command, PATH shim, MCP stdio child process, Broker, service mode, and pairing UI. The error codes below are recovery signals for a live MCP client. External service mode still fails closed with `BROKER_SECURITY_UNAVAILABLE` before opening GUI, SQLite, a master key, or a translation model.

## What to do today

Install Nami Mail, keep an Agent host running (open Nami Mail or run `namimail service start`), run `namimail pair` and approve it in the visible window, then paste the stdio configuration from [Configuration](configuration.en.md) into the MCP client. If another document presents unsupported commands as startable, report that documentation issue.

## Error contract

| Code | Meaning | Action |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | The Agent host is not running or its exclusive lease is unavailable. | Open NamiMail or use the supported service-start path; do not create a second Runtime. |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | The client is unapproved or revoked. | Complete or repeat pairing only in visible NamiMail UI. |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | Signature, identity, or counter state is invalid. | Stop the connection, repair secure storage, or pair again with user approval; do not add URL/TCP fallback. |
| `UNSUPPORTED_PROTOCOL` / `VERSION_MISMATCH` | Adapter and host protocol are incompatible. | Update to the same NamiMail installation version, restart the client, and discover tools again. |
| `TOOL_NOT_FOUND` / `SCOPE_DENIED` / `PERMISSION_DENIED` | The tool, account, or read scope was not approved. | Treat `tools/list` as authoritative and use only allowed scope; do not guess tools or arguments. |
| `BROKER_SECURITY_UNAVAILABLE` / `CLI_RUNTIME_FORBIDDEN` | The required secured IPC is not available. | Reinstall or update Nami Mail; do not substitute HTTP or direct database access. |

Support reports may contain only MCP-client version, NamiMail version, Windows version, error `code`, `requestId`, and non-sensitive reproduction steps. They must not send raw JSON sessions, mail, attachments, tokens, private keys, pairing records, databases, or pipe information.
