# Auto-Reply

[简体中文](AUTO-REPLY.zh-CN.md) | [English](AUTO-REPLY.en.md)

Auto-reply is an opt-in, per-account feature of Nami Mail. After a sync pass, newly arrived inbox mail passes a set of local offline rules; surviving candidates are then evaluated by a model, which drafts a plain-text reply. Agent-drafted replies always require your approval in a confirmation dialog before anything is sent; template mode can opt out of that confirmation per template. Configure it under **Settings → Agent → Auto-reply**.

## Enabling and Account Scope

- After **enabling auto-reply**, pick which accounts to monitor — an empty list means the feature never runs.
- The **daily reply limit** caps how many auto-replies each account may send per day (default 30, range 0–500).

## Reply Modes and Dual Models

- **Agent drafting (llm mode)**: a model decides whether the incoming message deserves a reply and drafts it. The **screening model** and the **drafting model** can be configured independently (empty means the default provider) — for example, a fast lightweight model for screening and a stronger model for drafting.
- **Fixed template (template mode)**: no model call; the template text is sent as-is. Templates support placeholders — `{{senderName}}`, `{{senderAddress}}`, `{{senderDomain}}`, `{{subject}}` — up to 2,000 characters, and may individually opt out of the send confirmation.

## Eligibility Scope (offline, no model involved)

Scope rules run entirely on your machine, before any model is consulted:

- **Contacts only**: reply only to senders present in the local address book.
- **Date window**: an optional start/end range; mail outside the window is skipped.
- **Reply once per thread**: on by default; permanent per-thread deduplication.
- **Custom rules** (up to 50): field (sender / sender domain / subject) + operator (contains / not-contains / equals) + action (reply / ignore). `Ignore` rules win first; the remaining `reply` rules form an implicit whitelist — a message matching no `reply` rule never reaches the model.

A fixed offline screen runs on top of this and always skips: mail in junk folders, automatic mail carrying an `Auto-Submitted` header, marketing mail (`List-Unsubscribe` or `Precedence: bulk/list/junk`), Gmail's promotions/social/updates category labels, mail without a sender, and bounces.

## Confirmation, Audit, and Sensitive Content

- Agent-drafted replies always surface a confirmation card (valid for 5 minutes) where you approve or decline the send; pending and sent outcomes are reported through in-app notifications.
- Declined or failed replies are recorded in a local decision log you can review in the UI.
- Messages containing sensitive keywords (passwords, verification codes, and similar) are flagged and routed to the highest-priority confirmation surface; the model still re-confirms sensitivity.

## Dry-Run Sandbox

Settings includes a zero-side-effect auto-reply sandbox: enter a test message or load a real inbox sample, and watch the pipeline end to end — link-cleaning token savings, scope-rule and offline-screen outcomes, the model's decision reasoning, the drafted preview, and per-stage timings. The sandbox runs in a read-only context and never sends mail.

## Data and Boundaries

- llm mode sends the cleaned message content (tracking links normalized, inline images compressed to save tokens) to your configured model provider. Without a configured model the feature is unavailable; a broken configuration shows a clear warning in Settings.
- template mode is fully offline and never sends message content to any third party.
- Auto-reply only processes newly synced inbox mail; it never reads historical mail and never changes provider-side auto-reply or vacation settings.
