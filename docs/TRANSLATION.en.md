# Message Translation

[简体中文](TRANSLATION.md) | [English](TRANSLATION.en.md)

Message translation is optional. Nami Mail sends content only after you explicitly select Translate while reading a message. It does not send mail content automatically while receiving or syncing mail, opening a message, changing the interface language, or refreshing in the background.

## Configure A Translation Service

Nami Mail uses a LibreTranslate-compatible `POST /translate` service. In the installed Windows desktop app, use Settings > Translation service to enter a service address, optional API key, and timeout; saved changes take effect immediately. Saving requires a valid service address. To stop using a locally saved configuration, select Remove translation service and confirm the deletion. This removes the service address and API key saved on the device; if startup environment configuration exists, Nami Mail falls back to it. To remove only a saved API key, select Remove saved API key; the action requires confirmation and does not save an address or timeout currently being edited. An API key is never shown again after saving and is encrypted with local mail data. On Windows, the database master key is protected by Electron DPAPI.

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

An installed Windows desktop app can still read an endpoint and timeout from `%APPDATA%\Nami Mail\nami-mail.env` as startup configuration. That file cannot store an API key; use Settings > Translation service to save a key, or provide it from a managed startup environment. Do not commit an API key or put it in logs or screenshots.

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

Only after Translate is selected does Nami Mail decrypt the current message's plain-text body locally and send that body to your configured endpoint. The subject, account addresses, attachments, attachment contents, and local database are not automatically uploaded for translation.

Nami Mail does not fall back to another translation service, and it does not persist or cache translation results in the local database, files, or a separate cache. Service configuration is encrypted on this device, while translation results are not cached; closing the reader, refreshing, or restarting the app requires another explicit translation request. Demo mode contacts no translation endpoint and shows a locally deterministic preview instead.

Before sending a message body to a third-party translation service, review its privacy policy, processing location, and organization compliance requirements. Messages can contain sensitive information. HTTPS does not replace your assessment of the selected provider.

## Results And Errors

Machine translation can misread terminology, dates, negation, names, code samples, or formatting. It is reading assistance, not the sole basis for legal, financial, medical, safety, or business decisions. Check important content against the original message.

When no endpoint is configured, or the body is empty or exceeds 50000 characters, Nami Mail keeps the original message and shows a specific error. For translation-service connections it distinguishes certificate validation, TLS handshake, DNS resolution, network reachability, connection refusal, connection interruption, and timeout. Do not disable certificate verification when a TLS certificate error occurs; instead check the system time, proxy, and service certificate.

For service responses, 401/403/407 means that the API key, access permission, or proxy authentication should be checked; 429 means the service is rate limiting; and 5xx means the service is temporarily unavailable. Nami Mail never exposes a translation service response body in the interface. Check that the endpoint ends with `/translate`, then verify network/proxy policy, the service API key, and the timeout before manually retrying.
