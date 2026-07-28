# CLI Status and Future Troubleshooting

[Chinese](troubleshooting.md) | [Exit codes](exit-codes.en.md)

> **Current-build status: an unavailable CLI is expected.** The current installer has no `namimail` command, PATH shim, external Broker, service mode, or pairing UI. Do not try to repair it by copying a shim, running a development server, guessing a pipe, or configuring HTTP. Service mode fails closed with `BROKER_SECURITY_UNAVAILABLE` before opening GUI, SQLite, a master key, or a translation model.

## What to do today

Use the normal Nami Mail desktop UI. If another document, installer, or client configuration presents CLI/MCP as runnable, do not execute its commands and report that documentation issue to the maintainer.

## Future error contract (non-executable)

Only after a verified native Windows SID-DACL adapter ships will the following errors be recovery signals visible to external clients:

| Code | Future meaning | Future action |
| --- | --- | --- |
| `HOST_UNAVAILABLE` / `HOST_LEASE_UNAVAILABLE` | The released host is not running or its exclusive lease is unavailable. | Open NamiMail or use the supported service-start path; do not start a second Runtime. |
| `UPDATE_IN_PROGRESS` | Update drain has closed new Broker requests. | Wait for update completion or recovery, then retry the same read-only request. |
| `PAIRING_REQUIRED` / `PAIRING_REVOKED` | The client is unapproved or has been revoked. | Complete or repeat pairing only in visible NamiMail UI. |
| `BROKER_AUTHENTICATION_FAILED` / `BROKER_REPLAY_DETECTED` / `BROKER_COUNTER_INVALID` | Signature, identity, or counter state is invalid. | Stop replaying; repair client secure storage or pair again with user approval; never degrade to HTTP. |
| `SCOPE_DENIED` / `PERMISSION_DENIED` / `READ_ONLY` | The request exceeds account scope or the external write boundary. | Use an allowed read scope or complete the action in visible NamiMail UI. |
| `RAG_NOT_READY` / `RAG_UNAVAILABLE` | The index is not ready or unavailable. | Wait before retrieving; never turn an empty result into a claim that no mail exists. |

Future support reports must also contain only `requestId`, error code, CLI version, Windows version, and non-sensitive reproduction steps. They must not attach mail, attachments, tokens, private keys, pairing records, databases, or pipe details.
