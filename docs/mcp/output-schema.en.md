# MCP Output Schema

[Chinese](output-schema.md) | [Tools](tools.en.md)

> **Future contract, not executable today.** The current build has no MCP stdio server, Broker, or `tools/list`. The envelope below defines structured results only after a verified native Windows SID-DACL adapter ships; it cannot be obtained by a current client.

After the interface ships, the MCP outer message will follow the MCP protocol negotiated by the client and stdio server. NamiMail will preserve the same stable Agent success/failure semantics in a tool result. Clients supporting structured content should treat this object as the programmatic interface:

```json
{
  "protocolVersion": "1.0",
  "requestId": "123e4567-e89b-12d3-a456-426614174004",
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "contractVersion": 1,
    "durationMs": 18
  }
}
```

| Field | Type | Rule |
| --- | --- | --- |
| `protocolVersion` | String | Agent wire protocol, currently `1.0`. |
| `requestId` | UUID | NamiMail audit and support correlation ID. |
| `success` | Boolean | When `true`, `error` is `null`; when `false`, `data` is `null`. |
| `data` | JSON or `null` | Defined by the matching tool output schema in `tools/list`. |
| `error` | Object or `null` | Stable Agent error. |
| `meta.contractVersion` | Integer | Currently `1`. |
| `meta.durationMs` | Non-negative integer | Host execution duration. |

Error object:

```json
{
  "code": "SCOPE_DENIED",
  "message": "The requested account is outside the caller account scope.",
  "retryable": false,
  "suggestion": "Choose an account approved during pairing."
}
```

`code` will be the machine decision field; `message` and optional `suggestion` may be localized. Optional `details` are not a stable application protocol and clients must neither require nor log them.

## MCP outer mapping

- A successful tool call is a normal MCP tool result. Its `structuredContent`, when the client supports it, contains the envelope above.
- A failed tool call retains the same error envelope and is marked as a tool error by MCP. Clients still read `error.code`, not only natural-language content.
- For clients without structured content, text content is a readable representation of the same envelope, not a second parseable schema.
- Streaming text, tool progress, citations, and completion events belong to future negotiated MCP extensions. A v1 client must not treat stdio lines as a guessed NamiMail event stream.
