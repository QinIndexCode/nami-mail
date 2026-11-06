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
| TypeSafe System One (decision model) | Pure decision model (e.g. Jev), never generates text; fill in the API base URL (official `https://api.typesafe.ai/v1` or a self-hosted gateway), model alias such as `jev-latest` |

## Model Roles (chat / decision)

Every model connection carries explicit **roles** describing the work it may serve:

- **chat**: every text-generating call site — assistant turns, AI translation, AI polish, retrieval expansion, and auto-reply drafting. The five chat-shaped interface types above all hold this role.
- **decision**: typed decisions that return a label or calibrated probability instead of prose, such as the `noul` questions of System One (Jev). A decision-only model **cannot** be the default model and never appears in the assistant, translation or polish model pickers; it only serves explicitly wired decision call sites such as auto-reply review.
- A kind written by a newer app version stays listed and deletable (with an "unsupported in this version" badge) but cannot be edited or connection-checked — reads are lenient, writes strict, so one foreign row can never take the whole model table down.

## Fields

| Field | Requirements |
| --- | --- |
| Interface type | One of the types above |
| Display name | Only used to distinguish models within Nami Mail |
| Endpoint | Use HTTPS; loopback HTTP is allowed only for local servers |
| Model name | The exact model ID the server provides |
| Request timeout | In milliseconds, 1,000 to 120,000 |
| Multimodal capabilities | Individually toggle supported input modalities: Image and PDF documents (note: Audio and Video are contract reservations, not yet consumed) |
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

- **Set as default model**: new conversations prefer this model; only chat-role models can be the default, decision-role rows do not offer the action.
- Status badges: `Configuration complete`, `Connection verified`, `Connection needs review`, `Connection unavailable`; local and cloud models are labeled separately, and decision-role models carry a "decision model" badge.
- A failed connection check keeps the configuration so you can fix and retry; common errors include auth rejection, timeout, unreachable server, rate limiting, and configuration changed during the check.

## Multimodal Input Capabilities

- **Explicit Opt-in**: Model capabilities vary significantly. NamiMail Agent uses explicit modality toggles rather than guessing from model names.
- **Supported Modalities**: You can independently enable image and PDF document processing per model (audio and video switches are contract type reservations, not yet consumed by the runtime).
- **Backward Compatibility & Plain-Text Fallback**: Any model configured without multimodal support strictly degrades to plain-text mode. Composer attachment pickers automatically enforce this to prevent upstream API failures.
- **Protocol Adaptation**: The server adapts multimodal payloads end-to-end across OpenAI Chat, OpenAI Responses, Anthropic Claude, and Google Gemini native multimodal specifications with base64 and media URL normalization.

## Related Documentation

- [Usage guide](usage.en.md): creating conversations, choosing mail scope, viewing citations, and handling confirmations.
- [Connecting external MCP servers](mcp-servers.en.md): extending the assistant with more external tools.
- [Architecture](architecture.en.md) and [Security](security.en.md): the provider call chain and the cloud-egress boundary.
