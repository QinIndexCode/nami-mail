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

## Reading-pane AI shortcuts (AI summary / AI draft reply)

**Status**: agreed shape, not scheduled (evaluated 2026-09-10).

**Goal**: act on the current mail from the reading pane in one click, landing in the
Agent workspace with the reference already attached and the instruction already typed.

**Shape decisions** (deliberately not the intuitive "jump and send a template message"):

- **Reuse the structured reference, not a template sentence**: `currentMessage` → reference chip → request `references` field → server `[REFERENCED MAIL n]` block (`referenceBlockFor` in `agent-service.ts`). A template sentence downgrades structured data to prose that drifts with language and model.
- **Reuse the existing slash commands**: `/summary` for summarising, `/draft` for drafting a reply (`packages/agent-contracts/src/agent-commands.ts`) — no new prompt copy to maintain.
- **Summary may auto-send; draft reply must not**: `mail.summarize` / `messages.get` are read-only with no confirmation card, so clicking "AI summary" is itself the consent. `/draft` produces a draft and sending is a separate confirmation path (`AgentConfirmationCard`, `send-confirmed` by default); auto-sending would skip the user's review step.
- **Do not add two more toolbar buttons**: the reading toolbar already holds 11 controls and is tight at ≤620px, so promote the existing generic `agent-launch-button` (`App.tsx`) to a semantic "AI summary" and put "AI draft reply" in the existing More menu.
- **Prerequisite**: the reading pane is inline in the 3,818-line `App.tsx` with no dedicated test, so the "intent → preset text / whether to auto-send" decision must first be extracted into a pure, unit-tested function (following `slashMenu.ts` / `contextMenu.ts`).
- **Gap**: `AgentWorkspace` has no `initialPrompt` / auto-send intent (it can only seed the reference chip), so a new prop is required.
- **Constraint**: new copy must land in both `zh-CN.json` and `en-US.json` (enforced by `build-locale-catalog --check` in CI).

## UI and interaction polish (audited 2026-09-10, delivered in batches)

**Status**: direction agreed, first batch scheduled.

> **The rules are now documented**: see the [design system](DESIGN-SYSTEM.en.md) for the visual
> baselines (prose measure, radius, shadows, type scale, line height, colour saturation, interaction
> states, convergence backlog). Read it before changing styles, and update it when a new step is
> introduced.

**Delivered (2026-09-10, batches Y/Z/AA)**: calendar colours tokenised with dark-theme coverage; radius
tokenised (`var(--radius-*)` references 2 → ~179 with no numeric change, plus three literals the first
pass had missed); the five centred blocks in the reading pane unified on `--measure:672px` (down from
820px, ~95–100 characters per line to ~72); body line-height 1.85 → 1.7; the orphan
`.sync-progress-banner` class styled; **contrast baseline** corrected two light-theme tokens to the
WCAG 4.5:1 floor (`--text-faint` `#727279`→`#66666c`, `--warning` `#b67816`→`#9a6510`); and the
**executable baseline** landed (`themeContrast.test.ts`, 8 tests, plus `designTokens.test.ts`,
10 tests, including a debt ratchet that may only go down and rejects new off-scale values).

**Visual consistency** (audit of the 16,900-line `apps/web/src/styles.css`):

- ~~Hardcoded colours bypass the tokens: the six calendar colours are not tokenised and have no dark-theme override~~ **done** (batch Y).
- ~~Radius fragmentation: at least 15 distinct values against three tokens~~ **values normalised and tokenised** (batches Y/Z: `var(--radius-*)` references 2 → ~179); the off-scale ones are still held by a ratchet budget until they are merged.
- ~~Hardcoded shadows: one-off elevation shadows mixed across layers~~ **done** (batch AC): 12 of 25 candidates folded into `--shadow-raised`/`--shadow-sm` and 2 redundant dark overrides deleted; **elevation literals are now 0** (18 state halos + 2 native slider details remain, both documented exemptions).
- Font-size fragmentation: ~13 values including a fractional `11.5px`, many below 12px.
- Spacing drifts off the 4px grid: `7px` / `9px` account for 100+ occurrences.
- Of 32 `!important` declarations ~6 are redundant; the 42 `outline:none` sites each need confirming against a focus-ring replacement.
- **Orphan class**: `sync-progress-banner` is used in `App.tsx` but has no rule at all in the stylesheet.
- Good foundations already in place: 9 `prefers-reduced-motion` blocks, 56 `:focus-visible` rules, tone colours already themed for dark mode.

**Performance** (top items by value/effort):

- The list endpoint returns the full `htmlBody` for every page, so list payloads are large.
- `/api/stats` polls every 60s with a full-table `SUM(CASE ...)`, and `flags_json LIKE '%\Seen%'` cannot use an index; `messages` has no derived-column index for flags.
- The list sorts by `ORDER BY COALESCE(sent_at, created_at)` (an expression, so `idx_messages_sent_at` cannot help) and pages with `LIMIT/OFFSET`.
- Every request re-prepares its statements; there is no statement cache.
- First paint already fetches in parallel (`Promise.all`) — no change needed.

## Other backlog candidates (from the 0.3.0 frontend research, unscheduled)

- Rich-text compose (Markdown toolbar or contentEditable + GFM preview).
- Fullscreen / maximized compose mode.
- Section-jump navigation for settings on narrow windows (currently the left nav is hidden at ≤760px).
- Touch / keyboard accessibility for inline quick actions in the message list.

> Correction (2026-09-09): "Full keyboard navigation for recipient suggestions
> (arrow keys + Enter)" shipped with the keyboard-accessibility batch (the
> ComposeModal recipient suggestions expose full combobox semantics with
> arrow-key/Enter interaction, see `ComposeModal.test.tsx`) and is removed
> from the backlog.
