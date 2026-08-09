# External Agent Integration Status and Contract

[Chinese](agent-integration.zh-CN.md) | [MCP integration](../mcp/README.en.md)

> **Current-build status: integrated.** The 0.3.0 build ships the Broker, `namimail` executable, PATH shim, pairing UI, and MCP launcher. Scripts, IDE Agents, and automation tasks may invoke the documented interface; it defaults to read-only and can be raised in the Permissions section of desktop settings.

## Current restrictions

External Agents use the documented `namimail` commands. The default level is read-only, and write commands become available only after "External CLI permission" is raised to "Confirm each action" or "Full automatic". They must not read, copy, back up, or synchronize NamiMail data directories, SQLite, pairing records, or key material. They must not try `--server`, local HTTP, TCP, file URIs, environment-variable tokens, or guessed named pipes as a substitute path.

Experimental local NLLB-200 translation still requires deliberate UI action. It is not an external Agent channel and never automatically translates mail or sends mail content to a model.

## Calling contract

An external Agent invokes a documented command with a process argument array after the user has completed an independent pairing and approved an account scope. A call must request a JSON envelope, check `success` first, and handle failure only from `error.code`, `retryable`, and `requestId`; it must not infer mail facts from an exit code, human-readable error, or table output.

Retryable means only that a condition may recover. Callers may use bounded exponential backoff for `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, `PROVIDER_TIMEOUT`, or `PROVIDER_RATE_LIMITED` while retaining the original `requestId`. `PAIRING_REVOKED`, `BROKER_REPLAY_DETECTED`, `PERMISSION_DENIED`, and `SCOPE_DENIED` are not repaired by retrying.

Write commands are rejected for external CLI at the read-only level. Raising "External CLI permission" to "Confirm each action" pops a Nami Mail desktop confirmation for every write; "Full automatic" runs them directly. `--yes`, a paired identity, or model output cannot bypass user confirmation — `--yes` is never accepted on external commands.
