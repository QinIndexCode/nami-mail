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

Translation processes the selected message's plain-text body only after an explicit reader request. These endpoints do not send the subject, addresses, attachments, HTML, or raw message to a translation service.

### `GET /api/translation/status`

Returns runtime availability without returning a service address, API key, model-cache path, or message content.

Example for a LibreTranslate-compatible runtime:

```json
{
  "enabled": true
}
```

Example for the Windows local NLLB runtime:

```json
{
  "enabled": false,
  "mode": "local",
  "local": {
    "mode": "local",
    "state": "unprepared",
    "downloadEstimatedBytes": 900000000,
    "progress": null
  }
}
```

`local.state` is `unprepared`, `preparing`, `ready`, or `failed`. `enabled` is `true` only for `ready`. On a preparation failure, `local.errorCode` provides only a stable recovery category, never a download URL, file path, or underlying error text.

### `POST /api/translation/prepare`

Supported only by the Windows local NLLB runtime. This request contains no message content. It starts loading or downloading the model only after the user has explicitly chosen Prepare local translation in the UI. The request returns `202 Accepted` immediately; poll the status endpoint instead of submitting it repeatedly.

```json
{
  "ok": true,
  "mode": "local",
  "local": {
    "mode": "local",
    "state": "preparing",
    "downloadEstimatedBytes": 900000000,
    "progress": 42
  }
}
```

The response returns `409` with `translation_preparation_unavailable` when the runtime does not use a local model. It returns `503` when local preparation cannot start. Common stable error codes are:

- `translation_model_download_failed`: check the network, VPN/proxy, and firewall.
- `translation_model_cache_unavailable`: check free space and write permission for Nami Mail's data directory.
- `translation_model_unavailable`: prepare again; if it keeps failing, restart Nami Mail and try again.

### `POST /api/messages/:id/translate`

Request body:

```json
{
  "targetLocale": "zh-CN"
}
```

Successful response:

```json
{
  "ok": true,
  "targetLocale": "zh-CN",
  "translatedText": "Translated message body"
}
```

An external LibreTranslate-compatible runtime can additionally return `detectedLanguage`. Local NLLB never presents a language guess as a detection result. See [Message Translation](TRANSLATION.en.md) for data boundaries, first model preparation, and recovery guidance.

Local NLLB accepts this request only when `local.state` is `ready`. When the model is `unprepared`, `preparing`, or `failed`, it returns `409` with `translation_preparation_required` and does not implicitly download or load the model. The caller must first show an explicit preparation action, then poll the status endpoint until the model is ready.

## Compatibility and Evolution

- Consumers must branch on HTTP status and stable `code`; never parse Chinese or English error text.
- When `mode` and `local` are absent, consumers must handle the existing external-translation configuration runtime and must not assume a local model exists.
- This page describes only the protected local protocol used by the GUI. External Mail v1 has its own Broker, pairing, account-snapshot, and permission contract. Changes to an external CLI, MCP, IPC, or network interface must retain an independent threat model, permission design, and end-to-end validation.
