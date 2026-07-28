# External Agent Integration Status and Future Contract

[Chinese](agent-integration.md) | [MCP integration](../mcp/README.en.md)

> **Current-build status: external Agents cannot integrate.** This Windows build has no verifiable native SID-DACL named-pipe adapter, Broker, `namimail` executable, PATH shim, pairing UI, or MCP launcher. Do not invoke, wrap, or guess this interface from a script, IDE Agent, or automation task.

## Current restrictions

External Agents may use only other supported entry points explicitly supplied by the user. They must not read, copy, back up, or synchronize NamiMail data directories, SQLite, pairing records, or key material. They must not try `--server`, local HTTP, TCP, file URIs, environment-variable tokens, or guessed named pipes as a substitute path.

Experimental local NLLB-200 translation still requires deliberate UI action. It is not an external Agent channel and never automatically translates mail or sends mail content to a model.

## Future calling contract (non-executable)

Only after the adapter ships may an external Agent invoke reserved CLI commands with a process argument array, after the user has completed an independent pairing and approved read-only account scope. A future call must request a JSON envelope, check `success` first, and handle failure only from `error.code`, `retryable`, and `requestId`; it must not infer mail facts from an exit code, human-readable error, or table output.

Retryable means only that a condition may recover. Future callers may use bounded exponential backoff for `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, `PROVIDER_TIMEOUT`, or `PROVIDER_RATE_LIMITED` while retaining the original `requestId`. `PAIRING_REVOKED`, `BROKER_REPLAY_DETECTED`, `PERMISSION_DENIED`, and `SCOPE_DENIED` are not repaired by retrying.

Even after release, write commands must be rejected for external CLI. `--yes`, a paired identity, or model output cannot bypass user confirmation in visible NamiMail UI.
