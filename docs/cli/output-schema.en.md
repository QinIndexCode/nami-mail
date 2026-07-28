# CLI Output Schema

[Chinese](output-schema.md) | [Exit codes](exit-codes.en.md)

> **Future contract, not executable today.** The current build has no external CLI, Broker, or JSON command output. The envelope below defines the machine interface after a verified native Windows SID-DACL adapter ships; it is not a callable response.

After the interface ships, `--output json` will be the scripting interface. Each invocation will write one stable envelope to standard output, for both success and failure:

```json
{
  "protocolVersion": "1.0",
  "requestId": "123e4567-e89b-12d3-a456-426614174004",
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "durationMs": 18,
    "version": "0.2.3"
  }
}
```

| Field | Type | Rule |
| --- | --- | --- |
| `protocolVersion` | String | The current Agent protocol is `1.0`. Incompatible versions must negotiate explicitly or fail. |
| `requestId` | UUID | Unique per call; use it for support, audit, and retry correlation. |
| `success` | Boolean | When `true`, `error` is `null`; when `false`, `data` is `null`. |
| `data` | JSON or `null` | Defined by the concrete host Tool Schema on success. |
| `error` | Object or `null` | Stable error structure on failure. |
| `meta.durationMs` | Non-negative integer | Total duration visible to the CLI. |
| `meta.version` | String | NamiMail application version, not protocol version. |

## Error structure

```json
{
  "code": "HOST_UNAVAILABLE",
  "message": "NamiMail Agent host is not available.",
  "retryable": true,
  "suggestion": "The external Agent interface is unavailable in this build."
}
```

`code` will be the programmatic decision field. `message` and optional `suggestion` are user-facing and may be localized. `retryable` only says an immediate retry could be meaningful; it does not guarantee success. Implementations may include an optional `details` object, but callers must not require it or write it to logs.

Common codes include `INVALID_ARGUMENT`, `HOST_UNAVAILABLE`, `UPDATE_IN_PROGRESS`, `PAIRING_REQUIRED`, `PAIRING_REVOKED`, `BROKER_AUTHENTICATION_FAILED`, `BROKER_REPLAY_DETECTED`, `PERMISSION_DENIED`, `SCOPE_DENIED`, `RAG_NOT_READY`, `PROVIDER_UNAVAILABLE`, and `PROVIDER_TIMEOUT`. See [Troubleshooting](troubleshooting.en.md) for recovery guidance.

## Other formats

| Format | Success output | Failure output | Use |
| --- | --- | --- | --- |
| `json` | One compact JSON envelope and newline. | The same JSON envelope. | Scripts and external Agents. |
| `jsonl` | Currently one complete envelope per invocation line. | One failure envelope line. | Line-oriented batch consumers. |
| `table` | Renders columns for an array of objects; renders text for other values. | Standard error. | Human inspection. |
| `text` | Original string or formatted JSON. | Standard error. | Human inspection. |

`jsonl` does not currently promise one line per streaming Agent event. A client needing streaming interaction must use negotiated MCP capability or wait for an explicit event protocol. It must not guess a line format.
