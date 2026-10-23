## [Unreleased]

### Added

- **Attachment preview foundation (S0)**: a new `scripts/copy-pdfjs-assets.mjs` stages pdf.js's `cmaps`, `standard_fonts`, `iccs` and `wasm` assets (200 files) into `apps/web/public/pdfjs/` before `predev`/`prebuild`/`pretest` and writes a `manifest.json` with the installed version, a per-file sha256 and byte size; `npm run assets:pdfjs:check` verifies the copy without a build, and the `nami-pdfjs-assets-guard` in `apps/web/vite.config.ts` catches a direct `vite build` that bypasses the npm scripts. The twelve CSP directives and the desktop "deny permissions by default, only navigate to this app's own origin" policy move into unit-testable `apps/server/src/security/csp.ts` and `apps/desktop/src/window-hardening.mts` with no behaviour change. What it means for maintainers: the first slice of the preview rework is independently verifiable, and missing pdf.js assets fail the build instead of a runtime preview.
- **A unified task layer takes over batch operations and write paths**: a new `apps/server/src/tasks/` turns batch move, flagging, undo, sending and snoozing into durable tasks (`move`/`flags`/`undo`/`send`/`snooze`). Acceptance fixes the selection and commits the local target state in one transaction; delivery, retry, settlement and undo run in the background, and `GET /api/tasks/:id` reports progress. The old `operation_queue`, `batch_jobs` and `batch_job_messages` stores are gone, folder counts are derived, and the main `SCHEMA_VERSION` moves to 3 with the migration, then to 4 with the mailbox-generation freeze in the same batch. What it means for users: a batch action lands on click and survives a restart, and undo follows the inverse task to settlement instead of refreshing once.
- **Send returns immediately, and the message is visible locally first**: `POST /api/messages/send` now answers `202` and hands SMTP delivery to a background `send` task. The same transaction writes an optimistic local Sent row (`pending_send`), and the sync that pulls the provider's Sent copy claims that row by its HMAC `remote_id_lookup` instead of inserting a duplicate. What it means for users: the interface responds at once and the message appears in Sent without waiting for a full sync.
- **Full-database encryption at rest**: the SQLite driver is now `better-sqlite3-multiple-ciphers`; startup runs `PRAGMA key` with the DPAPI-unwrapped master key (ChaCha20-Poly1305 by default), and an existing plaintext database upgrades through checkpoint → rekey a copy → verify → swap. Image-cache content and index, and custom background images, are sealed per file, and cache names become HMAC-opaque. What it means for users: a copy of the database or cache directory no longer exposes message bodies, subjects or remote image URLs.

### Fixed

- **Mail shortcuts now follow the folder**: Trash offers Restore to inbox instead of another delete or archive; Junk offers Not spam, Archive offers Move to inbox, and Drafts/Sent omit archive. Row shortcuts, context menus, the reader and bulk actions share the same rules. Restore reuses the existing move path and rolls back on failure, stays visible in narrow windows, and can be exercised through the demo's new Trash folders.
- **A rebuilt mailbox could send queued work to a different message**: IMAP's `UIDVALIDITY` only identifies a message inside one generation, while a local message id is a hash of `(account, mailbox, uid)` and carries no generation. When a provider rebuilds a mailbox (or migrates its storage), the same uid can belong to another message while the local id stays the same; queued moves, flag pushes and undos, plus attachment downloads and inline-image reads, all acted on the cached `(mailbox, uid)` and could hit the wrong message. `task_items` now freezes `origin_uid` and `origin_uid_validity` at acceptance (`SCHEMA_VERSION` 3 → 4; migrated rows count as unproven). Move, flags and undo compare the live `UIDVALIDITY` the opened mailbox reports, under the mailbox lock: an entry that disagrees is not counted as updated, is settled as failed, and kicks a sync for that account. Downloads and inline images compare the cached `folders.uid_validity` with the live value and answer "The mailbox was rebuilt on the server; messages may have moved. Sync this mailbox and try again." A transport that reports no generation keeps the existing reading (allow), matching what sync has always done. What it means for maintainers: the generation is a fact frozen at acceptance, not something to re-guess at execution time from two values that are both "current"; for users, a rebuilt mailbox no longer lets an old task quietly edit a different message.
- **EML/attachment downloads compared a post-connect cache generation against a pre-connect message snapshot**: `mail-source.ts` and `attachments.ts` read the message, its subject or attachment metadata, then wait for the connection; only after taking the mailbox lock did they re-read `folders.uid_validity` and treat that later cache value as evidence. These paths hold no account write slot, so a background sync can rebuild the mailbox during the wait: cache and provider both become the new generation while the UID now names a different message, so the EML returns the old subject with the new body and the attachment returns the old filename with the new bytes. The message row and its mailbox generation are now read by one statement (`generationStampedMessage` in `message-storage.ts`), which SQLite serves from one snapshot; after the lock the frozen value is compared with the live `UIDVALIDITY` and a mismatch refuses, never re-reading the cache. CID inline images and forward-attachment import use the same function, so both are covered. What it means for maintainers: the evidence a download needs is the generation read *with* the message, not one read again at download time.
- **A historical task without an acceptance-time generation could still write by cache**: the previous cut made the generation a fact frozen at acceptance, but the read path still let the *current cache* vouch for a task. A flag task written before the field existed (a migrated row) carries no acceptance generation, so `flags-outbox.ts` fell back to the cache; if the mailbox was rebuilt while the task waited, cache and provider both already read the new generation, the comparison answered "same", and the STORE landed on the same uid's different message. Evidence now names its source: `current` (an immediate operation holding the account's write slot, where the cache *is* the fact) versus `accepted` (what the task froze). A missing `accepted` value is refused and never back-filled from the cache. Move batching, its per-entry fallback (which previously passed no acceptance generation at all) and undo use the same judgement; a refused entry is not counted as updated, is settled as failed, and kicks a sync. What it means for maintainers: two "current" values can never vouch for each other, and no acceptance evidence means refusal.
- **A restart reordered one account's tasks**: the per-account FIFO order lived only in the in-process promise chain, and the chain is not persisted. A process that restarted during a backoff left the waiting predecessor claimable only *after* its `next_attempt_at`, so `claimNextTask` skipped it and took the newer row first; two flag updates for the same message then landed on the provider in the wrong order and the earlier value won. The claim predicate now carries an account-level barrier: an earlier row on the same account that has already been attempted and is still waiting out its backoff blocks every row behind it, across processes, and the due sweep releases them together when the wait expires. A scheduled task that has never run (`attempt_count` 0, `due_at` in the future) does not participate, so a snooze cannot stall the queue. What it means for maintainers: the ordering constraint is database semantics now, not a promise chain that happens to still be alive.
- **A timed-out or shut-down runner could still write to the provider**: the scheduler only stopped waiting while the runner kept running, so once the account slot was released a newer task and the old execution could act on the same account, and the old execution's late write overwrote the newer result. Its progress callback could also report into a row a later attempt already owned. Each attempt now holds its own `AbortSignal` and attempt token: a timeout aborts the transport first (the IMAP connection is closed, which rejects the command on the wire), `stop()` aborts every in-flight attempt, and any `report` or progress push after the token is invalidated is dropped. A move or undo whose connection was aborted no longer treats the cancellation as the provider's permanent verdict and hands its goals back; SMTP cannot be recalled, so it keeps the `unknown_delivery` verdict reconciled by the submission ledger. What it means for maintainers: "timed out" now means "stopped", not merely "nobody is waiting any more".
- **A sparse cell reference could bypass the preview memory budget**: a 539-byte xlsx with a single cell at `r="ZZZZ1"` made the decoder grow the row array to 475,254 empty slots. Empty slots hold no text, so `MAX_OFFICE_CHARS` never saw them, and the element ceiling only counted the one cell. The decoder now retains only the 200 × 50 window the renderer shows, charges every slot to `MemoryLease` at `SHEET_SLOT_BYTES`, and bounds the slots of a whole workbook with `MAX_SHEET_SLOTS` (beyond it the surface degrades to the download card). The window constants live in `budget.ts` and are imported by the renderer, so the two halves no longer restate the numbers. What it means for maintainers: the bomb is a falsifiable case instead of something only a hand-built file reveals.
- **The production dependency gate is green again**: `dompurify` 3.4.16 → 3.4.17, `fastify` 5.12.5 → 5.12.7, `ip-address` 10.7.2 → 10.7.4 (via `imapflow → socks`). `npm audit --omit=dev --audit-level=high` goes from three findings (one critical) to zero. What it means for maintainers: CI's dependency gate is restored and a release is no longer blocked by known high-severity advisories.
- **The real-chain end-to-end fixture could not be run twice**: the seed opened the database before loading the master key, while the server seals that file on its first boot, so a second `npm run test:e2e:real` always failed in the seed step with `SQLITE_NOTADB` — leaving only the first run as evidence for the real chain. The seed and the tracking-pixel fixture now follow the runtime's order (load the key → `ensureDatabaseEncrypted` → open with the key); two consecutive runs against the same directory succeed and `test:e2e:real` passes on a rerun.
- **The Attachments view listed one message once per folder**: Gmail keeps a separate row for the same mail in Inbox, All Mail, Important, Trash and each label, and the view counted rows, so one message appeared several times (10 rows for 5 messages in this mailbox) and the sidebar badge was inflated the same way. The view and its badge now collapse a message's folder copies into one row by the provider's stable message identity (Gmail's X-GM-MSGID), preferring the Inbox copy, while an explicitly selected folder still shows that folder's own row. The remaining difference between the view (account-wide) and the inbox toolbar's client-side attachment filter (loaded inbox rows only) is recorded as known-limitations item 14.
- **The rejected message's headers in a bounce could not be previewed**: an RFC 3462 delivery status report carries the returned message's headers in a `text/rfc822-headers` part that has neither a `Content-Disposition` nor a filename. The download route rejected every nameless, disposition-less `text/*` leaf as body text, so that attachment answered 409 on every bounce and the preview read "This attachment cannot be previewed." while the download failed the same way. The route now admits `text/rfc822-headers` (other `text/*` leaves are still refused as body), with tests covering both sides. What it means for users: opening a bounce's attachment shows the returned message's headers instead of a refusal.
- **Download-button copy in attachment preview**: the PDF toolbar and the image decode-failure card reused the download-only card's whole sentence ("This format cannot be previewed in place; download it and open it locally."), which contradicts a canvas that already renders. Both now use the existing action label `mail.attachment.download` ("Download {filename}"); the download-only card keeps the sentence. What it means for users: a PDF that previews is no longer simultaneously told it cannot be previewed.
- **PDF toolbar wrapping at the narrowest drawer**: at the 320px minimum, the "Page X / Y" label and the download button each wrapped onto a second line. The toolbar no longer wraps, the page label neither wraps nor shrinks, and the filename in the download button is ellipsized (the full name stays in the button's `title` and the file heading), so the toolbar stays one 34px row at the minimum width. What it means for users: dragging the preview pane narrow no longer turns the toolbar into two rows.
- **Batch-operation consistency**: the local-first rework closes the defects behind lost final intent across entry points, queued reversals using a moved message's old mailbox/UID, failed refreshes overwritten by optimistic state, moved mail disappearing after a failed move, an older batch ending a newer one, and undo not following the inverse task. A `flags` push now re-resolves each message's current mailbox by local id, and a refused push rolls its unread delta back to the folder the commit landed in. What it means for users: overlapping and repeated reversals honour the last intent, and failures restore rows and keep a retryable selection.
- **Send and read-path outcomes**: an interrupted SMTP attempt no longer ends as failed, a later unknown-delivery write cannot overwrite `submitted`/`confirmed`, and an unconfirmed delivery tells the user to check Sent before resending. The attachment, inline-image and EML routes accept both the digest id sync derives and the local placeholder uuid, and `/api/stats` is scoped to the current account so badges match the list. What it means for users: delivery reports are trustworthy under network trouble, resending is not silent, and attachments on synced mail open.
- **Regression guards and script invariants**: `docs:claims:check` now verifies the version, external tool counts, read-only wording, suite-size and release-note claims in the documents, and the ui-stress harness notes are recalibrated to the server-side batch jobs; line ratchets are lowered to their measured values; the batch endpoint's id cap and queue recovery gained falsifiable tests. What it means for maintainers: document/code drift and one-sided boundary coverage are caught before merge.
- **Startup, recovery and observability**: an interrupted whole-store encryption conversion no longer discards the only encrypted copy — when the main file was already zeroed or removed, the staged database is verified and adopted with a warning logged; the message migration, the attachment-metadata backfill and the FTS rebuild page by rowid instead of reading the whole table into memory on the first start of a large mailbox; an undecryptable payload no longer surfaces as a bare stack trace, because the error names the affected row ids; FTS-skipped rows, filter rules that failed on a message, rows the attachment backfill could not classify and failed task resumes are recorded. What it means for users: a power cut mid-conversion no longer turns into "a brand-new empty app", and damaged mail fails the start with the affected messages named instead of in silence.
- **Front-end consistency and empty states**: a successful batch or single-message action now merges incrementally instead of resetting the loaded pages and scroll position to the first page; a missing subject renders a localized placeholder in the list, the reader and the selection announcement (the server no longer stores the Chinese "（无主题）" in the row); the reader shows a loading state while the body is in flight instead of passing the list row's truncated preview off as the message; the quick star toggle gained an in-flight guard and rolls back to the current state rather than a stale copy. What it means for users: acting on mail deep in a long list no longer jumps back to the top, an English UI no longer shows Chinese placeholders, and a preview is never mistaken for the whole message.

### Changed

- **One source of truth for attachment classification (S1)**: the classification table previously existed as four copies across the server, the web presentation layer, the file capability gate and the mail list. It now lives in the new `attachment-catalog` module of `@nami/agent-contracts` — 9 kinds, 138 extensions, audio/video family resolution and container-signature sniffing, all as pure data and pure functions. `apps/server/src/attachment-kind.ts` becomes a forwarding layer, and the web gains `apps/web/src/attachments/catalog.ts`, which derives 13 preview kinds and three tiers on top. `fileProcessor`'s image/video/audio sets stay where they are, as *model capability gates* rather than classification (formats such as HEIC/TIFF that the models cannot read remain unselectable), now covered by an invariant test that each gate is a subset of the catalog; readable text follows the new `readableTextExtensions` set, so `.mdx` is read and previewed as text, and the media row gains `.mpeg`/`.mpg`/`.ogv`. What it means for maintainers: one table to edit instead of four that drift; for users: `.mdx` attachments and `.mpg` videos stop being misclassified or shown with the wrong file type.
- **Attachment preview rebuilt on an explicit pipeline, not an iframe (S2)**: the preview no longer downloads the whole part and drops it into an `<iframe>`/`<img>`. It runs **fetch → decode → document → render**, each layer with its own budget and failure code; preview kinds grow from 5 to **13** previewKinds, audio and video play in Chromium's native player (`preload="metadata"`, never autoplay), and PDF decoding runs in strict mode (`stopAtErrors`, an `8,912,896`-pixel gate per image, a `35,651,584`-byte page canvas, and a wall-clock decode deadline). Text still truncates at 64,000 code points and keeps the old scrollbar behaviour. The drawer keeps its resizable width, Escape handling and focus return to the trigger. The same commit removes the last `<iframe>` render site and tightens the CSP to `frame-src 'none'`, `worker-src 'self'` and `media-src 'self' blob:`, and adds a scheme allowlist to top-level desktop navigation (`blob:`/`data:`/`file:`/`javascript:` are all denied). What it means for maintainers: preview kinds, budgets and failure strings each have one home, and the memory ledger plus the resource scope own every release; for users: scanned PDFs no longer render as blank pages, audio and video play in place, and unopenable formats explain themselves with a download instead of a white pane.
- **Attachment preview: documents become readable (S3)**: S2 wired images, media and PDF into the pipeline, but Word, Excel, PowerPoint, Markdown and archives still fell back to "download to view". This slice adds a home-grown ZIP reader (it parses the central directory and only the entries it needs; 200-entry, 16 MiB-per-entry and 32 MiB-total ceilings, CRC verification, extraction stops when the declared size disagrees with what inflates, and timeouts/cancellation share one `cancel → cleanup` path) plus the Office and archive decoders built on it: `w:p`/`a:p` paragraph text, worksheets restored to their column positions from `A1` references, DOCTYPE rejected and element counts pre-scanned before any XML parser runs (50,000 ceiling), and `vbaProject.bin` never read; `.md` keeps its source and goes to `react-markdown` (`skipHtml`, remote images never loaded, external clicks handed to the existing channel instead of navigating away); archives list their contents with zero extraction and hide `../` escape paths. A new injection regression test proves that `<script>`, `<img onerror>`, `javascript:` and SVG `onload` never execute and never issue a request across the Markdown, Office and SVG paths. What it means for maintainers: document decoding pulls in neither jszip nor mammoth (ESLint forbids both), and budgets and failure codes still have a single source; for users: Office documents, Markdown and archives can finally be read in place, and a hostile file at worst shows "can't preview" rather than running.
- **Attachment preview: states, copy and accessibility close out (S4)**: the preview's 14 failure codes, 13 interface states and 16 new `mail.attachment.*` strings are now pinned by tests as one table — every code is produced through its real decode path, the placeholder sets match key by key across both locales, and rendered numbers never leave a literal `{seconds}`/`{max}`. Error states announce as `role="alert"`, the loading state and the download-only card announce as `role="status"`, the resize handle carries `aria-valuemin/max/now`, the pane names itself with its own heading through `aria-labelledby` and installs no focus trap, and Escape hands focus back to the trigger. A filename is sanitized before it reaches the title or the download name. Demo mode no longer answers an attachment with a toast: it registers embedded fixture bytes and runs the same preview pipeline (a two-page PDF, a 201-entry ZIP, an SVG carrying `<script>`, a tier C PSD), and the new end-to-end cases prove that the PDF canvas really has ink and can turn to page two, an over-full archive reports a retryable error, a hostile SVG opens no dialog, and a download-only kind issues zero `/api/` requests. What it means for maintainers: states, codes and copy cannot drift apart; for users: a screen reader can read out why a preview failed, and the demo shows what previewing actually looks like.
- **Attachment preview: Gravatar goes through a same-origin proxy, and `img-src` follows (S5)**: a new `GET /api/avatars/gravatar/:hash` accepts only a 32-character lowercase hex digest and builds the upstream URL itself from a constant base (`d=404&s=96` cannot be changed by a caller), so no clear-text address appears in a request or in a log line (logs keep the first eight characters of the digest). Four gates guard the fetch: `redirect: "manual"` turns a 3xx into a rejection rather than a hop, a hard 5-second timeout, a 1 MiB ceiling enforced both by declared length and by a streamed counter that cancels the moment it is crossed, and a `content-type` that must be `image/*` and must not be `image/svg+xml`. Upstream headers are never echoed: only the bytes and a normalised type leave the route. A hit is cached for seven days as `immutable`, a 404 for an hour, and every refusal or failure is `no-store`; the blanket `/api/` `no-store` in `app.ts` is exempted for this one prefix only (`/api/images/proxy` is still covered). The `img-src` directive narrows from `'self' data: blob: https: http:` to `'self' data: blob:` — message-body images already went through `/api/images/proxy`, so https/http were dead exceptions once avatars moved. What it means for maintainers: the SSRF surface, size, timeout and cache policy live in one module with a test per branch; for users: avatars still show, but the browser no longer talks to Gravatar and the address hash no longer leaves with every opened message.
- **Attachment preview: decision record and capability boundaries (S6)**: a new decision record [0002 · A four-stage attachment preview and one budget](docs/development/decisions/0002-2026-10-attachment-preview.en.md) (Chinese and English) fixes why the `<iframe>` went away, why the classification and the budget each have a single source, why PDF runs in strict mode, why the CSP tightens only three directives, and why Gravatar moved behind a proxy — each with **what was given up**. The decision index gains one four-column row, and [known limitations](docs/development/known-limitations.en.md) gains item 13, which states what the preview deliberately does not do: no dedicated Worker, no decoding of legacy Office files or of HEIC/TIFF/PSD (the latter end as a `corrupt` error card), no Range streaming and no subtitle track for media, one page canvas per PDF, a ledger that is not a process memory cap, a `parseFromString` that cannot be interrupted, Markdown's two downgrade lines, the reader card that still prints raw filenames, and the PDF/scan items that need a human visual check. The CSP `img-src` row that S5 had already fixed is dropped from item 12. What it means for maintainers: later readers can tell, without reading the code, that these trade-offs are deliberate rather than forgotten; for users: release notes now say which formats are download-only instead of leaving a blank pane.
- **Provider seam and agent tool surface**: a new `apps/server/src/provider/` thin adapter layer injects IMAP/SMTP connections and OAuth tokens through `context.providers`, decoupling the four model adapters behind one request wrapper and one wire tool-name mapping. Agent tools gain scope checks, a declined search consent now applies only to that turn, conversation titles are derived from the first answer through a `TITLE:` probe, and provider errors keep a bounded upstream detail. What it means for maintainers: swapping transport or provider no longer touches business routes and tests can inject fakes; for users: an unauthorised cloud conversation no longer receives mail content, and failures say why.
- **Push surface and front-end state**: new SSE `task-progress`, `task-settled` and `mail-changed` events plus `GET /api/tasks`, with the mail list consolidated into a single `mailStore`. Task progress, batch actions and agent writes share one stream; the toolbar releases at acceptance, and the right rail lists work still owing a cloud delivery. What it means for users: batch and send status match the UI without long polling waits.
- **Attachment rules and reading experience**: attachment visibility now has one definition (`multipart/related` inline parts are body resources, not attachments), with a one-time metadata backfill for existing mail, and drafts report attachments without waiting for a Drafts sync. A built-in official brand-avatar catalogue now outranks BIMI and Gravatar (a matching local brand skips the external query), the workspace restores through a skeleton, file icons follow the extension, the attachment preview is resizable, and the copy button cross-fades its label. What it means for users: attachment counts, paperclips, filters and the reader stop contradicting each other, and restoring a session or reading attachments is calmer.

### Performance

- **Search, RAG and settlement stop blocking**: agent search now joins the FTS index and matches the `messages` table rather than its alias, avoiding the account-messages × index-rows product on paged queries; the RAG worker yields the event loop between claims and chunks; and pending-marker settlement clears in set-based batches, so a settlement over thousands of messages no longer monopolises the event loop. What it means for users: search, sync and list refreshes stutter less on large mailboxes.

## [0.5.1] - 2026-10-15

### Fixed

- **Windows Restart-and-Update Silent Exit (Node.js Issue #51018)**:
  - Re-architected updater background PowerShell launcher: avoided Node.js `spawn` with `detached: true`, which passes Win32 `DETACHED_PROCESS` and causes CUI console applications like PowerShell to fail ConHost initialization and exit silently with code 0 before running script logic;
  - Replaced with Windows system shell `cmd.exe /d /s /c start "" powershell.exe -WindowStyle Hidden ...`, ensuring the update helper runs in an independent console session detached from the exiting Electron parent.
- **Added NSIS In-Place Upgrade Arguments (`--updated`)**:
  - Installer execution parameters now explicitly include `@('/S', '--updated')`, strictly aligning with `installer.nsh` to prevent unexpected running-process dialog prompts and protect custom installation paths (e.g. non-default drives) from being reset.
- **Fixed Working Directory Drift on Application Relaunch**:
  - Relaunching Nami Mail after update completion now explicitly specifies `-WorkingDirectory (Split-Path -Parent $CurrentExecutablePath)`, preventing the new application process from inheriting `C:\Windows\System32` as its current working directory.
- **Added Update Failure Cache Purge & Loop Circuit-Breaker**:
  - When startup detection finds that a recorded installation did not change the running version, the updater now purges the cached archive, permanently eliminating recursive "Restart and update" prompt dialogs.

## [0.5.0] - 2026-10-13

### Added

- **Full-stack calendar**: a shared ICS parser/generator in `@nami/agent-contracts`, a server calendar domain (event CRUD, conflict validation, import modes, and calendar table persistence), and a web calendar module (ICS import modal, mail invite banner, meeting-link extraction, and a reminder pipeline); a unified `useToastQueue` replaces the previously scattered toast handling; four new notification sounds (chime, bubble, calm, ping) wired across web tones, desktop WAV generation, and the settings contract.
- **ICS import dedupe by UID**: the ICS UID is now persisted (new indexed column with migration); append-mode re-imports of the same calendar upsert in place (reported as updated), and exports emit the stored UID verbatim so round-trips match. The mail invite banner caches parsed attachment content per message + part to avoid re-downloading on every revisit; the web side pre-checks the 10 MB attachment size before downloading, and the parser enforces a 50k-line cap as a decompression-bomb guard.
- **In-progress account syncing state**: the account status gains an optional runtime `syncing` flag (an in-memory sync lock, not a DB column); while a pass is in flight the sidebar shows a live "syncing" pulsing dot and subtitle instead of lingering on the previous outcome.
- **End-to-end multimodal model support**: added independent input modality switches (images, audio, video, PDF) to agent model provider configurations, supporting end-to-end base64 and media URL payloads to OpenAI, Gemini, Anthropic, and Ollama providers; the Composer file picker dynamically adapts to the selected model's modalities, attachment chips display category icon badges, and non-multimodal models strictly fall back to plain-text mode for backward compatibility.

### Fixed

- **Design system radius tokens and visual overhaul**:
  - Restored design system radius tokens (`--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 20px`) and aligned buttons, list rows, cards, and conversation items;
  - Enforced the concentric radius principle ($R_{inner} = R_{outer} - padding$), eliminating inner corner distortion across agent marks and conversation heading marks;
  - Hid sidebar scrollbars (`scrollbar-width: none`) while preserving smooth gesture and wheel scrolling without layout jitter;
  - Eliminated legacy purple accents, standardized template icons to neutral tokens, and streamlined modal headers to clean single titles;
  - Portaled template and contact editor dialogs to the document body to escape parent dialog containment and stacking context traps;
  - Isolated agent transcript scrubber scrolling to container-level coordinates, eliminating full-window layout displacement;
  - Prevented false thinking indicators when opening completed or cancelled historical sessions;
  - Wrapped agent markdown tables in `.agent-table-wrap` for full-width layout without right-side voids;
  - Refined user skeleton screens to translucent containers with shimmering sweep animation (`0.25 ~ 0.65`) matching assistant skeletons.
- **Agent streaming resilience & tools hardening**: enhanced reader actions, stream interruption graceful degradation, tool preprocessors, and session tree scrolling protection.
- **Desktop update download pipeline stability**: pipeline owns the write lifecycle, detaches paired error listeners on backpressure drain, and commits preferences only after atomic file rename.

- **Recipient autocomplete double defect**: the lookup previously used the whole recipient field as the needle, so once a complete address had been typed the substring match never returned suggestions again; applying a suggestion rewound only to the last comma, wiping earlier recipients whenever they were separated by spaces or semicolons. The lookup now targets only the trailing token and keeps the preceding separator when applying a suggestion.
- **Agent self-heal for malformed tool JSON**: the OpenAI Chat-compatible provider no longer fails an entire turn with a non-retryable PROVIDER_ERROR when it meets a malformed arguments string, an incomplete call, or a no-argument call whose arguments member is absent; it now follows the degradation contract already used by the Anthropic and Responses providers (malformed input degrades to an empty object that validation rejects), feeding the error back to the model for a self-healing retry.
- **CI contributors workflow**: a stray line after the `run:` value in `update-contributors` broke the YAML mapping, so the scheduled workflow had been failing at startup since 7d5ca46 — replaced with a block scalar that dispatches the validation workflow and enables squash auto-merge via the gh CLI; the roadmap's stale e2e inventory was corrected as well.
- **Empty-state copy governance**: in the unified "all accounts" view every empty folder (Sent, Drafts, Junk, custom) announced itself as "Your Inbox is empty"; the snoozed view fell through to the folder branches with no copy of its own — both now show the truthful folder name and dedicated copy (both locales added).
- **The `--accent` token is now defined**: neither theme defined `--accent`, yet four call sites referenced it (toast action buttons, the provider-choice selected border/check dot, auto-reply sandbox stats emphasis, and a style fallback), all silently computing invalid values — which left the syncing status dot invisible; the token is now defined and the syncing dot uses `--info`.
- **Agent error-row visual alignment**: the agent message error row moved from a neutral gray box to the app-wide danger recipe (danger border and tint), and the revoke notice is now paired with reduced-motion support.

### Changed

- **App.tsx decomposition**: the 4355-line App.tsx was split into eight domain hooks (`useMailTranslation`, `useDesktopUpdateUi`, `useSplashDismiss`, `useBatchSelection`, `useQuickMessageActions`, `useAttachmentExports`, `useDesktopBridgeHandlers`, and `useOutboundSubmissions`) plus presentation components such as `AppDialogs` and `MailReader`, shrinking the main file to roughly 3000 lines.
- **Agent provider module extraction**: the inline tool-call extractor moved into its own `InlineToolCallExtractor` module (reusing the shared provider-common helpers), bringing the provider module back within its line budget; a always-true revoked guard in `AgentMessageRow` and a dead external-pairing props chain in `SettingsAgentSection` were removed along the way.
- **Unified test timeout ceilings**: server-side fixes for four timeout failure classes reproduced under full-core parallel runs (MCP stdio reconnect, socket-suite beforeAll hooks, backup-backpressure `vi.waitFor` polling) and web-side ceilings raised to testTimeout 15 s / hookTimeout 30 s after five per-round failures under CPU oversubscription — the ceilings only widen the pass window, no assertion is weakened, eliminating the flakes.
- **ESLint warnings zeroed out**: completed 10 `exhaustive-deps` arrays, lifted 48 type imports, and cleaned up 71 unused-variable sites.

### Dependencies

- http-cache-semantics 4.3.0 (lockfile-only bump: addresses GHSA-ch52-4w7c-c8xp; a dev-only transitive dependency via electron-builder → @electron/get, already inside the declared semver range).

### Performance

- **Mail search pagination query plan (severe)**: search pagination was planned with the messages table as the outer loop, re-running a full-text scan for every candidate mail — a product of account size and index rows. On a 4000-mail account a search matching 2% took 33.9 s, and even a 7-character term (which the trigram index could fully serve) took 5.9 s. Switching to a semantically identical cross join pins the join order so the narrow side drives: 37 ms at 2% hits, 56 ms at 15%, 93 ms at 50%, and 164 ms at 100%, with byte-identical result ordering.
- **Partial indexes for starred/unread views**: wildcard-prefix matching on the flags column could not use an index, so every list request full-scanned the account. New partial indexes keyed on account and sort columns bring cross-account starred counts from 6.4 ms to 0.2 ms and account-scoped counts from 6.4 ms to 0.1 ms.
- **Sidebar badge aggregation split**: the stats endpoint wrapped the flag predicates inside conditional aggregates, so none of the new indexes could apply and the poll full-scanned every 5 seconds. Three indexable badges were split into standalone queries; starred and snoozed now hit the new and pre-existing partial indexes respectively (the remaining two need cross-table inbox attribution and are honestly left as full scans, documented as such).
- **Image cache index write-back coalescing**: every proxy-image hit rewrote the whole index file synchronously, so one mail with many images could trigger dozens of blocking writes. Writes are now coalesced behind an in-memory dirty flag and flushed before process exit.
- **Search keystroke recomputation deprioritized**: with thousands of rows loaded, every keystroke re-ran filtering, sorting, and thread grouping. A deferred value now keeps the input echo and the request cadence unchanged while the heavy recomputation runs as a low-priority transition render.
- **Bounded calendar invite parse cache**: the parse cache had no eviction, so its ceiling was 10 MB per invite times every invite ever opened in a long-lived session. It is now bounded by 64 MB total and 512 entries, keeping the existing "attachment content is immutable, so no TTL" design.

### Fixed

- **Undefined design tokens, bulk cleanup**: several tokens were referenced in both themes but never defined, so the scheduled-send badge, calendar import badge, invite-banner tint, and Agent save-button label silently lost their styling (the dark-theme selected calendar date rendered white-on-white at 1.09:1, entirely unreadable). The tokens are now defined centrally and hard-coded colors corrected; all 37 self-tinted badges now meet 4.5:1 (previously as low as 3.63:1) and the dark-theme switch thumb went from 1.09:1 to 17.3:1. Two toothless test guards were tightened at the same time: the theme-contrast test only ever measured tokens against panel backgrounds and never against tinted backgrounds, missing all 23 failing sites; the design-token test unconditionally skipped the radius token family, which is how an undefined token slipped through.
- **Monospace token consolidation**: with 45 call sites still hard-coding the stack, the newly defined token became a 46th duplicate source of truth; all 58 sites now reference the token.
- **Mobile column-header squeeze**: on narrow viewports the fixed button group squeezed the title column to zero width, wrapping the heading vertically one character per line. The count label is now hidden while the heading ellipsizes on a single line, and the count's accessible name is preserved (hiding it outright removed it from the accessibility tree).
- **Style-size ratchet headroom**: the ratchet was set exactly equal to the measured line count (zero headroom), so any single-line change would fail. A "must keep headroom" assertion was added with a 12-line buffer.
- **Keyboard navigation for the mail list**: moving between rows previously required tabbing through every one of them (the list only handled arrow keys for its context menu), which is impractical in a long list. The standard roving-tabindex pattern is now implemented — arrow keys, Home/End, and page-scrolling keys move between rows and clamp rather than wrap (a list is not a carousel; wrapping would make the bottom of a long list unreachable downwards), Enter keeps the native button activation, and the menu still opens via Shift+F10 or the context-menu key. Because the list is virtualized the target row is often not mounted yet, so movement follows a three-stage sequence (move state → scroll using the virtualizer's index API → focus once mounted); row heights are variable, so a scroll-pixel estimate is never used. When the active row scrolls out of the window the tab stop hands off to the first mounted row, keeping the list reachable by keyboard at all times.
- **List focus-stealing fix**: the three-stage navigation above records the pending row in a ref and only focuses it once the virtual window mounts it, but nothing let a user action cancel that pending work — so after an arrow-key jump, clicking another row with the mouse would let focus be yanked back to the abandoned mail once the window scrolled on, and the next Enter or Space would act on the wrong message (reading it as unread is what marks it read). The pending focus is now dropped when focus actually lands on a different row, and when the list data is replaced wholesale — user behavior outranks queued program focus. It is deliberately *not* dropped on scroll: `scrollToIndex` itself emits a native scroll event that arrives before the focus is delivered, so cancelling there would also kill "End jumps to the last row".
- **Tighter mail-body sanitizer (defense in depth)**: sanitized markup still goes through three parse-serialize round trips (each one another chance for markup to mutate), so narrowing the reachable namespaces shrinks the attack surface. The configuration is now restricted to the HTML and SVG profiles: MathML and its mXSS payloads (`mglyph`, `annotation-xml`) are stripped wholesale, and script/`foreignObject`/`use`/`animate`/`set` are disabled inside SVG. SVG is retained because a few mails render visible text through its `<text>` element, where dropping the subtree would leave signature blocks blank. Inline images (including `cid:` and `data:` URIs) and the usual table/font/list layout capabilities are unaffected; the `target` attribute on mail links is explicitly restored. The audit also found that the `attributeName` match is case-sensitive, so `attributeName="HREF"` slipped past stripping and could rewrite a link target — those three animation tags are now explicitly forbidden. BIMI brand avatars follow a separate image-intake rule and are untouched.

### Changed

- **Server-side duplication collapsed**: a string-clipping helper was duplicated verbatim across four tool files, the stream-finalization and lease-release template was repeated in four providers, and the logout boilerplate was spread across nearly twenty sites; these now live in a shared module and dedicated helpers. Four call sites that deliberately omit the usable check to interrupt a blocking connection are preserved as-is.
- **Silent exceptions now logged**: the RAG worker's account-query failure and the backup module's fallback branch when relying on private internals previously logged nothing; both now emit warnings.
- **Pre-calendar databases could not launch**: the `uid` partial index in the schema constant ran before the migration could add the column, so any database created before 0.4.3 failed to open at all with `no such column: uid` (IF NOT EXISTS guards the index name, not an unknown column). The index moved back into the migration, matching how `has_attachments` is already handled; a new regression test audits every schema index so none can reference a column that only the migration adds.

## [0.4.3] - 2026-10-04

### Added

- Sidebar folder display mode: switch between focused (single-account view with a bottom folder list) and a multi-account tree mode (every account stays visible and folds its folders independently); the preference is stored locally. (#95, Issue #88)
- Account email address copy: added one-click copy button for account email addresses in the account management list with a smooth checkmark micro-interaction transition. (#93)
- Dual-model auto-reply configuration: independent configuration for auto-reply screening/evaluation model and reply drafting model, optimizing cost and response quality.
- Auto-reply dry-run simulator (Sandbox): zero-side-effect sandbox for testing auto-reply pipelines with custom inputs or inbox samples, displaying token savings, rule matches, LLM reasons, and drafted previews with smooth entry transitions and skeleton loading.
- Typewriter streaming animation & draft visuals: adaptive typewriter stream-in (`useTypewriter`) with a pure CSS breathing cursor, instant-reveal skip control, and `prefers-reduced-motion` support.
- Email link filtering & token compression: automatically sanitizes tracking links, Markdown links, and base64 images into compact tags prior to LLM evaluation, saving significant prompt tokens.
- Agent context budget & tool pruning: configure context window and max output settings, dynamic token budget tracking, threshold-triggered tool result pruning, and automatic multi-turn history compression.
- External connections & cross-platform IPC abstraction: clear separation of built-in MCP, exposed MCP servers, and external CLI; unified cross-platform local IPC transport layer (supporting both Windows Named Pipes and POSIX Unix Domain Sockets) with strict UID/0600 security checks.
- End-to-end performance latency metrics & telemetry: high-precision stage timings (`screeningMs`, `compactionMs`, `scopeMs`, `llmMs`, `totalMs`), compact latency capsule badges, and telemetry integration.
- Compose AI polish: refine the draft body with one click (meaning, facts, and addressee references preserved, same language) with inline undo; without a configured model the button shows an explanatory bubble, and cloud sends respect the existing content-consent gate.
- Plain-text body linkification: http/https links in plain-text emails become clickable in the reader (opened in the system browser; character-faithful, idempotent, http/https only).
- Microsoft add-account guidance: the drawer gains a "one-time setup" card (Azure registration: Mobile and desktop platform, loopback callback path, allow public client flows); when the button is unavailable the UI says so honestly and shows the steps.
- Provider tile selection indicator: after picking a non-core provider from "more providers", the collapsed strip smoothly reveals the selected tile with its check mark (transitions respect reduced-motion).
- Gmail sign-in guidance: defaults to the 16-digit app password with OAuth as an opt-in path, a direct shortcut to Google's app-passwords page, a side drawer covering the 2FA prerequisite and guided steps, and automatic whitespace stripping for credentials. (#95, Issue #86)

### Fixed

- **Agent streaming output text loss fix**: completely resolved edge cases where streaming output deltas were dropped (draining queued tail deltas) during rapid conversation switches or component re-renders.
- **Mail filter rules bugfix**: resolved condition evaluation and state synchronization anomalies in mail filter rules, ensuring automated filtering actions execute reliably.
- **Settings UI/UX & aesthetic overhaul**: removed wall-of-text static subtitles across all settings panels, switching to elegant inline hover tooltips; standardized alignment, 32px control heights, and copy checkmark feedback; modularized stylesheets; eliminated scrollbar layout shifts.
- **Add-account guidance polish**: refined account setup wizard and authentication guidance for major mail providers with standardized validation feedback.
- **Outlook / Hotmail add-account dead ends (Issue #120)**: with no OAuth client ID configured, the OAuth panel did not render at all, the action card referenced a nonexistent button, the footer submit stayed disabled forever, and the guide taught an impossible app-password path — the panel now honestly presents "not yet available in this build" plus one-time setup steps; partial outlook addresses no longer flash a misleading password field; the documented registration platform was corrected from Web to Mobile and desktop (the local callback port is dynamic, so the Web platform's exact-port match always fails).
- Duplicate conversation cards: when one message exists in both the inbox and a labeled folder, the conversation strip rendered two identical cards — now collapsed by Message-ID with the opened row always winning.
- Folder navigation: the spinner never disappeared after re-clicking the same folder (which also left the whole list translucent/unclickable and broke infinite scroll).
- Press animations knocked centered icon buttons off-center (`transform` cascade replacement); fixed the model-provider secret toggle plus two identical latent cases (translation key, account password toggle).
- Pasting iCloud app passwords in the official dashed format no longer triggers the "paste may be incomplete" warning; the Gmail FAQ no longer references a nonexistent in-app proxy setting; NetEase yeah/188/VIP users are routed to their own portals instead of mail.163.com/126.com; the QQ card label matches its target page.
- Conversation strip resilience: server thread snapshots merge instead of replacing, the reader resolves members through a strip-membership witness, and background refreshes no longer evict messages opened from conversation chips — eliminating the "click a chip, back to the list" defect. Chips gained hover explanations and a member count.
- External Agent channel: `messages search` (CLI) / `namimail_messages_search` (MCP) is available again through the Broker forwarding list.
- The contributor-list auto-update workflow resumes automatic runs now that the repository allows GitHub Actions to create pull requests.

### Changed

- Toolchain: the Node floor moves from 22.14 to 24.21 (LTS) — Electron 43 bundles Node 24.17, so CI's 22 window sat two majors behind production (which already produced one "green locally, red in CI" surprise); validation now matches the shipped runtime. The release-policy guard and the development/releasing docs move with it.
- Microsoft mailbox access is now labeled "not yet available in this build" (waiting on an embedded public client ID, see Issue #120 and the roadmap); advanced users can follow the guide for a one-time manual setup.
- The server reserves built-in public client ID constants for Google/Microsoft (environment variables win); once embedded, users sign in with zero configuration.
- Removed the automated wiki sync workflow: the default GITHUB_TOKEN cannot reach the wiki repository, so syncing is done manually with `scripts/wiki-sync.mjs`; the wiki home template gained a project overview. (#97/#98)

### Dependencies

- Security bumps: nodemailer 9.1.1 → 10.0.13 (five high advisories incl. cross-tenant SMTP credential disclosure, synced across `@nami/server` and the root manifest), dompurify 3.4.16 (DOM XSS), fastify 5.12.5, brace-expansion 5.0.12, fast-uri 3.1.8 — the production `npm audit` high-level gate is now clean.
- dompurify 3.4.15, @fastify/static 10.1.4 (with content-disposition 3.0.0), jszip 3.10.2.

## [0.4.2] - 2026-09-25

### Fixed

- **Windows NSIS Installer Custom Path Enforcement & Overwrite Bug Fix**: Fixed a critical defect where choosing a custom installation path in the wizard was silently overridden back to `%LOCALAPPDATA%\Programs\Nami Mail` on drive C:; adjusted wizard sequence so directory selection appears after install mode resolution, and enabled `allowToChangeInstallationDirectory: true`.
- **Existing Installation Path Recovery on Upgrade & Reinstall**: Fixed an issue where running the installer again or upgrading in-place failed to detect existing installations located on non-system drives; added a multi-source recovery macro (`namiRecoverExistingInstallLocation`) in the `preInit` hook to extract and normalize the true installation path from dedicated registry keys and Windows uninstall entries, with dual registration of `InstallLocation`.
- **Test & CI Stability Optimization**: Raised the `timerMaxGapMs` threshold in the desktop smoke test to 350ms for idle renderer detection, eliminating false timeout failures under heavy runner load.

### Documentation

- Added `v0.4.2` bilingual release notes; bumped website and issue template versions to 0.4.2.

## [0.4.1] - 2026-09-25

### Added

- BIMI brand avatar support: read a sender domain's published BIMI record (the `l=` of its `default._bimi` TXT record) and display the SVG brand avatar it points to, improving visual recognition of official senders; protected by strict SVG sanitization, size normalization, two-tier memory/disk caching, and TTL expiry. Resolves by domain only: it validates neither the DMARC precondition nor the `a=` authority evidence (VMC).
- Compose attachments drag-and-drop & clipboard paste: drag and drop local files directly into the compose dialog with a clear dashed drop indicator overlay; paste clipboard images into the body editor with `Ctrl+V` for instant attachment creation.

### Fixed

- Refactored agent confirmation card docking and collapse animation: applied a solid panel background (`var(--panel-solid)`) to `.agent-composer` to serve as an opaque occlusion surface, combined with `-14px` negative margin slot docking so the card bottom edge smoothly tucks behind the composer; eliminated floating edge artifacts caused by the gradient mask, removed redundant bottom borders, provided 24px bottom button safe padding, and synchronized grid row height with negative margin transitions for zero-jump dismissal.
- Suppressed redundant translation banners: detect mail body language characteristics to hide the "Translate to current language" banner when mail content already matches the client language, reducing visual clutter.
- Fixed Windows CI desktop smoke startup timeout: raised the window-loaded startup ceiling on GitHub Actions runners to avoid false alarms under heavy host load.

### Documentation

- Added `v0.4.1` bilingual release notes; bumped website and issue template versions to 0.4.1.

## [0.4.0] - 2026-09-21

### Added

- Static website and documentation site: a landing page plus docs pages built from `docs/` (deployed automatically to GitHub Pages), with an English/Chinese language switch.
- Conversation thread completion: Gmail-style threading across folders. Message records carry no thread column, so threads are grouped client-side over the loaded set first, and missing members are completed through the new `GET /api/messages/:id/thread` endpoint (a bidirectional transitive closure over RFC headers within the account, drafts excluded, yielding the event loop between rows while decrypting); threads are refetched automatically after sending.
- Quote auto-folding: top-level quoted blocks in HTML mail collapse into native clickable `<details>` elements, and trailing `> ` quote blocks collapse in plain text. Folding happens only at the render layer; sanitizing, translation, and reply-quote pipelines still use the full body.

### Fixed

- Fixed the cascade of races behind revoke-then-resend in the Agent: the server now releases the conversation slot as soon as a turn is persisted. Previously the first-turn title generation tail (up to ~two minutes on a slow provider) kept holding the slot, so every resend after a revoke was refused with CONFLICT and the optimistic message was never persisted; revoking it again reported "message not found", the UI showed two identical rows, and only re-entering the conversation recovered. The client now also adopts the server snapshot when a revoke hits "not found" (the phantom rows disappear immediately, no re-entry needed) while keeping the refilled composer text for editing and resending.
- Fixed the "banner pops up but no sound" problem with the new-mail notification sound: the main process now plays the sound first and shows the banner afterwards — the OS sound is only silenced when playback actually succeeded, any failure falls back to a system-sound notification and logs the reason to the runtime log; the playback pipeline is warmed up at startup, removing the ~1.5 s cold-start delay of the first notification; the Settings "test notification / test sound" buttons now use exactly the same pipeline as a real new-mail alert.
- Fixed the list flicker when switching account, folder, or view: the list identity now follows only the landed snapshot, in-flight old rows merely dim as a whole instead of being rebuilt.
- Fixed the direction display for mail the user sent themselves: it now renders by recipient (the reading-view avatar and main name show the first recipient, list rows show a To line with the recipient's avatar, and quick reply pre-fills the original recipient) instead of guessing the direction from the folder name; incoming mail keeps showing the sender.
- Fixed the fragile parsing in the Agent's web-search tool: it no longer depends on class names of the search result page (whose changes used to make it return zero results forever) and parses attributes and links in two steps; search activity now shows the real query and a result summary instead of generic status text (backward compatible with old records).

### Improved

- Streamlined the Settings information architecture: removed 21 redundant subtitles and condensed 11 (both locales); the select control's font size matches its open menu; added a Settings localization interaction test.
- The update notice is now a round badge in the lower-left corner: hovering expands it into a "new version x.y.z" pill (with download and dismiss), and dismissing animates out in layers; the main lower-left copy changed from "local encryption" to "data stays on this device".
- Adjusted the account folder icon semantics: junk mail is now a shield with an exclamation mark and All mail is a stacked-layers icon; fixed their vertical alignment.
- Dependency upgrades: imapflow 1.7.8 → 2.0.2 (TypeScript rewrite; upstream fixed IDLE not re-entering after a session ends on its own), react 19.3.0 (with react-dom in sync), lucide-react 1.45.0, @tanstack/react-virtual 3.14.12.

### Documentation

- Added the paired `v0.4.0` release notes; the website version display is synced.

## [0.3.0] - 2026-09-13

### Added

- Introduced the first formal External Mail v1 local interface (Windows desktop only), for paired local scripts and MCP clients while preserving local-first, default-deny, and read-only boundaries.
- Added the installer-provided `namimail` PATH shim and direct `"Nami Mail.exe" --cli <args>` invocation.
- Added `namimail service start`, `status`, and `doctor` to explicitly start or inspect the local AgentHost. Ordinary reads and MCP stdio never start a host implicitly.
- Added desktop-visible `namimail pair --profile <name>` and `namimail revoke --profile <name>` flows. First pairing fixes the current account-ID snapshot, and an account added later never enters an old profile automatically.
- Added local MCP stdio access via `namimail mcp start --profile <name>`: it supports MCP protocols `2025-03-26` and `2025-06-18` (the server echoes the client's requested version) and publishes sixteen External Mail v1 tools from `tools/list` (nine read-only plus seven bounded writes).
- External Mail v1 reads accounts, folders, message lists, message detail (single and batch), threads, and attachment metadata, and provides bounded writes: draft create/update/delete, message move (archive/trash), seen/flagged state, send, and reply. Successful data is validated by versioned strict schemas; mail bodies are bounded plain text and attachments are never exported as files.
- Added a local mail template library: manage frequently used subjects and bodies in Settings and insert one into a compose or reply with a single click.
- Added inline attachment preview: PDFs and images render in a read-only viewer; DOCX / PPTX / XLSX and common text files get a read-only text preview without exporting the original file.
- The desktop app now keeps a runtime log (`runtime-log.jsonl`): uncaught exceptions, renderer crashes, and local-service errors are written to disk (gated by `NAMI_MAIL_NO_STARTUP_LOG=1`), so it can be attached when reporting issues.
- A broken auto-reply configuration (for example a missing API key) now shows a clear warning in Settings instead of failing silently.
- The external MCP / CLI `messages move` command can now move a message to **any folder of the same account** (the `folder` argument), not only the archive and trash shortcuts; exactly one of `target` / `folder` is accepted, and the existing permission levels and confirmation flow are unchanged.
- Added external **full-text search**, `messages search` (MCP `namimail_messages_search`): search local mail (subject, sender, recipients, attachment names and body) with account, folder, subject, attachment, date-range and cursor filters, returning a bounded excerpt centred on the keyword. Results report `searchedFrom` (only the last ~90 days are searched unless a range is given) and `newestLocalAt` (how current the local copy is), so a caller can tell "no match" apart from "not synced yet"; one- and two-character keywords, which used to silently return nothing, now fall back to substring matching.

### Improved

- Added stable success/failure envelopes, error codes, account scope, and update-drain recovery semantics for scripts and MCP. The GUI main instance actively rebuilds the named-pipe Broker after an abnormal exit, avoiding a false "running but unavailable" state.
- CLI/MCP reach the running host only through a paired Windows named-pipe Broker restricted to the current user SID. A Fastify token, HTTP/TCP, SQLite, a file URI, mail credentials, or a database path cannot be reused as an integration channel.
- Retained the experimental local NLLB-200 translation. It remains prepared and triggered explicitly in the desktop reader and is not a CLI/MCP tool.
- The calendar palette and attachment icons are desaturated to match the muted semantic colours, and small labels on them now meet WCAG AA — the worst case went from 2.2:1 to ≥4.5:1 (dark theme adjusted too).
- Popover and card shadows now come from the design tokens (one level for menus/popovers/filter panels, one for cards and status bars), so they switch consistently with the theme and no longer drift between similar overlays.
- Performance: single-pass stats, newest-first sync, batched RAG backfill, and event-delegated scroll reveal.
- The local mail service now runs in its own process: SQLite sync, IMAP traffic and decryption no longer share the window's event loop, so the UI no longer freezes during mailbox sync or bulk operations.
- Keyboard accessibility: focus restore after attachment preview, title focus ring, keyboard navigation for slash/mention menus and recipient suggestions, and Shift+J/K range selection.
- Startup and runtime logs are trimmed to a fixed line count instead of growing forever.
- The Agent session lifecycle is now driven by a state machine with steadier background buffering and replay.
- Switching account, folder, view or search no longer replaces the whole list with a six-row skeleton: the current mail stays until the new list arrives and fades in then, so the list no longer shrinks, the layout no longer jumps and the reading position is kept.
- Desktop test scripts are explicitly registered and run in CI.

### Documentation

- Added the paired `v0.3.0` release notes and honestly noted: public-network auto-update acceptance from `0.2.3` to `0.3.0` is still pending, and the `0.3.0` Windows installer is not Authenticode-signed.

### Changed

- The reading pane now **fills the reading column** (as Gmail does) instead of being capped by `--measure`: the old 672px centred column squeezed provider-authored 600px-wide tables into a narrower box, and with `overflow-wrap:anywhere` on cells that broke words mid-way — which is how Apple's promo mail ended up with broken line wraps. Only **plain-text bodies**, which carry no layout of their own, keep a line-length cap (960px), and they still start at the column's left padding so their edge lines up with the subject.
- The second arm of local mail retrieval changed from **vector semantic search** to **query expansion**: when the keyword search returns nothing, the current default model expands the question into synonyms, domain terms, and cross-language variants, which are then searched against the same local index. As a result **no embedding model needs to be configured** (the "Embedding model" field is gone from Settings), and there are no vectors or cold-start rebuild costs at all; **only the user's question is sent to the model — mail bodies and excerpts never leave the machine**. The expansion call is budgeted by case (10s when the keyword index found nothing, 800ms for weak recall only): an unavailable provider, a timeout, or a malformed answer all mean "no extra terms", so retrieval falls back to keyword-only instead of breaking; repeated questions are served from a bounded cache. The `GET /api/agent/rag/verify` consistency report now includes an `expansion` counter (triggered / recovered / not recovered) to show what the arm actually earns.

### Fixed

- Fixed the first-run "translation service terms" dialog being coverable by notification and update prompts, which left its button unclickable on narrow windows: the dialog is now recognised as an open modal, so prompts step behind it (the update prompt also waits for it to close).
- Fixed the remote image proxy being redirectable into loopback/private addresses: every redirect hop is now validated and private DNS resolutions are refused, with new security tests for the module.
- Fixed database migrations leaving a half-applied schema on failure: migrations now run in a transaction and release the connection, so the database file is no longer locked.
- Fixed the Sent-folder delivery verification continuing to touch a closed local service during app shutdown.
- Fixed Agent shortcuts firing while the translation-terms or attachment-preview dialogs were open; local-service timeouts now return a dedicated error code.
- Fixed the message list scroll position not being restored after an Agent turn.
- Fixed move actions (move to trash, archive) failing instantly whenever a mailbox sync pass was running: the move now waits for the running pass to finish first (up to ~15s) and, if it still cannot take its turn, says the mailbox is syncing instead of showing an unrelated move-state message.
- Fixed optimistic state being rolled back during consecutive actions: after marking read, deleting or starring, a list refresh triggered by a *different* action finishing used to restore the rows still queued server-side (read flipping back to unread, deleted mail reappearing, stars reverting). Every optimistic change is now registered in one place that no refresh path — including paging — can overwrite.
- Fixed the list jumping folders when a bulk operation finishes: switching folders while a bulk job ran used to yank the list back to the folder the job was started in.
- Fixed mail references leaking between Agent conversations: switching conversations no longer carries over the references introduced in the previous one (they ride along in the request and are persisted with the message, so mail the user never referenced there used to be written into the record).
- Fixed a settings save that was already in flight overwriting a newer change when two options were edited back to back.
- Bulk actions (mark read/unread, star, …) now leave multi-select when they finish, instead of leaving the processed rows armed for an accidental second batch; a failed action keeps the selection so it can be retried.
- Fixed two delivery-record races: a cancelled scheduled send is no longer re-added by a slower list response, and a confirmed send no longer falls back to "sending".
- Fixed the sidebar unread count jumping back after marking mail read: the list and the counts come from the same server snapshot, but only the rows were being corrected.
- Fixed deleted contacts, templates and calendar events reappearing from an earlier cache response.
- Fixed unsaved edits in the settings dialog being overwritten by an external settings change, the desktop update progress bar moving backwards, and an Agent conversation looking idle after a failed reload while its reply was still streaming.
- Auto-reply decisions: the search box waits for a pause before querying, and switching a filter no longer briefly shows the previous filter's results.
- Agent provider / MCP server settings: refreshing the list no longer clears the form being filled in (including a typed API key), and the refresh after approving a pending reply is no longer dropped by a poll already in flight.
- Unread view: a message you just read stays in the list without being counted twice in "N unread", and "select all matching" no longer exceeds what the server can actually handle.
- Desktop new mail: the notification subscription is no longer torn down and re-created on every refresh, so mail arriving during one no longer misses its alert and toast.
- Agent: a streaming reply no longer rewinds when an earlier server snapshot arrives - switching back into a conversation and the background pickup poll now keep whichever copy of a row is further along - and a retry rejected by the server no longer carries the previous attempt's leftovers into the new reply.
- Agent: pressing Stop drops the generating state immediately instead of waiting for the server to confirm, and renaming a conversation applies instantly and rolls back if the rename fails.

## [0.2.3] - 2026-07-28

### Added

- Carried the experimental NamiMail Agent workspace from unpublished source tags into the `0.2.3` prepared release: configure an OpenAI-compatible or Ollama provider and use local lexical retrieval with citations inside an explicit account scope.
- Agent tools remain limited to reading accounts, folders, messages, threads, and attachment metadata, plus creating, editing, or deleting drafts. High-risk mail actions remain in the primary mail UI.

### Improved

- Carried forward the multi-account sidebar, themed Settings controls, and experimental user-triggered translation improvements.
- Strengthened layered Windows package, installer, and desktop smoke diagnostics. Installer smoke now keeps temporary installed-app validation in a controlled, project-owned isolated location and removes it after a successful run, so system temporary-directory differences do not mask the real failure.

### Documentation

- Added paired `v0.2.3` prepared release notes and correctly marked `v0.2.2`, `v0.2.1`, and `v0.2.0` as source tags without public Release or update assets.
- `0.2.3` does not describe local builds, CI, or generated assets as completed real online automatic-update acceptance.

## [0.2.2] - 2026-07-28 (unpublished source tag)

The `v0.2.2` Windows Release workflow stopped before creating a draft or public GitHub Release. It has no public Release, Windows installer, or update assets and must not be used as an installation or automatic-update source; its user-facing work and release fixes are carried forward by the prepared `0.2.3` release.

### Added

- Continued the experimental NamiMail Agent workspace from earlier unpublished source tags: configure an OpenAI-compatible or Ollama provider and use local lexical retrieval with citations inside an explicit account scope.
- Agent tools remain limited to reading accounts, folders, messages, threads, and attachment metadata, plus creating, editing, or deleting drafts. High-risk mail actions remain in the primary mail UI.

### Improved

- Carried forward the multi-account sidebar, themed Settings controls, and experimental user-triggered translation improvements.
- Separated the Windows package, installer, and desktop smoke supervisor budgets so a cold-start failure preserves an actionable desktop diagnostic instead of being terminated early by a parent process.

### Documentation

- Retained paired `v0.2.2` notes as the historical record for an unpublished source tag.
- This tag does not describe local builds, CI, or generated assets as completed real online automatic-update acceptance.

## [0.2.1] - 2026-07-28 (unpublished source tag)

`v0.2.1` is only a source tag. It has no public GitHub Release, Windows installer, or update assets and must not be used as an installation or automatic-update source; its user-visible work continues through the unpublished `0.2.2` source tag and is carried forward by the prepared `0.2.3` release.

### Added

- Added the experimental embedded NamiMail Agent workspace, with OpenAI-compatible or Ollama provider configuration and local lexical retrieval with citations inside an explicit account scope.
- The Agent can read accounts, folders, messages, threads, and attachment metadata, and can create, edit, or delete drafts. Provider settings are available from both Agent and Settings.

### Improved

- Refined sidebar navigation: All accounts has a distinct aggregation icon, sending status has its own status icon, and system folders use icons that reflect their actual purpose.
- Strengthened account selected, hover, and keyboard-focus states without a left-side accent strip. Account and folder regions now scroll independently when space is constrained while keeping Settings and local-encryption status reachable.
- Tightened public Agent/RAG boundaries to state the actual status of lexical retrieval, attachment-body ingestion, and external interfaces.

### Fixed

- Fixed the nested Windows release-smoke timeout race so a cold-start failure retains an actionable desktop diagnostic.
- Fixed the case where pressing `Esc` on an expanded themed select in Settings could also close the Settings dialog.

### Documentation

- Retained [v0.2.1 release notes](docs/releases/v0.2.1.en.md) as the historical record for an unpublished source tag and maintained the paired Chinese note.
- Changed download guidance to refer to the Windows `.exe` installer displayed on the Release page, avoiding confusion between local build filenames and remote asset display names.

## [0.2.0] - 2026-07-28 (unpublished)

`v0.2.0` remains only an unpublished source tag whose release validation did not complete. It has no public GitHub Release or update assets and must not be used as an installation or automatic-update source; its user-visible changes continue through the `0.2.1` and `0.2.2` source tags and are carried forward by the prepared `0.2.3` release.

## [0.1.2] - 2026-07-24

### Fixed

- Prevented Windows checkout line-ending differences from falsely marking generated locale catalogs as stale.
- Set an explicit, bounded 30-second limit for the two security migration tests that perform SQLite `VACUUM` and physical WAL checks, avoiding false timeouts on constrained Windows runners.

## [0.1.1] - 2026-07-24

### Added

- Added user-triggered message-body machine translation to the current interface language, with hide/show/copyable results and an explicit machine-translation accuracy notice.
- Added LibreTranslate-compatible translation service settings with encrypted local storage for the service address, timeout, and optional API key; saving requires a valid address, removal requires explicit confirmation, and the body is sent only after the user chooses Translate.
- Added JSON interface language packs, localization validation, and maintenance rules for paired Chinese and English public documentation.

### Improved

- Improved state presentation across Inbox, Archive, sending status, and settings to avoid unnecessary list jumps while reading unread mail.
- Improved account setup, selectable message content, verification-code extraction, and actionable network/TLS error guidance.
- Unified themed menus, selects, tooltips, and dialogs; dialogs use a translucent overlay instead of a blurred background.

### Documentation

- Added user guidance for installation from GitHub Releases, first launch, update choices, uninstallation, and Windows SmartScreen warnings.
- Added provider guidance for authentication preparation, OAuth boundaries, manual IMAP/SMTP setup, and troubleshooting.
- Added publishable [v0.1.1 release notes](docs/releases/v0.1.1.en.md), clearly separating published assets from the automatic-update path that still requires real online verification.
- Set the security policy and GitHub Issue contact path to GitHub's enabled private vulnerability reporting flow rather than an unconfigured contact address.

## [0.1.0] - 2026-07-22

- Local-first multi-account IMAP/SMTP aggregation, reading, drafts, sending, and synchronization.
- Public-client OAuth for Google and Microsoft, plus app-password and authorization-code guidance for common providers.
- Windows desktop app, local data encryption, and GitHub Release ZIP update infrastructure.
- Startup checks, update/skip/remind-later choices, ZIP integrity verification, and post-update cache cleanup.
- Open-source contribution, security, privacy, support, development, and release documentation.

See the user-facing [v0.1.0 release notes](docs/releases/v0.1.0.en.md) for the initial release details.

Release assets and the local update path still require separate real-network validation. Do not treat this entry as proof of an online automatic-update path until a public upgrade from the prior version has completed successfully.
