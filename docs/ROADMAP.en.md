# Roadmap

This document tracks features that have been confirmed but are not yet scheduled (backlog). Scheduled features are tracked in the [Unreleased] section of the CHANGELOG.

## Image upload / multimodal (vision) support

**Status**: confirmed, not scheduled. Not recommended for the 0.3.0 release cycle (large cross-cutting change, and not a core requirement for the mail workflow).

**Goal**: allow users to attach images in compose / Agent chat so the model can understand them visually (e.g. analyze screenshots, invoices, scans) and draft replies based on them.

**Key design points** (from prior research):

- **Vision detection**: explicit opt-in — add `vision: boolean` to the provider configuration; the user checks a "multimodal model" box when adding/editing a model before image upload is allowed. No automatic model-name detection (unreliable).
- **Contract extension (minimal)**: add optional `images?: string[]` (base64 data URLs) to `ProviderChatMessage`; keep `content` as a string for full backward compatibility. Add `vision: boolean` to `providerCapabilitiesSchema`.
- **Provider adapter mapping**:
  | Adapter | Mapping |
  |---|---|
  | OpenAI Responses | `input_image: { image_url }` |
  | OpenAI Chat Completions | `image_url` content part |
  | Gemini | `inline_data: { mime_type, data }` |
  | Anthropic | `image` source part |
- **Frontend**: extend `fileProcessor` for images (read → compress ≤1.5 MB → base64 data URL); show an attachment button + thumbnails in the composer when the model is vision-capable; render attached images in message bubbles.
- **Limits**: ≤1.5 MB per image (after compression), ≤4 images per message.
- **Privacy**: image base64 is sent to the cloud provider, so it falls under the external-leak tool set; reuse the existing consent gating / explicit user intent confirmation.
- **Suggested rollout**: support OpenAI-compatible + Gemini first (most standard image APIs), then Anthropic / Responses, to reduce first-round risk.

## Other backlog candidates (from the 0.3.0 frontend audit, unscheduled)

- Rich-text compose (Markdown toolbar or contentEditable + GFM preview).
- Fullscreen / maximized compose mode.
- Full keyboard navigation for recipient suggestions (arrow keys + Enter).
- Section-jump navigation for settings on narrow windows (currently the left nav is hidden at ≤760px).
- Touch / keyboard accessibility for inline quick actions in the message list.
