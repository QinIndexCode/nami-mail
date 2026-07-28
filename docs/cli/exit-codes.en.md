# CLI Exit Codes

[Chinese](exit-codes.md) | [Output schema](output-schema.en.md)

> **Future contract, not executable today.** The current build installs no `namimail` CLI or external Broker, so it does not provide these exit codes to a terminal. They define the stable interface after a verified Windows SID-DACL adapter ships; current service mode fails closed before startup.

After the interface ships, exit codes will support shell control flow; `error.code` in structured JSON will be the precise classifier. Even for a non-zero exit, callers should parse the JSON envelope before deciding whether to retry.

| Exit | Meaning | Typical error codes | Action |
| --- | --- | --- | --- |
| `0` | Success | None | Use `data`. |
| `1` | Uncategorized Agent, Broker, Provider, or tool error | `BROKER_SECURITY_UNAVAILABLE`, `READ_ONLY`, `RAG_NOT_READY`, `PROVIDER_*`, `TOOL_*` | Read JSON `error.code`; never infer the cause from `1` alone. |
| `2` | Invalid command or parameter | `INVALID_ARGUMENT` | Correct the command, option, or Tool Schema input. |
| `3` | Host or exclusive lease unavailable | `HOST_UNAVAILABLE`, `HOST_LEASE_UNAVAILABLE` | In the future interface, open NamiMail or explicitly start the service. Do not start a second Runtime. |
| `4` | Pairing, signature, or replay protection failure | `PAIRING_REQUIRED`, `PAIRING_REVOKED`, `BROKER_AUTHENTICATION_FAILED`, `BROKER_REPLAY_DETECTED` | In the future interface, pair again, revoke an invalid client, or repair the client counter. Do not replay a request. |
| `5` | Update drain in progress | `UPDATE_IN_PROGRESS` | Wait for install or recovery to finish, then retry. |
| `6` | Permission or Runtime-boundary violation | `PERMISSION_DENIED`, `CLI_RUNTIME_FORBIDDEN` | Use the visible GUI for writes. Do not substitute direct database access. |

Future error codes may continue to map to `1` to preserve existing shell compatibility. Automation must retain both the exit code and `requestId`, then branch on the stable `error.code`.
