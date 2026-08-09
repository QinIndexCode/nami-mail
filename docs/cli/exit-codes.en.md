# CLI Exit Codes

[Chinese](exit-codes.zh-CN.md) | [Output schema](output-schema.en.md)

> **Current-build status: implemented.** The 0.3.0 build ships the `namimail` CLI and provides these exit codes to a terminal.

Exit codes support shell control flow; `error.code` in structured JSON is the precise classifier. Even for a non-zero exit, callers should parse the JSON envelope before deciding whether to retry.

| Exit | Meaning | Typical error codes | Action |
| --- | --- | --- | --- |
| `0` | Success | None | Use `data`. |
| `1` | Uncategorized Agent, Broker, Provider, or tool error | `BROKER_SECURITY_UNAVAILABLE`, `PROVIDER_*`, `TOOL_*` | Read JSON `error.code`; never infer the cause from `1` alone. |
| `2` | Invalid command or parameter | `INVALID_ARGUMENT`, `TOOL_INPUT_INVALID` | Correct the command, option, or Tool Schema input. |
| `3` | Host or exclusive lease unavailable | `HOST_UNAVAILABLE`, `HOST_LEASE_UNAVAILABLE` | Open NamiMail or run `namimail service start`. Do not start a second Runtime. |
| `4` | Pairing, signature, or replay protection failure | `PAIRING_REQUIRED`, `PAIRING_REVOKED`, `BROKER_AUTHENTICATION_FAILED`, `BROKER_REPLAY_DETECTED`, `BROKER_COUNTER_INVALID` | Pair again, revoke an invalid client, or repair the client counter. Do not replay a request. |
| `5` | Update drain in progress | `UPDATE_IN_PROGRESS` | Wait for install or recovery to finish, then retry. |
| `6` | Permission or Runtime-boundary violation | `PERMISSION_DENIED`, `SCOPE_DENIED`, `CLI_RUNTIME_FORBIDDEN` | Use the visible GUI for writes or an allowed read scope for data. Do not substitute direct database access. |

Future error codes may continue to map to `1` to preserve existing shell compatibility. Automation must retain both the exit code and `requestId`, then branch on the stable `error.code`.
