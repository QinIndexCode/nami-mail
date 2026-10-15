# Local Mail API Contract

[简体中文](LOCAL-API.zh-CN.md) | [English](LOCAL-API.en.md)

This page records the protected protocol between the Nami Mail desktop UI and its local Fastify service. It is not a public API for third-party applications, browser extensions, or network clients, and it does not replace the independent paired External Mail v1 CLI, MCP, or Agent Broker interface.

## Access Boundary

- The Windows desktop build runs the service only on a system-assigned `127.0.0.1` port. The address and port are not stable integration endpoints and must not be saved or guessed.
- Apart from `GET /api/health`, one-time OAuth callbacks, and CORS preflight, every `/api/*` request requires the per-launch `x-nami-api-token`.
- Electron's main process injects that token only after it verifies the current local main window. It is never written to a URL, user-data directory, log, or ordinary configuration. Third-party programs, CLI, MCP, and browser extensions cannot reuse it.
- Development mode can run the same service without a desktop token, but it must remain loopback-only. Do not broaden its listener, CORS origins, or publish this contract as a remote HTTP service.

See [Architecture and Trust Boundaries](ARCHITECTURE.en.md) for process and data boundaries. External callers use the [External Mail interface](EXTERNAL-MAIL-INTERFACE.en.md) and its CLI/MCP documentation; they never reuse this local HTTP token.

## Translation Capability

Translation processes the plain-text body of the selected message only after the reader explicitly requests it. Subjects, addresses, attachments, HTML, and the raw message never reach a translation service through these endpoints. The three runtime paths (built-in free translation, LibreTranslate-compatible services, LLM translation) are described in [Message Translation](TRANSLATION.en.md).

### `GET /api/translation/status`

Returns the runtime's capability without exposing the service URL, API key, or message content. Possible response shapes:

Runtimes that do not manage translation configuration (e.g. without managed configuration, `enabled` reflects whether the underlying service is configured and can be `true` or `false`):

```json
{
  "enabled": true
}
```

With managed configuration and no external service configured, the built-in free translator (Google Translate + MyMemory fallback) is always available:

```json
{
  "enabled": true,
  "mode": "builtin"
}
```

With an external service configured, the response reports the enabled state and, on configuration errors, a stable `configurationError` category:

```json
{
  "enabled": false,
  "configurationError": "configuration_invalid_endpoint"
}
```

### `GET /api/translation/configuration` and `PUT /api/translation/configuration`

Fetches or updates translation configuration (including `primary`, `backup`, `endpoint`, and whether an API key is set). Runtimes without managed configuration return `409` (`translation_configuration_managed`); invalid payloads on `PUT` return `400` (`translation_configuration_invalid`).

### `POST /api/messages/:id/translate`

Request body:

```json
{
  "targetLocale": "zh-CN"
}
```

Bodies exceeding the global ceiling of 50,000 characters (`MAX_TRANSLATION_TEXT_LENGTH`) are rejected with `413` (`translation_request_too_large`).

For bodies within the 5,000-character single-chunk limit the response is a single JSON result:

```json
{
  "ok": true,
  "targetLocale": "zh-CN",
  "translatedText": "Translated message body"
}
```

An external LibreTranslate-compatible runtime can additionally return `detectedLanguage` in nested object form. For bodies between 5,000 and 50,000 characters the text is split into multiple chunks and the response becomes a `text/event-stream` SSE event stream: results are pushed as chunk events, and callers must consume the event stream rather than parsing JSON.

### `POST /api/translate-segments`

Performs batch translation of fragmented UI text pieces (e.g. meeting invite excerpts), accepting `{ "segments": string[], "targetLocale": string }`.

### `POST /api/messages/:id/translate-llm`

Dedicated streaming translation endpoint for LLMs, streaming Markdown/text via SSE to the reader interface. Gated strictly by user model configuration and cloud mail-content consent, and bounded by the 50,000-character ceiling (`413` on overflow). See [Message Translation](TRANSLATION.en.md) for data boundaries, the three translation paths, and recovery guidance.

## Compatibility and Evolution

- Consumers must branch on HTTP status and stable `code`; never parse Chinese or English error text.
- When `mode` and `local` are absent, consumers must handle the runtime as an existing external-translation configuration; `mode: "builtin"` means no external service is configured and the built-in translator is always available.
- This page describes only the protected local protocol used by the GUI. External Mail v1 has its own Broker, pairing, account-snapshot, and permission contract. Changes to an external CLI, MCP, IPC, or network interface must retain an independent threat model, permission design, and end-to-end validation.
