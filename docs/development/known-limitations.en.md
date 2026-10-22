# Known Limitations

[简体中文](known-limitations.zh-CN.md) | [English](known-limitations.en.md)

This page collects Nami Mail's **verified capability boundaries and deliberate trade-offs** in one place. Each entry states the evidence (a code location or a document), what it affects, and how it is handled today or why we accept it. It is not a roadmap — no dates are promised — and it is not a bug list; report reproducible defects through GitHub Issues. Release notes, audits and troubleshooting all reference this page instead of restating the gaps.

Verified against the working tree of 2026-10-22 (commit `4913d67`). Re-check the relevant entry when the code changes.

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

## 1. Outlook / Hotmail sign-in is limited (issue #120)

**Current state.** Microsoft has retired basic IMAP/SMTP password authentication for Outlook.com / Hotmail and requires OAuth2. Official builds ship an empty built-in Microsoft OAuth client ID (`builtinMicrosoftOAuthClientId = ""` in `apps/server/src/config.ts`) and do not bundle an Azure app registration, so on a clean install "Sign in with Microsoft" cannot complete as-is; the limitation is tracked as GitHub issue #120. Enterprise or school tenant administrators may additionally disable IMAP by policy.

**Impact.** Outlook / Hotmail accounts cannot be added with a plain password; the provider rejects the password. Organisation accounts may still fail under OAuth when an administrator blocks IMAP or the OAuth app.

**How it is handled.** To sign in with a Microsoft account, set `NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID` in `%APPDATA%\Nami Mail\nami-mail.env` (a one-time Azure app registration; the "Google and Microsoft OAuth" section of [Email provider setup](../EMAIL-PROVIDERS.en.md) has the steps). Registering an official Azure app and bundling its client ID is planned; until then, use another mail provider. Subscription type and administrator policy differences also need to be confirmed with the relevant administrator.

## 2. Attachment-metadata backfill costs the first start

**Current state.** After attachment visibility was unified to "a part counts only when it is not `multipart/related`", older databases need `has_attachments` and `attachment_kinds_json` recomputed once. `ensureAttachmentMetadata` in `apps/server/src/message-storage.ts` runs synchronously inside `buildApp`'s startup sequence: it reads the whole table, decrypts each message payload, recomputes both columns, and records a `data_migrations` marker (`attachment-metadata-v1`). A row whose payload cannot be decrypted keeps its previous values and does not block startup.

**Impact.** A one-time startup stall whose cost scales with message count and payload size. Measured sample on this machine: a main database file of about 637 MB (measured 2026-10; the whole data directory is about 772 MB including end-to-end fixtures; both vary with mailbox size). Once the backfill completes, later starts see the marker and skip it — the marker is written even when some payloads stay unreadable, because otherwise every start would have to decrypt the whole table for them. **There is still no externally visible counter**: the function returns `{ backfilled, unclassified }` (`unclassified` counts the rows whose payload could not be read and therefore kept their previous flags), but the startup call site does not record that return value, and `/api/stats` exposes only accounts/messages/unread/starred/snoozed/attachments — no backfill progress or count.

**How it is handled.** We accept the one-time cost; expect a longer first start for a large mailbox. Startup duration is the observable signal. A non-zero `unclassified` means some rows can never be classified (usually a master key that does not match the database); surfacing it in the UI or logs would require adding logging or a metric first (none exists today).

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

**Impact.** User troubleshooting relies on the interface's error messages plus the bounded files above; there is no "export error logs" path, and cross-session error history is overwritten by the bounded rotation.

**How it is handled.** We accept the bounds and automatic cleanup to avoid unbounded growth and a wider privacy surface. When reporting a problem, include the interface message and, if needed, the diagnostic files under userData and the data directory; release verification uses smoke diagnostics. If a user-facing export is added later, the redaction rules must be decided in the same change.

## Related documents

- [Privacy and local data](../PRIVACY.en.md): encryption boundary and plaintext metadata.
- [Windows install and update guide](../INSTALLING.en.md) and [Releasing](../RELEASING.en.md): updates, downgrades and release verification.
- [Email provider setup](../EMAIL-PROVIDERS.en.md): OAuth versus password sign-in.
- [Testing plan](testing-plan.en.md) and [Release checklist](release-checklist.en.md): the evidence at each layer and the manual checks before a release.

## Maintenance rules

- Verify before writing: give the source (code location or document); when something cannot be confirmed, mark it "unverified" rather than guessing.
- Do not write numbers that expire: test counts, durations and release counts belong to CI output; a number that must appear has to be labelled as a measured sample.
- Release notes, audits and troubleshooting reference this page only; duplicate descriptions elsewhere should be removed so the gaps do not scatter again.
