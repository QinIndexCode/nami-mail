# Message Body Translation

[English](TRANSLATION.en.md) | [简体中文](TRANSLATION.zh-CN.md)

Message translation in Nami Mail is opt-in. It runs only when you explicitly click "Translate" while reading a message — collecting, syncing, opening mail, switching the interface language, or background refreshes never translate or send message content.

## Three translation paths

### Built-in free translation (default, no configuration)

With no translation service configured, Nami Mail uses a built-in free chain: the plain-text body is sent to the Google Translate public endpoint (`translate.googleapis.com`), with automatic fallback to MyMemory (`api.mymemory.translated.net`), using a 15-second timeout per request. Long bodies are chunked and stitched automatically.

**Note: this path sends the message body to those third-party public endpoints.** The built-in chain auto-detects the source language and surfaces the detected language on the result; the language label reflects the target interface language. Accuracy caveats still apply. Translations live only in the current reader view — closing the reader, refreshing, or restarting the app requires translating again.

### LibreTranslate-compatible service (optional)

In "Settings > Translation service" you can configure a service that speaks the LibreTranslate `POST /translate` protocol, with an optional API key and timeout; saving takes effect immediately. Saving requires a valid service URL; to stop using the local configuration choose "Remove translation service" and confirm. That deletes the service URL and API key stored on this device; if the startup environment provides a configuration, removal falls back to it. To remove only a saved API key, choose "Remove saved key" separately; that action asks for confirmation again and does not save the service URL or timeout being edited. The API key is never shown again and is stored encrypted like local mail data. On Windows the database master key is protected by Electron's DPAPI.

The startup process environment or a `.env` file in the repository root (development) can still provide initial/deployment configuration:

```dotenv
NAMI_MAIL_TRANSLATION_ENDPOINT=https://translate.example.com/translate
# Only when your provider requires it
NAMI_MAIL_TRANSLATION_API_KEY=
# 1000-60000; default 25000
NAMI_MAIL_TRANSLATION_TIMEOUT_MS=25000
```

- `NAMI_MAIL_TRANSLATION_ENDPOINT` must be a full `/translate` URL without query parameters, fragments, usernames, or passwords. Only HTTPS is allowed, or loopback HTTP, e.g. `http://127.0.0.1:5000/translate`, `http://localhost:5000/translate`.
- `NAMI_MAIL_TRANSLATION_API_KEY` is optional and is only sent as the `api_key` field when your service requires it. Never commit it to the repository, logs, or screenshots.
- `NAMI_MAIL_TRANSLATION_TIMEOUT_MS` is 1000 to 60000 ms; when unset it defaults to 25000 ms. Environment configuration is read at startup; a local configuration saved in Settings later takes priority and applies immediately.

Windows runtimes using an external service can also read the endpoint and timeout from `%APPDATA%\Nami Mail\nami-mail.env` as startup configuration. That file cannot hold an API key; save the key in "Settings > Translation service" or provide it through a managed startup environment. Never commit the API key to the repository, logs, or screenshots.

The service should accept a JSON request like the one below and return JSON with at least a `translatedText` string:

```json
{
  "q": "plain text body of the message",
  "source": "auto",
  "target": "en",
  "format": "text"
}
```

The target language is derived from the current interface language, e.g. `zh-CN` becomes `zh`. When the provider requires an API key, handle the `api_key` field per its LibreTranslate-compatible protocol. External services may additionally return a nested language detection result per the LibreTranslate specification (e.g. `{"detectedLanguage": {"language": "en", "confidence": 98}}`; the runtime inspects `detectedLanguage.language`, and a flat top-level string is ignored).

### LLM translation (fallback path, requires a configured model)

After configuring and verifying a model under "Agent model providers", the reader's translation panel can translate the current message through a large language model: pick a configured provider and model, and the body is sent to that model endpoint with results streamed back. This path:

- follows the Agent cloud authorization gate — unavailable unless "allow sending selected message content to cloud models" is enabled;
- rejects bodies over 50,000 characters with `413`;
- incurs provider-side costs; the UI shows a cost and scope notice before the call.

LLM translation is an alternative when the regular paths fail or are unavailable — it is not the default.

## Data and control

All three paths send the **plain-text body of the current message** to the target you chose: the built-in chain sends it to the Google Translate / MyMemory public endpoints; the LibreTranslate-compatible path sends it to your configured service endpoint; the LLM path sends it to your configured model provider. Beyond that, subjects, account addresses, attachments, attachment content, and the local database are never uploaded automatically by translation.

Within a translation request, the runtime supports automatic fallback and chained engine attempts (the built-in engine automatically falls back from Google to MyMemory on failure, and configured engines proceed sequentially through primary → backup → built-in chain until all fail); translation results are not persisted in the local database, files, or a separate cache. Service configuration is stored encrypted on the device. Demo mode never contacts a translation endpoint and shows a local deterministic preview.

Before sending a body to a third-party translation service or model provider, review its privacy policy, data-processing location, and compliance requirements. Mail can contain sensitive information; even over HTTPS, Nami Mail cannot replace your own security assessment of the provider. If you do not want the body to leave the machine, do not use translation.

## Results and troubleshooting

Machine translation can mistranslate terminology, dates, negation, names, code snippets, or formatting. Use it as reading aid only — never as the sole basis for legal, financial, medical, safety, or business decisions; verify important content against the original.

All translation paths (built-in free, LibreTranslate, and LLM) share a global body limit of 50,000 characters (`MAX_TRANSLATION_TEXT_LENGTH`), rejecting oversized requests with `413` (`translation_request_too_large`). Within the 50,000-character ceiling, the built-in and LibreTranslate paths split longer text into semantic 5,000-character chunks and stream partial progress via SSE. With a LibreTranslate-compatible service, a missing endpoint also reports a configuration error; connection problems distinguish TLS certificate verification failures, TLS negotiation failures, unresolvable DNS, unreachable networks, refused connections, dropped connections, and timeouts. On TLS certificate errors, do not disable verification — check system time, proxies, and the server certificate.

When an external translation service returns 401/403/407, check the API key, access rights, or proxy authentication; 429 means rate limiting; 5xx means the service is temporarily unavailable. Nami Mail never shows the service's response body in the UI. Check that the endpoint ends with `/translate`, your network/proxy policy, the service API key, and the timeout, then retry manually.
