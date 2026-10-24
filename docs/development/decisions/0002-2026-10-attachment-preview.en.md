# 0002 · A four-stage attachment preview and one budget

[简体中文](0002-2026-10-attachment-preview.zh-CN.md) | [Decision index](README.en.md)

- **Status**: Adopted (2026-10)
- **Scope**: Attachment fetching and previewing in the renderer; preview budgets; preview failure codes and copy; the renderer's CSP and top-level navigation policy
- **Replaces**: The `<iframe>` / bare `<img>` preview, and byte and pixel ceilings scattered across components

## Background

Until 2026-10, "open an attachment" had three different implementations in the renderer: PDFs went into an `<iframe>` and were handed to the browser's plugin, images were loaded with a bare `<img src=blob:>`, and everything else fell back to "download to view". The symptoms looked unrelated:

- A high-DPI scan (a 300 DPI A4 invoice) **silently rendered as a blank page** in the old implementation: when the canvas allocation failed or pdf.js rejected the image on its internal size gate, the user saw an empty white canvas with no error at all. That was not a rendering bug but the absence of any layer responsible for deciding whether these bytes could be drawn.
- The limits were scattered literals: 20 MB here, 5,000 pages there, an 8192-pixel constant somewhere else. Changing one did not change the other, so "allowed to open" and "able to draw" drifted apart.
- `<iframe>` is natural isolation, but it also isolates the *failure*: a load error inside another document never becomes on-screen text, so the user only sees white.
- To keep that path usable, the CSP retained `frame-src blob:` and `img-src https: http:`, which also let an `<img>` that slipped through the mail body reach any host directly.

The three are symptoms of one structural choice: **the preview had no explicit pipeline, so every format decided on its own whether the bytes were small enough, whether they could be drawn, and how a failure should be described.**

## Decision

**Rebuild the preview as an explicit pipeline (fetch → decode → document → render), with exactly one definition of each layer's budget, failure codes and resource ownership.**

| # | Decision | Why | What was given up |
|---|---|---|---|
| D1 | Four layers: `ingress` (fetch and deadline), `decode` (per previewKind), `document` (the single objectURL owner, `ResourceScope`), `render` (a surface registry with an exhaustive mapping of 10 surfaces) | Each layer answers one question: did the bytes arrive, can they become an intermediate form, who releases them, and what gets drawn. Blank pages were possible because no layer was ever asked whether the bytes could be drawn | The `<iframe>`'s built-in isolation. PDFs, SVGs and images now render same-origin, so isolation has to come from the CSP, `DOMPurify` (SVG), strict content types and the pixel gates together — one less browser-level safety net, one more testable responsibility |
| D2 | One classification source: the attachment catalogue in `packages/agent-contracts` (13 previewKinds, 138 extensions, tiers A/B/C) | The web and server packages each kept an extension table and parities were maintained by hand; once they drifted, "the server reports an attachment the renderer calls unviewable" became inevitable | Per-side flexibility. The tier B (must unzip to tell) and tier C (download only) split also became part of the contract |
| D3 | One budget source: `apps/web/src/attachments/budget.ts`. `worstCaseBytes()` for seven branches must satisfy `worst + RESERVE_BYTES ≤ MAX_MEMORY_BYTES` (192 MiB), and `MemoryLease` charges **before** an allocation happens | Every old constant was estimated in isolation, so any adjustment could push some branch past the ceiling it was supposed to respect. Writing the worst case as an executable assertion makes a change fail in tests instead of on a user's machine | Freedom to tune each format by feel; also the claim that the ledger equals the process's memory ceiling — pdf.js internals and the browser's decoders are off the books (see known limitations) |
| D4 | PDF runs in strict mode: `stopAtErrors: true`, plus a per-image `maxImageSize` gate, a per-page image-pixel sum, a page-canvas byte ceiling and a wall-clock deadline | The old implementation turned "cannot draw" into a silent blank page; in strict mode the same bytes **end in a visible failure**, so the user at least knows what happened | PDFs with recoverable errors fail per page (some files that used to show half a page now show an error). The escape hatch is downloading the original — a deliberate trade |
| D5 | Failure codes collapse to 14, interface states to 13 and new copy keys to 16, all pinned by one table plus a test that builds each code through its real decode path | When each decoder words its own failure, one kind of failure arrives in five different phrasings and the missing one is never added | Exposing the decoders' exception detail in the interface. The detail stays in logs and `cause`; the interface only answers why it will not open, whether retrying helps, and whether downloading does |
| D6 | The CSP tightens exactly the three directives that must tighten: `frame-src 'none'`, `worker-src 'self'`, `media-src 'self' blob:`. `style-src 'unsafe-inline'` stays | Once the `<iframe>` is gone, `frame-src blob:` is a dead allowance; pdf.js's worker must load from same-origin assets; audio and video play from blob URLs | Removing `unsafe-inline`. The splash depends on an inline `<style>` block in `index.html`, and removing it would flash an unstyled screen first; that belongs in a separate batch that introduces nonces or hashes |
| D7 | Gravatar moves behind a same-origin proxy `GET /api/avatars/gravatar/:hash`, and the same commit tightens `img-src` to `'self' data: blob:` | A renderer that contacts Gravatar directly hands the address hash and the user's IP to a third party, and it was the only reason `img-src` kept `https:`/`http:` | The simplicity of a direct request. The proxy adds a new server-side outbound surface, so it got four gates: `redirect: "manual"`, a 5 s timeout, a 1 MiB ceiling enforced twice, and a content type that must be `image/*` but not SVG; callers can send only a digest, never the upstream URL |
| D8 | Top-level desktop navigation gets a scheme allowlist: `blob:`, `data:`, `file:` and `javascript:` are all denied | Once the preview no longer depends on top-level `blob:` navigation, those schemes are only useful for "mail content steers the page somewhere" | Any future need to open a local file from the interface must be an explicit channel, not a reuse of navigation |

## Consequences

**Gained:**

- "Cannot open" becomes a first-class result: each of the 14 failure codes has a minimal construction that triggers it, and the interface offers a reason, a retry and a download. A 300 DPI scan is either drawn or reported, never silently blank.
- The budget is mechanically checkable: the seven `worstCaseBytes()` formulas and the ledger ceiling live in one file and are compared term by term in tests, so tuning a branch fails together with the tightest constraint.
- Resource release has a single owner: `ResourceScope` is the only place an objectURL is released, and every decoder follows the same `cancel → cleanup (at most 3 attempts) → destroy` protocol.
- With the CSP narrowed, the preview no longer needs browser-level isolation as a fallback, and `img-src` returns from "any host" to the two same-origin proxies.

**Paid:**

- Every new format has to land in four places (catalogue row, decode branch, surface registration, failure code and copy); the "just drop it in an iframe" shortcut is gone.
- Strict mode turns some partially viewable PDFs into per-page failures, so the user has to download the original to see the content.
- The proxy and the ledger are new maintenance surfaces: one more outbound route on the server, one more per-branch ledger in the renderer.
- Part of the preview's correctness **cannot be verified in jsdom** (PDF canvas, media decoding) and needs a human visual check on a real machine; this round lists "a vector-text PDF, a 300 DPI scan, page turning and width dragging" as acceptance items.

**How it is verified:** classification parity is asserted in both directions by `apps/web/src/attachments/catalog*.test.ts` and `apps/server/tests/attachment-catalog*.test.ts`; the budget by the seven worst-case comparisons in `budget.test.ts` and the per-code real constructions in `state-table.test.ts`; the CSP and cache policy by `apps/server/tests/csp.test.ts`, `app.test.ts` and `gravatar.test.ts`; and the end-to-end path by `e2e/attachment-preview.spec.ts` running the real pipeline in the demo project.

## Outside this decision

- **Task layer and derived counts**: see [0001 · Unified task layer and derived counts](0001-2026-10-task-layer.en.md); orthogonal to the attachment preview.
- **The message-body image proxy** (`GET /api/images/proxy`) itself: it predates this decision, which only narrows `img-src` on top of it.
- **Attachment upload, sending and drafts**: the preview only reads bytes and does not change any write path.
- **Encryption and storage format**: the bytes the preview receives do not depend on how they were stored.
- **Grid and visual detail**: drawer width, transitions and typography follow the existing design and are not argued here.

## Sources

This page records **the choice and its reasoning at the time** and does not follow implementation details. The current implementation is `apps/web/src/attachments/` (`budget.ts`, `failure.ts`, `ingress.ts`, `session.ts`, `decode/`, `render/`), `apps/server/src/security/csp.ts` and `apps/server/src/avatars/gravatar.ts`; capability boundaries and deliberate omissions are in [known limitations](../known-limitations.en.md); the related commits can be found in `git log` by `attachments/`, `csp.ts` and `avatars/gravatar.ts`.
