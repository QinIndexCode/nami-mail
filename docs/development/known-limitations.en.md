# Known Limitations

[简体中文](known-limitations.zh-CN.md) | [English](known-limitations.en.md)

This page collects Nami Mail's **verified capability boundaries and deliberate trade-offs** in one place. Each entry states the evidence (a code location or a document), what it affects, and how it is handled today or why we accept it. It is not a roadmap — no dates are promised — and it is not a bug list; report reproducible defects through GitHub Issues. Release notes, audits and troubleshooting all reference this page instead of restating the gaps.

Verified against the working tree of 2026-10-22 (commit `cd47467`). Re-check the relevant entry when the code changes.

## At a glance

| # | Item | Nature |
|---|---|---|
| 1 | Outlook / Hotmail sign-in is limited (issue #120) | Product boundary |
| 2 | Attachment-metadata backfill costs the first start | Data / startup |
| 3 | Draft attachments get their paperclip late | Behaviour |
| 4 | Conversation title protocol vs. older clients | Protocol / compatibility |
| 5 | Plaintext surfaces outside the database file | Privacy / data |
| 6 | Items still open from the 2026-10 review records | Engineering debt |
| 7 | The end-to-end test coverage boundary | Testing |
| 8 | Reserved task kinds that nothing produces yet | Reserved design |
| 9 | The retained `/api/batch-jobs` compatibility alias | API compatibility |
| 10 | No stable / beta channel and no one-click rollback | Release policy |
| 11 | Error logs: bounded files, no user-facing error history | Diagnostics / privacy |
| 12 | Items from the 2026-10-22 audit that remain unfixed | Audit / open items |
| 13 | Capability boundaries of in-app attachment preview | Attachments / platform |
| 14 | The Attachments view and the inbox attachment filter count different sets | Behaviour / view scope |

## 1. Outlook / Hotmail sign-in is limited (issue #120)

**Current state.** Microsoft has retired basic IMAP/SMTP password authentication for Outlook.com / Hotmail and requires OAuth2. Official builds ship an empty built-in Microsoft OAuth client ID (`builtinMicrosoftOAuthClientId = ""` in `apps/server/src/config.ts`) and do not bundle an Azure app registration, so on a clean install "Sign in with Microsoft" cannot complete as-is; the limitation is tracked as GitHub issue #120. Enterprise or school tenant administrators may additionally disable IMAP by policy.

**Impact.** Outlook / Hotmail accounts cannot be added with a plain password; the provider rejects the password. Organisation accounts may still fail under OAuth when an administrator blocks IMAP or the OAuth app.

**How it is handled.** To sign in with a Microsoft account, set `NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID` in `%APPDATA%\Nami Mail\nami-mail.env` (a one-time Azure app registration; the "Google and Microsoft OAuth" section of [Email provider setup](../EMAIL-PROVIDERS.en.md) has the steps). Registering an official Azure app and bundling its client ID is planned; until then, use another mail provider. Subscription type and administrator policy differences also need to be confirmed with the relevant administrator.

## 2. Attachment-metadata backfill costs the first start

**Current state.** After attachment visibility was unified to "a part counts only when it is not `multipart/related`", older databases need `has_attachments` and `attachment_kinds_json` recomputed once. `ensureAttachmentMetadata` in `apps/server/src/message-storage.ts` runs synchronously inside `buildApp`'s startup sequence: it reads the whole table, decrypts each message payload, recomputes both columns, and records a `data_migrations` marker (`attachment-metadata-v1`). A row whose payload cannot be decrypted keeps its previous values and does not block startup.

**Impact.** A one-time startup stall whose cost scales with message count and payload size. Measured sample on this machine: a main database file of about 637 MB (measured 2026-10; the whole data directory is about 772 MB including end-to-end fixtures; both vary with mailbox size). Once the backfill completes, later starts see the marker and skip it — the marker is written even when some payloads stay unreadable, because otherwise every start would have to decrypt the whole table for them. **Logged, but not surfaced in the UI**: the function returns `{ backfilled, unclassified }` (`unclassified` counts the rows whose payload could not be read and therefore kept their previous flags); the startup call site writes that result to `serverLog` (a warn when `unclassified > 0`), but `/api/stats` exposes only accounts/messages/unread/starred/snoozed/attachments — the interface shows no backfill progress or count.

**How it is handled.** We accept the one-time cost; expect a longer first start for a large mailbox. Startup duration is the observable signal. A non-zero `unclassified` means some rows can never be classified (usually a master key that does not match the database); the number is now visible in the server log; surfacing it in the UI would still require a metric or an interface entry point (neither exists today).

## 3. Draft attachments get their paperclip late

**Current state.** When a draft is saved, IMAP `APPEND` does not return MIME part identifiers, so the local draft row stores `attachments` as `null` and `has_attachments` as 0 (see `persistAppendedDraft` in `apps/server/src/drafts.ts`, whose comment records the reason). The list paperclip reads the row column and the reader's attachment list reads the payload; the code does **not** derive attachment metadata at read time.

**Impact.** A just-saved draft may show no paperclip until the first Drafts sync completes, and the reader shows no attachment list. The attachment itself is unaffected: the RFC822 content `drafts.ts` appends already carries the attachment bytes; the local row only lacks the listable attachment metadata, which the first sync hydrates from the provider's copy.

**How it is handled.** We accept the temporary mismatch: showing nothing is better than a paperclip that opens an empty, non-downloadable list. The first Drafts sync fills the metadata in from the provider's copy. If an environment never syncs Drafts (for example send-only), that draft keeps the missing attachment visibility — a deliberate trade-off.

## 4. Conversation title protocol vs. older clients

**Current state.** A conversation title is first derived locally (first message, slash command and its arguments, referenced mail subjects), then refined by asking the model to prefix its final answer with a `TITLE:` line; a streaming probe strips that line from the reply, and a malformed or missing marker keeps the derived title. Only a greeting-only or topic-less first message ends up with an empty string title (intentionally: the next turn names it once there is a real topic). The server allows `title: ""`, and the current web client renders the empty title with the localised "New conversation" placeholder.

**Impact.** One cross-version edge: **an older frontend (v0.5.1) against a new server** renders the empty title as a blank heading (the old code used `title ?? placeholder`, and an empty string is not nullish); a new frontend against an older server is unaffected. Title quality depends on the model following the `TITLE:` protocol, but the conversation never depends on it being available.

**How it is handled.** The release note names the combination; upgrading the frontend removes the blank heading. Models that ignore the protocol simply fall back to the derived title, which never blocks creating, sending or searching.

## 5. Plaintext surfaces outside the database file

**Current state.** The main encryption claims (application-layer encryption of credentials, OAuth tokens and sensitive mail payloads, plus whole-file encryption of the database) cover the database file and encrypted payloads; the server and desktop still write a small number of plaintext surfaces through the file system:

- **Backup ZIP (plaintext).** `GET /api/backup` streams every message's canonical RFC822 source (re-fetched from the provider) into a ZIP of `.eml` files. Its whole purpose is a portable plaintext export, so database encryption does not cover it; anyone who can read the saved ZIP can read the mail.
- **WAL residue (no `journal_size_limit`).** `apps/server/src/db.ts` enables `journal_mode = WAL` and `secure_delete = ON` but does not set `journal_size_limit`, so the WAL file is not truncated automatically after checkpoints and keeps historical page frames. Once whole-file encryption is active those frames are **encrypted pages**, not plaintext mail; the real plaintext window is the old `-wal` / `-shm` left from *before* whole-file encryption was enabled. The migration handles it explicitly: it checkpoints (`wal_checkpoint(TRUNCATE)`), zero-overwrites the old plaintext database, deletes the old `-wal` / `-shm`, then renames the sealed copy into place (`apps/server/src/database-encryption.ts`). Conclusion: this does not change "the database file is encrypted", but backups and forensics should treat `-wal` / `-shm` together with the main file.
- **`renderer-local-store.json` (plaintext).** A renderer-preferences JSON written by the desktop main process under userData (default `%APPDATA%\Nami Mail` on Windows). Keys are `nami-mail.*`: `nami-mail.avatar.<email>` stores **sender email addresses with user-chosen avatar JPEG data URLs**, alongside locale and folder display mode. The local service does not read it and it never enters the server's encrypted store.
- **Other surfaces under the same threat model (bounded, switchable).** The data directory's `startup-request-log.jsonl` (HTTP method plus the path with the query string removed, first 60 seconds and slow requests, capped at 5000 lines); the desktop userData files `startup-log.jsonl`, `startup-timings.json`, `runtime-log.jsonl` (bounded line counts and per-message lengths; crashes and child-process console mirrors). `NAMI_MAIL_NO_STARTUP_LOG=1` disables appends (pruning still runs).

**Impact.** Another process running as the same user can read these files directly. The backup ZIP and `renderer-local-store.json` can expose mail content or sender addresses/avatars; the WAL and diagnostic logs carry no plaintext mail once whole-file encryption is active, but they are extra bytes outside the database file. This does **not** weaken the database/attachment encryption claim — it defines the boundary as "the database file plus the application-layer payloads", not the whole disk.

**How it is handled.** Accepted and enumerated: backups are user-initiated and user-located, so treat the ZIP like mail; diagnostic files are bounded and switchable; sealing `renderer-local-store.json` is queued in the encryption plan as a follow-up (the same per-purpose sealing used for the image cache). The overall boundary is described in [Privacy and local data](../PRIVACY.en.md).

## 6. Items still open from the 2026-10 review records

**Current state.** The 2026-10 review rounds recorded "found but deliberately not changed this round" items under categories. This page classifies them; it does not copy the detail:

- **The four v42 C items** (send / delivery state machine, recorded not changed): the 360-second scheduler give-up threshold depends on the default backoff ladder; startup recovery's zero threshold versus the runner's 360 seconds assumes a single process; `network_unavailable` remains in the "definitely not transmitted" list (the same code after `DATA` can be classified `failed`); and a `completed` task with an `unknown_delivery` ledger row leaves the optimistic Sent row waiting for the provider's Sent copy to claim it.
- **The six v46 E items** (need a product decision, deliberately not done): whether Agent memory is partitioned per account; the MCP trust model (signatures / allowlists / first-use confirmation); tightening CSP `img-src` (a privacy-versus-rendering trade-off for remote images in mail); the Windows ACL equivalent of `0o600`; the fallback policy for legacy databases without AAD; and dependency de-duplication.
- **The twelve v49 P2 items and three P3 items** (lower-priority Agent tool-chain findings): P2 covers MCP tool unregistration after a crash, pagination and concurrency, response-size limits, search-tool inputs and result URLs, memory eviction and ledger rows being rewritable, calendar/settings tool behaviour, the send idempotency key, the `threads.get` thread root, and truncation of oversized tool results; P3 covers missing untrusted-content marking for web results, the MCP adapter's array-enum conversion, and the `time` tool's timezone/localisation semantics.

**Where they are recorded.** The detail lives in the internal 2026-10 refactor review records (v42 §C, v46 §E, v49's P2/P3) and in the Agent tool-chain audit v49. Both are internal documents that are not published with the repository; this page is only the classified index and the citation point. Release notes will cite this page and stop restating the detail.

## 7. The end-to-end test coverage boundary

**Current state.** The default `npm run test:e2e` runs four specs (`smoke`, `interactions`, `update-footer`, `geometry`), and all of them boot the `/?demo=1` demo shell — they **do not cross the real API or database**. The real chain (renderer → Vite proxy → Fastify ↔ SQLite, including DTOs, Host validation and payload decryption) is covered separately by `e2e/real-chain.spec.ts`, run through `npm run test:e2e:real` or `npm run test:e2e:all`.

**Impact.** The mail main flow (real sync, search, send) has no browser-level coverage in the default end-to-end suite; a demo-shell regression and a real-chain regression are different evidence and cannot substitute for each other.

**How it is handled.** `test:e2e:real` starts its own isolated fixture server: API port **3199**, web port 5174, seeded database under `data/e2e-real`, a single serial worker, and `reuseExistingServer: false` — port **3199 must be free** and an already-running dev server must not be reused. Before a release, run the real chain explicitly as described in the [testing plan](testing-plan.en.md) and the [release checklist](release-checklist.en.md).

## 8. Reserved task kinds that nothing produces yet

**Current state.** The task-kind vocabulary (`TASK_KINDS` in `apps/server/src/tasks/types.ts`) lists eight kinds; runners exist for five of them — `move`, `flags`, `undo`, `send`, `snooze`. `draft-discard`, `filter` and `agent-apply` are **reserved**: drafts and filter rules stay synchronous, and Agent writes reuse the injected seams of `send` / `flags` / `move` (`apps/server/src/agent/mail-write-seams.ts`), so nothing produces those three task kinds today.

**Impact.** Normal paths never create them. The vocabulary is not a database CHECK constraint (SQLite cannot widen a CHECK without rebuilding the table), so two mechanisms compensate: `recordTask` refuses a kind outside the list before writing, and a stored kind with no registered runner is settled as `failed` with `error_code = "no_runner"` on first sighting instead of staying pending forever.

**How it is handled.** This is a reservation, not a defect; wiring up the corresponding feature registers the runner. The reasoning is recorded in the comment in `apps/server/src/tasks/wiring.ts` and in commit `e1e0b1a`.

## 9. The retained `/api/batch-jobs` compatibility alias

**Current state.** Batch operations are carried by the task layer now, and the three `/api/batch-jobs` endpoints (create `POST /api/batch-jobs`, read `GET /api/batch-jobs/:id`, undo `POST /api/batch-jobs/:id/undo`) are retained as a **compatibility alias**, living beside the read-only `GET /api/tasks` and `GET /api/tasks/:id`. Internally the alias treats the batch id as a shared root: create delegates to a task acceptance, read projects the task snapshot, undo fans out into undo tasks.

**Impact.** Two API surfaces exist at once: new code should use `/api/tasks`; the batch id remains the anchor for the renderer's poll loop and its undo toast. Understanding the difference between "one batch job" and "one task row" is the caller's responsibility.

**How it is handled.** Retaining it is deliberate: the renderer's polling and undo toast are built around the batch id, so removing it means changing the client and the end-to-end tests in the same step. The removal point is constrained by an open question in the refactor contract — after the frontend and end-to-end tests have fully moved to `/api/tasks`.

## 10. No stable / beta channel and no one-click rollback

**Current state.** Automatic updates only query the public GitHub Releases latest **stable** version (an `x.y.z` tag), skip draft and prerelease entries, and download only when the version is newer; there is no beta / stable channel selection. Rollback has no built-in channel: running an older installer is recognised as a downgrade and cancelled by default, requiring explicit confirmation to continue.

**Impact.** You cannot try a beta without changing configuration, and you cannot "roll back one version" from inside the app after a problematic update. The practical rollback is reinstalling an older version and explicitly confirming the downgrade.

**How it is handled.** This is a deliberate release trade-off: a single channel keeps publishing and trust-root handling simple and gives every user the same signed chain. Use a local build to try unreleased work; do not publish it as an update channel. See [Windows install and update guide](../INSTALLING.en.md) and [Releasing](../RELEASING.en.md) for the behaviour details.

## 11. Error logs: bounded files, no user-facing error history

**Current state.** Server logs go to standard output / standard error (pino); the application has **no user-facing error history, log viewer or export entry point**. The packaged desktop mirrors startup stages, crashes, unhandled rejections and child-process console output into **bounded** diagnostic files under userData: `startup-log.jsonl`, `startup-timings.json`, `runtime-log.jsonl` (bounded line counts and per-message lengths; `NAMI_MAIL_NO_STARTUP_LOG=1` disables appends). The data directory additionally keeps a bounded `startup-request-log.jsonl` (method plus the path with the query string removed). The release pipeline's `scripts/smoke-diagnostics.mjs` is a diagnostic writer for **installer / packaging smoke** (it redacts sensitive environment variables), not a user troubleshooting entry point.

**Impact.** The attachment backfill's `unclassified`, the FTS `skipped` list and filter-rule failures are written to the server log (some also reach the bounded files above), but the application has no user-facing viewer or export entry point. User troubleshooting relies on the interface's error messages plus the bounded files; there is no "export error logs" path, and cross-session error history is overwritten by the bounded rotation.

**How it is handled.** We accept the bounds and automatic cleanup to avoid unbounded growth and a wider privacy surface. When reporting a problem, include the interface message and, if needed, the diagnostic files under userData and the data directory; release verification uses smoke diagnostics. If a user-facing export is added later, the redaction rules must be decided in the same change.

## 12. Items left unfixed by the 2026-10-22 audit

**Current state.** The read-only audit of 2026-10-22 re-checked the implementation after the 2026-10 refactor. The items below were confirmed and deliberately left unfixed this round; fixes that did land are recorded in the CHANGELOG `[Unreleased]` section and are not repeated here.

| Severity | Location | Current state and impact | Why it is not fixed yet |
|---|---|---|---|
| P2 | `apps/web/src/App.tsx:1316-1324` | `threadExtras` / `threadStripMembersRef` keep full-row snapshots of thread members outside the list. Marking a member that exists only in extras (an older mail opened from the thread strip) as unread succeeds on the API but leaves the interface unchanged, because `store.applySeen` cannot find that row. | This is a state-ownership change; the thread-member read path first has to move back into the single store. |
| P2 | `apps/web/src/app/useAppRealtimeSync.ts:70-74`, `App.tsx:830-871` | `onTaskSettled` calls `reconcileFromEvents()` → `silentRefresh()` directly, bypassing `useCoalescedRefresh`'s "mark dirty only while the window is hidden" promise. The desktop sets `backgroundThrottling: false`, so minimising still runs four parallel requests. | The visibility priority of a task settlement versus a hidden window has to be decided first. |
| P2 | `apps/desktop/src/main.mts:2068-2075,2081,2096-2102` | The `second-instance` entries use `void (async () => …)()` (or `.then`) with no `catch`. When boot has not finished, `localServer` is still `undefined`, so no window is created and only `focusWindow()` runs: the user sees nothing happen, and the error lands only in `runtime-log.jsonl`. | Changing the Electron startup lifecycle needs real-machine verification of first launch and crash-restart orderings. |
| P2 | `apps/web/src/realtimeSync.ts:150-151,200-201,222-223` | `lastSseEventAt` is written before the frame is parsed, so a malformed frame counts as "the stream is alive" and suppresses one poll round (the interval is selectable at 30/60/180/300s). | Only cross-version combinations can trigger it, and manual reconnect is a fallback. |
| P3 | `apps/server/src/mail.ts:87-104`, `calendar.ts:255`, `message-links.ts:44`, `settings.ts:34` | Zero-call exports: `testMailboxConnection` (an older subset of `testAccountConnection`), `clearAllCalendarEvents`, `localizeLinks` and `AGENT_ACCESS_LEVELS` have no caller in the repository. | Removing them requires confirming no external script depends on them; it belongs to a cleanup batch. |
| Structural | `apps/web/src/app/mailStore.ts` | `total` is not derived from `messages`; it is a server snapshot plus five local ±1 sites (`nextMessageTotalForSnapshot`, `applyMove`, `restoreMove`, `removeMessages`, `restoreMessages`). Section 2 above now describes it as it is. | The server `total` is a full match count while the frontend holds only loaded pages, so it cannot be derived locally; changing this needs an incrementally verifiable count from the server. |
| Boundary | `apps/server/src/message-storage.ts` (`verifyEncryptedPayloads`) | The post-migration verification sweep is still fail-closed: the error names the affected row ids (up to 50), but there is no "skip and keep starting" switch. FTS and the attachment backfill skip bad rows and record `skipped` / `unclassified`, and there is no repair entry point either. | This is a deliberately retained fail-closed policy; relaxing it is a product decision. |
| Residue | `apps/server/src/sync.ts` (where `subject` is derived) | New rows no longer store the Chinese placeholder "（无主题）", but rows already in the database keep it until the next IMAP re-sync turns it into an empty subject; until then an English interface still shows Chinese text. | Rewriting historical rows needs a data migration whose cost outweighs the benefit. |
| Mitigated | `apps/server/src/database-encryption.ts` (`recoverInterruptedConversion`) | If the process crashes between zero-overwriting the main file and the rename, the next start can verify the `.encrypting` copy, adopt it and log a warn; but if the process is force-killed during the few seconds while the main file is zeroed, that session still needs a restart to recover. | Eliminating it completely needs the "rename first, destroy later" reordering, which is another batch. |

## 13. Capability boundaries of in-app attachment preview

**Current state.** The attachment preview is an explicit pipeline (see [decision 0002](decisions/0002-2026-10-attachment-preview.en.md)). The following boundaries are **deliberate** and not bugs waiting to be fixed (this entry was verified at commit `d5a4e68`):

- **No dedicated Worker or OffscreenCanvas**: decoding and rendering run on the renderer's main thread. pdf.js's own worker is reclaimed by `loadingTask.destroy()`, but there is no second thread of our own, so long decodes can still drop frames.
- **Legacy Office and specialist raster formats are never decoded**: `.doc` / `.xls` / `.ppt` (OLE compound documents) are outside the preview catalogue and get the tier C download card; HEIC / TIFF / PSD — files declared `image/*` but outside the six raster signatures — are fetched as raster and, once the header sniff fails, end as a `corrupt` error card with a download entry (`apps/web/src/attachments/decode/image.ts:180-181`). No extra decoding is attempted.
- **Media uses Chromium's native decoders only**: audio and video play in place, but there is **no Range streaming** — the whole part is fetched before it reaches a blob URL, so anything above `MAX_INPUT_BYTES.media` (32 MiB, see `apps/web/src/attachments/budget.ts`) is refused; there is **no subtitle track**; and a container or codec Chromium does not support (`avi` / `flv` / `wmv`) falls back to the download card.
- **PDF keeps exactly one page canvas**: turning a page re-renders, with no page cache; `PdfSurface.tsx` uses one scale for the whole document, so an oversized page is refused by `PAGE_PIXELS_MAX` instead of being shrunk.
- **A sheet retains only 200 rows × 50 columns**: the decoder truncates at `MAX_SHEET_ROWS` / `MAX_SHEET_COLUMNS`, so cells outside that window never enter the row arrays, and the slots of a whole workbook are additionally bounded by `MAX_SHEET_SLOTS` (beyond it the surface degrades to the download card). The renderer only drew this window before too, so nothing visible was lost; but "not in the preview" does not mean "not in the file".
- **The memory ledger is not a process memory cap**: `MemoryLease` only counts allocations this repository makes; pdf.js internals and the browser's image and media decoders are off the books (the comment in `budget.ts` says so).
- **There is no interruptible hard deadline**: a single `DOMParser.parseFromString` of a very large XML part cannot be interrupted once it starts; the Office path pre-scans element counts before parsing and enforces character ceilings after it, so `DECODE_DEADLINE_MS` is a post-hoc stop.
- **Markdown has its own downgrade line**: above `MAX_MARKDOWN_BYTES` (8 MiB, refused at ingress on the declared size) or above `MAX_MARKDOWN_BLOCKS` (4,000 top-level blocks) it degrades to download-only rather than truncated rendering (`apps/web/src/attachments/decode/markdown.ts:52-77`).
- **Filenames are handled two different ways**: the drawer's title and download name are sanitized (`sanitizeDisplayName`, `AttachmentPreviewDrawer.tsx:311-313`), while the reader's attachment card still prints the raw string (`MailReader.tsx:471-472`); the latter is a display surface this round did not change.
- **Part of it can only be verified by eye on a real machine**: jsdom has no real canvas or media decoder, so whether a PDF draws and whether a scan is complete has to be checked by opening the file; `e2e/attachment-preview.spec.ts` proves non-white pixels and page turning, but it cannot replace a human.

**Impact.** Every boundary above surfaces as a clear "downloadable / playable / readable" outcome instead of a silent blank: unopenable types get the download card, undrawable pages get a page-level error, and over-limit input is refused at ingress. The cost is that some files that could show "part of it" (a PDF with recoverable errors, for instance) must be downloaded instead.

**Current mitigation.** Accept the boundaries and state them in release notes; the real-machine acceptance items (a vector-text PDF, a 300 DPI scan, page turning and width dragging) are mandatory after any change to the preview path. To break any of them (a Worker decode, Range-streamed media, PSD decoding), write a new record following the [decision record convention](decisions/README.en.md) rather than loosening this boundary in place.

## 14. The Attachments view and the inbox attachment filter count different sets

**Current state.** The sidebar's Attachments view is account-wide and crosses every folder: its query is `messages.has_attachments = 1` plus a collapse of a message's per-folder copies by the provider's stable message identity (`remote_id_lookup`, Gmail's X-GM-MSGID) — `attachmentViewDedupeFilter` in `apps/server/src/message-filters.ts`, with the sidebar count using the same predicate in `folder-counts.ts`. The inbox toolbar's attachment filter is a purely client-side filter over the **currently loaded** inbox rows (`apps/web/src/App.tsx`); it sends no server query and never reaches outside the inbox.

**Impact.** The two numbers agree only when every attachment-carrying mail is in the inbox and loaded. A message that exists only in Trash, an archive, or a label folder makes the view larger; an inbox longer than the loaded pages makes the filter smaller. The number at the top is the current view's server total and is not filtered, so it is not the filtered count either. The two surfaces share a name but answer different questions: "which mail in this account has attachments" versus "which rows in the inbox I am looking at have attachments".

**Current mitigation.** Accept the difference instead of forcing one number: agreeing exactly would mean moving the inbox filter to the server and deciding whether the view itself is inbox-scoped — a product-rule change that needs its own review.

## Related documents

- [Privacy and local data](../PRIVACY.en.md): encryption boundary and plaintext metadata.
- [Windows install and update guide](../INSTALLING.en.md) and [Releasing](../RELEASING.en.md): updates, downgrades and release verification.
- [Email provider setup](../EMAIL-PROVIDERS.en.md): OAuth versus password sign-in.
- [Testing plan](testing-plan.en.md) and [Release checklist](release-checklist.en.md): the evidence at each layer and the manual checks before a release.

## Maintenance rules

- Verify before writing: give the source (code location or document); when something cannot be confirmed, mark it "unverified" rather than guessing.
- Do not write numbers that expire: test counts, durations and release counts belong to CI output; a number that must appear has to be labelled as a measured sample.
- Release notes, audits and troubleshooting reference this page only; duplicate descriptions elsewhere should be removed so the gaps do not scatter again.
