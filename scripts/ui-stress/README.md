# UI stress harness (list at 20k messages)

Scripts to measure the web list UI against a seeded local server with tens of
thousands of encrypted messages. Run when the mailbox list grows slow or
before touching list/batch code.

## How to run

```sh
# full 20k run (pagination phase takes ~25–30 min on a dev machine)
node scripts/ui-stress/run-stress.mjs --count 20000 --ratio 0.75

# quick smoke (≈5 min)
node scripts/ui-stress/run-stress.mjs --count 5000 --ratio 0.75

# pilot without scrolling all pages (batch phases run on what is loaded)
STRESS_MAX_PAGES=6 npx playwright test e2e/ui-stress.spec.ts --workers=1
```

The runner:
1. seeds `data/ui-stress/nami-mail.db` (`scripts/ui-stress/seed-data.mjs`) ✓
2. boots `apps/server/dist/index.js` against it on port 3187 (`npm run build
   --workspace @nami/server` first)
3. runs `e2e/ui-stress.spec.ts` (Playwright boots the Vite dev server itself
   on 5173; see `playwright.config.ts` → `webServer` / proxy)
4. seals `data/ui-stress/results-<timestamp>.json` (per-phase metrics + spec
   results) and kills the server.

The seed account points its IMAP/SMTP endpoints at an unused loopback port,
so remote operations fail fast with ECONNREFUSED instead of hanging — batch
latency then isolates UI behavior.

## Phases measured (`e2e/ui-stress.spec.ts`)

1. **Initial inbox render** — boot, first page, API timings, frame jank,
   DOM size, sidebar badges (unread = 75 % of total).
2. **Scroll pagination** — click the load-more footer repeatedly until the
   last page. Per-page pre-click/click/settle timings, request latencies,
   longtask totals, and detected list resets.
3. **Batch mark-read of everything loaded** — select-all → marker-read;
   web splits into chunks of 100 PATCHes; blocks the toolbar until done.
4. **Batch archive of everything loaded** — single POST to the move endpoint
   (note: the server caps ids at 100/schema — see findings).
5. **100-item selection archive** — incremental per-row selection cost, then
   one 100-id move request.

Perf instrumentation is injected via `addInitScript`: a rAF frame sampler,
a PerformanceObserver for longtasks, a fetch wrapper recording per-API
request durations, and a toast history sampler. The terms-of-use dialog is
automatically accepted by a watchdog (it can appear after boot).

## Reference numbers (2026-08-09, Windows, Chromium headless, dev build)

### Phase 1 — initial render (100-item first page)

| Metric | DB 5k | DB 20k |
| --- | --- | --- |
| `/api/messages` first page | 12 ms | 189 ms |
| `/api/stats` (COUNT scans) | 3 ms | 241 ms |
| Initial commit longtask total | — | 524 ms (5 tasks) |
| Frame p95 / max during boot | — | 33 / 200 ms |
| DOM nodes at 100 items | ~3 000 | ~3 000 |

Server-side list SQL stays cheap; the 20k badge/stats count scans are the
main boot cost.

### Phase 2 — scroll pagination (load-more loop)

| Metric | 5k run (49 pages) |
| --- | --- |
| Total time | 237 s (~4.8 s/page) |
| Per-page click-to-apply latency | 0.7 s at 600 items → 3–5 s at 5k |
| Browser-side fetch completion p50 / p95 (network itself ~20 ms) | 1.37 / 1.91 s |
| Longtasks during pagination | 318 tasks, 152 s |
| DOM at 5 000 items | 138 957 nodes (~28 nodes/row) |

Click latency is Playwright's actionability wait: the button must be stable
while the list re-renders — a fair proxy for perceived button deadness. It
scales worse than linearly with mounted rows. At 20k the run aborted-planned
at ~45 min; per-page cost there reached 4–6 s (data/.../results-*.json, page
logs).

### Phase 3 — batch mark-read of everything loaded (5k)

| Metric | Value |
| --- | --- |
| Total toolbar-blocked time | 25.6 s (50 chunks of 100) |
| Chunk request p50 / p95 / max | 98 / 120 / 2771 ms |
| Toast | 1281 封操作成功，3719 封失败 |
| Frame p95 / max during batch | 317 ms / 8.8 s (700 janky gaps) |
| Longtask total during batch | 180.9 s |
| Outcome | remote flags failed (dead IMAP) → silent reload restores truth; unread badge returns to 3719 |

### Phase 4 — batch archive of everything loaded (5k)

Failed outright in 0.33 s: single request with 5 000 ids → server schema
rejects >100 ids → error toast "移动邮件失败". No chunking in the move path
(unlike flags).

### Phase 5 — 100-item selection archive (5k)

100 incremental row selections took 21.3 s (~213 ms/click incl. re-render).
The 100-id move request itself: 597 ms total; server-side 184 ms (fast
connect-refusals); result `updated: 0` → error toast "移动邮件失败".

## Findings

1. **List DOM explodes** — ~28 DOM nodes per row ⇒ 20k rows ≈ 560k nodes;
   initial commit at 20k is fine but every subsequent re-render and click
   degrades (p95 frame gap >300 ms during batches, one 8.8 s frame).
2. **Silent refresh washes out pagination** — the periodic
   `load({silent:true})` (settings.refresh_interval_seconds, default 60)
   resets the accumulated list to page 1. A user scrolling a 20k inbox loses
   progress every minute; even select-all then only covers the fresh first
   page. The seed forces the max interval (300 s) so the run is measurable.
3. **Batch move >100 ids always fails** — `batchMoveMessages` sends the whole
   selection in one request while the server validates `ids[].min(1).max(100)`
   (apps/server/src/app.ts batchMessageIdsSchema). Compare with
   `batchUpdateFlags`, which chunks at 100. Archive/trash of ≥101 selected
   messages errors instantly.
4. **"成功" count in batch toasts is misleading** — already-in-target-state
   messages count as `updated` (intended idempotency in
   `updateMessageFlagsBatch`), so the toast can claim 1281 successes while
   zero messages were actually changed remotely.
5. **Batch move exits selection mode even on total failure** (finally →
   `exitSelectionMode`), while batch flags keeps selection — inconsistent
   failure UX.
6. **Terms-of-use dialog never unmounts** — after accept the `closing` state
   lingers (`useDismissTransition` never resets; parent sets open=false),
   leaving the backdrop/card permanently in the DOM (pointer-events: none,
   invisible). A re-open stays stuck except the 170 ms timer + closing class.
7. **Incremental selection cost grows with DOM** — ~213 ms/row at 5k rows
   including re-render; batch-select UI (select-all) is the fast path.

## Artifacts

- `scripts/ui-stress/seed-data.mjs` — deterministic DB generator (mulberry32
  seed 42), encrypts payloads with the real server modules.
- `scripts/ui-stress/run-stress.mjs` — orchestrator: seed → server → spec →
  seal results; fails fast when 3187/5173 are busy.
- `e2e/ui-stress.spec.ts` — the measurement spec (single serial test,
  per-phase results persisted to `data/ui-stress/results-spec.json`).
- `data/ui-stress/results-*.json` — sealed runs; ignore (`data/` is
  gitignored).