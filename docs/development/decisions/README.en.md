# Decision records

[简体中文](README.zh-CN.md)

This directory holds **structural trade-offs that are already in effect**: the situation that produced them, the evidence available at the time, the path chosen, and what was given up.

- It is **not** a roadmap: no schedules, no "we will do this later".
- It is **not** a defect list: capability boundaries and deliberate omissions live in [known limitations](../known-limitations.en.md).
- It does **not** track implementation: the [architecture document](../../ARCHITECTURE.en.md) and the code are the source of truth for how things work now. When a decision is overturned, write a new record and mark the old one `superseded` — do not rewrite history in place.

## When to write one

Only when both of these hold:

1. The change crosses modules or is hard to reverse — replacing a persistence layer, changing the HTTP contract, merging or deleting an existing module, changing encryption or the data model.
2. Someone will ask "why was it done this way" in six months, and the answer would not survive as a code comment.

Not needed: the shape of a single endpoint, UI interaction details, a one-off bug fix. Those belong in commit messages and code comments.

## How to write one

- One decision per file, named `NNNN-YYYY-MM-topic.zh-CN.md` / `.en.md`, numbered consecutively.
- Section order is fixed: **status and scope → context (which symptoms, and why they are not three bugs) → decision (table: decision / why / given up) → consequences (gained, paid, how verified) → out of scope → basis**.
- Give decisions stable identifiers (`D1`, `D2`, …); later records cite the identifier, not a paragraph.
- Every decision row must state **what was given up**. A record that lists only benefits has no value.
- Numbers need a source and measurement conditions; when something cannot be verified, write "unverified" rather than an estimate.
- The two language versions mirror each other line for line; the English is a translation, not a rewrite.

## Status words

| Status | Meaning |
|---|---|
| proposed | Written, not yet in effect; still open to edits |
| accepted | The code follows it; changing it needs a new record |
| superseded | Replaced by a later record and kept for history; the replacement says what it replaced |

## Index

| # | Topic | Status | Scope |
|---|---|---|---|
| [0001](0001-2026-10-task-layer.en.md) | One task layer and derived counts | accepted (2026-10) | Server write paths, HTTP contract, web list state |
| [0002](0002-2026-10-attachment-preview.en.md) | A four-stage attachment preview and one budget | accepted (2026-10) | Renderer fetch and preview, preview budgets and failure codes, CSP and top-level navigation |
