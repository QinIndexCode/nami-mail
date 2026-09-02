# Model Provider Configuration (NamiMail Agent)

[简体中文](providers.zh-CN.md) | [Usage guide](usage.en.md) | [Architecture](architecture.en.md)

The mail assistant only starts reading or sending mail content once at least one usable model provider is configured. This page explains how to configure model connections, API keys, and cloud mail-content consent.

## Quick Start

1. Open the NamiMail Agent workspace and go to **Settings → Model providers**.
2. Click **Add model**, choose the interface type, and fill in the endpoint, model name, and other fields.
3. Click **Save and check**; once the connection is verified, you can start chatting.

Without any configured model, the assistant shows "Set up a usable model first" and never reads or sends mail content.

## Supported Interface Types

| Interface type | Description |
| --- | --- |
| OpenAI-compatible | Connects to most services, such as DeepSeek, Qwen, Kimi, Zhipu, Doubao, vLLM, LM Studio, etc. |
| Ollama (local) | Local Ollama server; suggested default endpoint `http://127.0.0.1:11434/v1` |
| Anthropic Claude (native protocol) | Anthropic Messages API, e.g. `https://api.anthropic.com` |
| Google Gemini (native protocol) | e.g. `https://generativelanguage.googleapis.com/v1beta` |
| OpenAI Responses (native protocol) | e.g. `https://api.openai.com/v1` |
| Custom | Reserved kind for future or user-defined provider adapters |

## Fields

| Field | Requirements |
| --- | --- |
| Interface type | One of the types above |
| Display name | Only used to distinguish models within Nami Mail |
| Endpoint | Use HTTPS; loopback HTTP is allowed only for local servers |
| Model name | The exact model ID the server provides |
| Request timeout | In milliseconds, 1,000 to 120,000 |
| API key | Written only to local encrypted storage; never shown again after saving |

API key behavior:

- After saving, the key is write-only and never echoed; when editing a model, **leaving it blank keeps the existing key**, and "Remove existing key on save" clears it.
- Local or authentication-free servers may leave the key blank.
- Keys never appear in ordinary settings, logs, browser state, or IPC output.

## Cloud Mail-Content Consent

- Cloud models (Claude, Gemini, OpenAI, OpenAI-compatible, etc.) **cannot read mail content by default**. You must enable "Allow sending selected mail content to the cloud model" and confirm that the service meets your data-processing requirements.
- Once enabled, the content sent to the model is still bounded by the **conversation scope**: only mail within your selected scope is sent, with a disclosure shown beforehand.
- Until enabled, a cloud model only receives text you actively type.
- Local Ollama never sends mail content to the cloud and is unaffected by this switch.
- Consent is never inferred from the presence of an API key: without explicit opt-in, a cloud model cannot read mail.

## Default Model and Status

- **Set as default model**: new conversations prefer this model.
- Status badges: `Configuration complete`, `Connection verified`, `Connection needs review`, `Connection unavailable`; local and cloud models are labeled separately.
- A failed connection check keeps the configuration so you can fix and retry; common errors include auth rejection, timeout, unreachable server, rate limiting, and configuration changed during the check.

## Related Documentation

- [Usage guide](usage.en.md): creating conversations, choosing mail scope, viewing citations, and handling confirmations.
- [Connecting external MCP servers](mcp-servers.en.md): extending the assistant with more external tools.
- [Architecture](architecture.en.md) and [Security](security.en.md): the provider call chain and the cloud-egress boundary.
