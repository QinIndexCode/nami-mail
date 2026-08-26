# CLI Status and Troubleshooting

[Chinese](troubleshooting.zh-CN.md) | [Exit codes](exit-codes.en.md)

> **Current-build status: available.** The 0.3.0 installer ships the `namimail` command, PATH shim, external Broker, service mode, and pairing UI. The error codes below are recovery signals for a live CLI client. Service mode still fails closed with `BROKER_SECURITY_UNAVAILABLE` before opening GUI, SQLite, a master key, or a translation model.

## What to do today

Install Nami Mail, run `namimail pair` and approve the request in the visible window, keep the Agent host running (open Nami Mail or run `namimail service start`), then use the documented read-only commands. If another document, installer, or client configuration presents unsupported commands as runnable, do not execute them and report that documentation issue to the maintainer.

## Error contract

| Code | Meaning | Action |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | The Agent host is not running or its exclusive lease is unavailable. | Open NamiMail or run `namimail service start`; do not start a second Runtime. |
| `UPDATE_IN_PROGRESS` | Update drain has closed new Broker requests. | Wait for update completion or recovery, then retry the same read-only request. |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | The client is unapproved or has been revoked. | Complete or repeat pairing only in visible NamiMail UI. |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | Signature, identity, or counter state is invalid. | Stop replaying; repair client secure storage or pair again with user approval; never degrade to HTTP. |
| `SCOPE_DENIED` / `PERMISSION_DENIED` | The request exceeds account scope or the external write boundary. | Use an allowed read scope or complete the action in visible NamiMail UI. |
| `BROKER_SECURITY_UNAVAILABLE` / `CLI_RUNTIME_FORBIDDEN` | The required secured IPC is not available. | Reinstall or update Nami Mail; do not substitute HTTP or direct database access. |

Support reports must contain only `requestId`, error code, CLI version, Windows version, and non-sensitive reproduction steps. They must not attach mail, attachments, tokens, private keys, pairing records, databases, or pipe details.
