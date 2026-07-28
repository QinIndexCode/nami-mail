# Message Translation

[简体中文](TRANSLATION.md) | [English](TRANSLATION.en.md)

Message translation is optional. Nami Mail runs it only after you explicitly select Translate while reading a message. It does not translate or send mail content automatically while receiving or syncing mail, opening a message, changing the interface language, or refreshing in the background.

## Two Runtime Modes

### Windows desktop: experimental local NLLB-200

The current Windows desktop runtime injects a local NLLB-200 translation service instead of sending a message body to a LibreTranslate endpoint. On the first explicit translation, `@huggingface/transformers` prepares the model assets required for `Xenova/nllb-200-distilled-600M`; this can require network access and take time. Model assets are cached in Electron's user-data `translation-models` directory, typically `%APPDATA%\Nami Mail\translation-models`.

After the model is available, the selected message's plain-text body is processed by the local translation engine and is not sent to a translation endpoint. The cache contains model assets only, not message bodies or translation results. Removing the cache means a later first translation must prepare the model again. Translation results remain only in the current reader view; closing it, refreshing, or restarting the app requires another explicit translation request.

This is experimental machine translation. It does not detect the source language, and its reported language identifies the target interface language; the accuracy warning still applies. The desktop runtime manages its translation service, so Settings > Translation service cannot replace it with an external endpoint.

### LibreTranslate-compatible service: a runtime without injected local translation

A command-line development runtime or another runtime that has not injected local NLLB can use a LibreTranslate-compatible `POST /translate` service. Only that kind of runtime allows Settings > Translation service to set a service address, optional API key, and timeout; saved changes take effect immediately. Saving requires a valid service address. To stop using a locally saved configuration, select Remove translation service and confirm the deletion. This removes the service address and API key saved on the device; if startup environment configuration exists, Nami Mail falls back to it. To remove only a saved API key, select Remove saved API key; the action requires confirmation and does not save an address or timeout currently being edited. An API key is never shown again after saving and is encrypted with local mail data. On Windows, the database master key is protected by Electron DPAPI.

The process environment that starts Nami Mail, or the project-root `.env` in development, can still provide initial or deployment configuration:

```dotenv
NAMI_MAIL_TRANSLATION_ENDPOINT=https://translate.example.com/translate
# Set this only when the service requires it.
NAMI_MAIL_TRANSLATION_API_KEY=
# 1000-60000; defaults to 25000.
NAMI_MAIL_TRANSLATION_TIMEOUT_MS=25000
```

- `NAMI_MAIL_TRANSLATION_ENDPOINT` must be a complete `/translate` URL with no query string, fragment, username, or password. It must use HTTPS, or local loopback HTTP such as `http://127.0.0.1:5000/translate` or `http://localhost:5000/translate`.
- `NAMI_MAIL_TRANSLATION_API_KEY` is optional and is sent as the `api_key` field only when your service requires it. Do not commit it or put it in logs or screenshots.
- `NAMI_MAIL_TRANSLATION_TIMEOUT_MS` accepts 1000 through 60000 milliseconds and defaults to 25000. Environment configuration is read at startup; a local configuration subsequently saved in Settings takes precedence and takes effect immediately.

A Windows runtime using the external service can still read an endpoint and timeout from `%APPDATA%\Nami Mail\nami-mail.env` as startup configuration. That file cannot store an API key; use Settings > Translation service to save a key, or provide it from a managed startup environment. The current Windows desktop local-NLLB path does not use that configuration as a translation endpoint. Do not commit an API key or put it in logs or screenshots.

The service must accept a request like this and return JSON containing at least a `translatedText` string:

```json
{
  "q": "The message plain-text body",
  "source": "auto",
  "target": "en",
  "format": "text"
}
```

The target is the base language code of the current interface locale. For example, `zh-CN` becomes `zh`. If the service requires an API key, it must handle the `api_key` field according to the LibreTranslate-compatible protocol.

## Data And Control

When a LibreTranslate-compatible service is used, Nami Mail decrypts the current message's plain-text body locally and sends that body to the configured endpoint only after Translate is selected. The subject, account addresses, attachments, attachment contents, and local database are not automatically uploaded for translation.

External translation does not fall back to another service, and it does not persist or cache translation results in the local database, files, or a separate cache. Service configuration is encrypted on this device. The Windows desktop local-NLLB model cache likewise stores neither translation results nor message bodies. Demo mode contacts no translation endpoint and shows a locally deterministic preview instead.

Before sending a message body to a third-party translation service, review its privacy policy, processing location, and organization compliance requirements. Messages can contain sensitive information. HTTPS does not replace your assessment of the selected provider.

## Results And Errors

Machine translation can misread terminology, dates, negation, names, code samples, or formatting. It is reading assistance, not the sole basis for legal, financial, medical, safety, or business decisions. Check important content against the original message.

When the body is empty or exceeds 50000 characters, Nami Mail keeps the original message and shows a specific error. A LibreTranslate-compatible service also reports a configuration error when no endpoint is configured. For external translation-service connections it distinguishes certificate validation, TLS handshake, DNS resolution, network reachability, connection refusal, connection interruption, and timeout. Do not disable certificate verification when a TLS certificate error occurs; instead check the system time, proxy, and service certificate.

For external service responses, 401/403/407 means that the API key, access permission, or proxy authentication should be checked; 429 means the service is rate limiting; and 5xx means the service is temporarily unavailable. Nami Mail never exposes a translation service response body in the interface. Check that the endpoint ends with `/translate`, then verify network/proxy policy, the service API key, and the timeout before manually retrying.

When initial local-NLLB preparation fails or the local engine is unavailable, Nami Mail reports local translation as unavailable. Check network availability for the first use, free writable space in the user-data directory, and model-cache integrity, then restart and retry manually. Do not disable TLS verification to work around a model-asset download problem.
