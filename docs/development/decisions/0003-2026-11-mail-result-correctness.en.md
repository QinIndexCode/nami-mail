# 0003: Recipient privacy and background delivery results

[简体中文](0003-2026-11-mail-result-correctness.zh-CN.md)

## Status and scope

Accepted, 2026-11-07. Covers recipient visibility, SMTP results, auto-reply recovery, partial task failure and their contracts.

## Background

The task layer moved sending out of the request, while some callers still treat acceptance as success. The review also found BCC converted to CC and partial SMTP rejection discarded. These problems cross input contracts, encrypted ledgers, execution and feedback; changing a toast cannot establish consistency.

## Decisions

| ID | Decision | Why | Rejected alternative |
|---|---|---|---|
| D1 | Preserve BCC separately through compose, drafts, confirmation and SMTP; store it only in encrypted payloads | Visibility is request semantics. Drafts retain Bcc headers; actual delivery uses the envelope | Converting BCC to CC or silently discarding it |
| D2 | Store recipient outcomes in existing encrypted details; retry drafts contain rejected addresses only, retaining their groups | A Sent copy does not prove every address was accepted | Resending the entire message after partial rejection |
| D3 | Persist auto-reply submission associations and settle actual outcomes; retain unknown delivery for reconciliation | Limits, thread deduplication, audit and UI need one result | Treating queuing as success or automatically resending unknown delivery |
| D4 | Accept candidates in the sync transaction and continue through bounded batches; final writes still use tasks | Screening, model calls and user approval must not hold remote-write locks, and inputs must survive lost notifications | Another SMTP executor or a 40-message acceptance ceiling |
| D5 | Determine attention from both status and failed counts; use bounded calendar/MCP pagination | Execution completion is not complete success, and a first-page limit must not silently hide allowed input | Empty panels or partial tool directories presented as successful results |
| D6 | Raise the database gate to v5; continue reading old encrypted requests and preserve fingerprints without BCC | Older runners cannot interpret BCC and must not execute new requests | Allowing schema-v4 runtimes to open upgraded data |

## Consequences

The existing task layer still owns SMTP/IMAP. Auto-replies add durable business-input and delivery-association tables, with reconciliation and shutdown handling. Submission details gain compatible optional fields. Upgraded data cannot be opened by an older scheduler.

Validation uses synthetic mail, isolated SQLite, real loopback SMTP and stdio MCP. It covers hidden Bcc headers, partial rejection, old request idempotency, 45-message bursts, queued/unknown delivery after restart, interruption after approval, time zones, pagination, migration and visible feedback.

## Outside this decision

Complete backup/restore, OAuth app registration, release trust, installation, external calendar sync and full recurring-invitation support.

## Evidence

- `packages/agent-contracts/src/mail-dto.ts`, `external-write-mail.ts`
- `apps/server/src/outbox.ts`, `tasks/kinds/send.ts`, `agent/auto-reply-*.ts`
- `apps/server/tests/recipient-delivery.test.ts`, `auto-reply-delivery.test.ts`, `calendar-pagination.test.ts`
