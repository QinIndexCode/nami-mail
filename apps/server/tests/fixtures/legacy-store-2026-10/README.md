# legacy-store-2026-10 — the frozen pre-batch-2 database snapshot

A real database as the **current revision's** `openDatabase` produces it, with
representative rows in all four task stores. Batch 2 absorbs
`operation_queue` + `batch_jobs`/`batch_job_messages` +
`outbound_submissions` into one `tasks` table and drops the old DDL; this
snapshot exists so the migration can be tested against a database that was
**not** reconstructed from the new code.

## How it was produced

> **This command no longer runs as of the batch-4 "delete the legacy layer"
> change.** The exporter imports `operation-queue.ts`, `batch-jobs.ts` and
> `applyPreparedFlagsInTransaction` from `flags-outbox.ts` — all three removed by
> that batch — **statically**, so Node fails at module resolution before any of
> the exporter's own guards (the "past batch 2" ones below included) can fire.
> Nothing in *this* directory changed: the snapshot stays valid, stays the
> baseline, and `legacy-store-fixture.test.ts` / `task-migration.test.ts` keep
> reading it as-is. To produce another snapshot, run the exporter from a
> pre-batch-2 revision, where those three modules still exist.

```
node node_modules/tsx/dist/cli.mjs scripts/export-legacy-store-fixture.mts
```

Run against source, not `dist`, so the schema cannot be stale. The exporter
**refuses to overwrite** these files: regenerating them from a revision that has
already changed the schema would silently turn the "legacy" snapshot into a copy
of the new one. `--force` is for deliberately replacing the baseline, and only
from a pre-batch-2 revision.

It also refuses to run **at all** once the revision is past batch 2, and refuses
even with `--force`: it opens the database and stops if `folders` has lost
`total`/`unseen`, if `operation_queue` is gone, or if a `tasks` table exists.
Past that point a run would produce a post-refactor database wearing the legacy
snapshot's name, which is the one failure this file cannot survive.

Generating it again does **not** reproduce these bytes: submission ids, RFC
message ids, attachment tokens and every AES-GCM ciphertext are random by
construction. Identify rows by property, never by id.

## The one thing the builder substitutes

The jobs and flags commits in it join their staged rows to the background FIFO
chains the moment they commit, and with no executor registered `runRow` settles
each row `failed`/"no_runner" and the retry loop then burns eight attempts of
backoff. The builder therefore registers **no-op executors** for `batch-move`
and `flags-push`, so those rows settle `completed` at once — the state a real
push or move leaves behind. Everything else is a production writer.

Five states are reached by applying the statement production applies, rather
than by waiting for production to reach it. The first four are marked `MIRRORS`
in the exporter:

| State | The statement it mirrors |
|---|---|
| A job settled (`status='completed'`, `completed_at` in the past) | the terminal half of `snapshotFromDbRow`'s lazy settle (`SET status='completed', completed_at=? WHERE id=? AND status='running'`) |
| A row claimed (`status='running'`, `attempt_count` incremented) | `operation_queue`'s `markRunning` |
| A row terminal (`completed`, or `failed` with an `error_message`) | `operation_queue`'s `markSettled` |
| A row pruned past the 24h TTL | `operation_queue`'s `pruneTerminal` |

The fifth is **not** a mirror: the give-up group below is produced by calling
`revertMoveJobFailures` itself, the function the move executor hands its
non-retryable refusals to.

Both the queue's timestamps and the prune's threshold are **ISO strings**,
because `operation_queue.completed_at` is `TEXT` and every writer in
`operation-queue.ts` binds `new Date().toISOString()`. Binding a number would
store a value and a comparison neither revision ever produces.

**Every timestamp here is relative to the export run**, so a regenerated
snapshot has different dates; the committed files are the baseline. The builder
runs on a clock fixed ten minutes behind its reference instant, which is what
lets a job be settled both *after* it was created and *in the past* — with a live
clock those two are unsatisfiable together, and the earlier output had jobs
completing a minute before they existed. The exporter now asserts against that
inversion.

**A job's terminal `updated`/`failed` are the ACCEPTANCE-TIME numbers
production inserted, not the lazily projected ones.** The projection's inputs
(`syncing`, `failed_pushes`) only reach zero with the running app's
`onOperationSettled` hook wiring, which a fixture builder does not have. For the
flags job this is exactly the point: its acceptance-time numbers carry the
deficit. Do not assert a projected total against this fixture.

## The master key

`MASTER_KEY = Buffer.alloc(32, 0x2b)` — 32 bytes of `0x2b`, and nothing else.
Every encrypted row here (`messages.encrypted_payload`,
`outbound_submissions.request_json`/`encrypted_details`,
`outbound_attachments.encrypted_metadata`) is a real envelope under that key,
so a test can read them the way the app does. It is test data, not a secret.

`accounts.encrypted_password` is the literal string `envelope-placeholder`: no
fixture path decrypts it, and a real envelope there would imply a credential
that does not exist.

## Loading it

`schema.sql` then `rows.sql` into an empty database. Both files bracket their
statements with `PRAGMA foreign_keys = OFF`, so a test must load them, then turn
foreign keys ON and check `PRAGMA foreign_key_check` — which the read-back test
does. Mirror `openDatabase`'s pragmas when opening (`secure_delete = ON`,
`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`).

Use the raw SQLite constructor, **not** `openDatabase`: `openDatabase` runs
`migrateDatabase` and would rewrite the very state under test. Anything that
boots the whole app on this file also runs the startup prunes
(`resumePending`'s 24h terminal-row sweep, and `createBatchJob`'s 15-minute job
sweep), which delete rows this snapshot deliberately keeps.

## Regenerating it is not byte-reproducible

Re-running the exporter produces different bytes while the shape stays identical.
Two causes, both intentional:

- **Every timestamp is relative to the run.** Rows are dated with offsets from a
  `now` captured when the export starts (`-26 * HOUR`, `-5 * MINUTE`, …), so on a
  regeneration all of them move together.
- **Every encrypted payload is re-sealed with a fresh AES-GCM nonce.** Payloads
  are written through the production writers and those never reuse a nonce, so
  the `nami-v1.…` strings differ every run.

`schema.sql` **is** stable — it is DDL only, so it can be compared byte-for-byte.
For `rows.sql`, compare **shape**: the read-back test
(`apps/server/tests/legacy-store-fixture.test.ts`) pins the table inventory, the
per-table row counts and every boundary row's identity, which is what a migration
can actually break. A raw diff of `rows.sql` after a regeneration is expected
churn and proves nothing either way.

## What each row is for

### The four stores

| Store | Rows |
|---|---|
| `operation_queue` | a claimed `flags-push` row; an unpushed `flags-push` row; a failed `flags-push` row; a `flags-push` row settled one minute ago (the TTL control); two completed `batch-move` rows |
| `batch_jobs` + `batch_job_messages` | a flags job carrying a deficit, its undo job, an 11-row move job over three accounts — one of them later removed, so 2 of its rows no longer resolve — a job whose account is gone, a job whose queue rows are pruned |
| `outbound_submissions` | scheduled, pending-now, unknown-delivery, failed, confirmed, attached |
| `messages.pending_*` | a stale move `intent`, two unpushed flags markers (each named by a non-terminal `flags-push` row), and one marker whose push already settled |
| `data_migrations`, `schema_meta` | five applied migration ids and `schema_version=1` — state a migration must read, not re-apply |

### Boundary rows — the states a migration can get wrong

| # | State | Where to find it |
|---|---|---|
| 1 | A `running` queue row, which must map to `pending` | `operation_queue`: the `flags-push` row with `status='running'`, `attempt_count=1` and `completed_at IS NULL`. It is a real unpushed commit on alpha's **Sent** row — a message no job moves — that was then claimed and never settled: the row a crash between the claim and the executor's return leaves behind, and what `resumePending` re-enqueues. The transpose is the point: no migration may carry "running" over as a durable task state |
| 2 | An `undo` job with `parent_id` set, plus its selection | `batch_jobs`: `kind='undo' AND parent_id IS NOT NULL`; its parent carries `undone=1` |
| 3 | A job whose stored arithmetic **does not add up**: `updated + failed < total` | `batch_jobs`: the `flags` job on alpha's inbox, `total=8, updated=2, failed=1`. Its selection partitions exactly: `fx-alpha-inbox-2` and `fx-alpha-inbox-8` had a non-empty delta (`updated`), `fx-alpha-inbox-3` — the 7a intent — was refused by `prepareLocalFlags` because it already carries a move (`failed`), and the other five had the patch **already satisfied**, so they are counted in NEITHER and are the deficit. 8 = 2 + 1 + 5. Note where the refusal lives: the flags path inserts its selection rows **without** the `failed` column, so it keeps its DDL default `0`, and `changed=0` is what marks both the refused row and the five no-ops — `batch_jobs.failed` is the only place the refusal is recorded. The exporter derives all three groups from the selection's pre-state and asserts them, so the numbers are not decoration |
| 4 | A **scheduled** send: `status='pending'` with a future `send_at` | `outbound_submissions`; the only legacy ledger row that produces a new `tasks` row. Its `due_at` must equal `Date.parse(send_at)` — **not** `CAST(strftime('%s', send_at) AS INTEGER) * 1000`, which truncates to whole seconds; every timestamp here carries `.030` and the job rows are paired to the millisecond with their queue rows (see the arithmetic traps below) |
| 5 | `status='unknown_delivery'` | `outbound_submissions`; must stay readable, and must **not** become retryable work |
| 6 | A submission **with an attachment**, plus `request_json`/`encrypted_details` | `outbound_submissions` joined to `outbound_attachment_submissions`; proves the ledger row and its foreign key come through untouched |
| 7a | A stale move `intent` | `messages`: `pending_move_state='intent'` **with** a destination and a candidate uid. The generated `effective_mailbox` keeps it in its source folder, and flags commits must refuse it |
| 7b | An unpushed local flags change | `messages`: `pending_flags_push=1` with `pending_flags_base_json` differing from `flags_json`, named by a `pending` `flags-push` row. The pending branch of `CONFIRMED_FLAGS_SQL` |
| 8a | A settled job whose selection is intact but whose queue rows are already pruned | Attribution must fall back to the selection rows' messages |
| 8b | A job that is **not attributable at all** | Its account was removed, so the cascade took its messages and its queue rows and left the job and its selection behind, every `message_id` now unresolvable. Must **not** be migrated, and must warn |
| 9 | A job stored `running` with `completed_at IS NULL` while **every queue row it staged is already terminal** | `batch_jobs`: the `undo` job. Production settles it lazily on the next read (`snapshotFromDbRow`), so this is a transient state that only a crash makes durable. A migration that treats "running" as live work would recreate a task for something already finished |
| 10 | Selection rows the move **permanently gave up on** | `batch_job_messages`: `failed=1` on `fx-beta-inbox-1` and `fx-beta-inbox-2`, two of the 11-row move job's `changed=1` rows, with their move goal cleared. Produced by `revertMoveJobFailures` itself, which is the only writer of this column — `acceptMoveJob` inserts every selection row with a literal `0` |

7a and 7b are **two rows, not one**, deliberately: `prepareLocalFlags` refuses a
row that carries a pending move, so the app never puts both markers on the same
message. A single row carrying both would be a state no code path produces — and
a migration bug could hide behind it.

8b is deliberately the **reverse** of the obvious phrasing "the selection rows
were pruned": `pruneDurableJobs` deletes `batch_job_messages` and `batch_jobs`
under the same predicate in the same call, so a surviving job row with pruned
selections is unreachable. What the shape really keys on is not *why* the job
lost its evidence but **resolvability**: it is unattributable when none of its
selection rows' `message_id`s resolves to a message any more. Removing an
account is one road to that, and the one used as the constructor here — because
`operation_queue` is the only one of the three tables carrying a foreign key to
`accounts`, removing it takes the job's queue rows AND its messages at once.
But the sync paths that delete messages (`deleteRemoteDeletionCandidate`,
`deleteFolderMessages`) and drafting do the same thing to the messages while
leaving the queue rows in place, so the same "cannot be determined" verdict is
reachable without touching any account.

### More traps in the legacy numbers

- **`batch_jobs`'s INTEGER timestamps are the same instants as the queue's ISO
  ones, to the millisecond.** `348e5861.created_at = 1792205881030` is exactly
  `Date.parse('2026-10-17T02:58:01.030Z')` — the `created_at` of every queue row
  in this file — and `348e5861.completed_at = 1792206421030` is exactly the
  `completed_at` of `60ecd3c0`, the push row that finished the job. A migration
  that converts the ISO side with `strftime('%s')*1000` moves the queue rows
  30 ms *before* the job they belong to, inventing an ordering inversion in data
  that has none. Parse the ISO strings, do not truncate them.
- **`failed` conflates two different things.** It is
  `ids.length - prepared.length`, so it counts a row `prepareLocalFlags`
  refused (a pending move) *and* a row that does not exist at all. A migration
  cannot tell them apart from the count; and a selection row with no message is
  not hypothetical, it is exactly what 8b is.
- **`batch_job_messages.changed = 0` is not "failed".** `changed` marks the
  rows whose delta was non-empty, which is the same set as `updated` — so
  `COUNT(changed = 0)` equals `total - updated`, and that is *more* than
  `failed` by the already-satisfied rows of boundary 3. Use `failed` for the
  refused-plus-missing count, and treat the remainder as "no work needed".
- **`batch_job_messages.failed` is a *different* quantity from
  `batch_jobs.failed`, under the same name.** The selection's column is the
  one-time give-up latch, written per message by `revertMoveJobFailures` when a
  move permanently fails (boundary 10). The job's column is the acceptance-time
  bucket of boundary 3. The move job here carries **`failed=1`** on the job and
  **`failed=2`** on its selection, deliberately unequal, so no migration can
  merge the two by accident. `undoMoveJob` reads the selection's column
  (`failed = 0`), never the job's.
- **A move job's acceptance-time numbers are not progress.** `acceptMoveJob`
  fixes both columns at accept time under names that mean something else later:
  `failed` counts the ids it **refused**, which is four different situations
  (no such message; an account with no target folder; a message another move
  already owns; a goal write that lost a race) collapsed into one number, and
  `updated` counts the ids already **at** their destination — a no-op, not
  work delivered, and not something the projection waits for. So the three move
  jobs here show `total 11 / updated 0 / failed 1` and `total 1 / updated 0 /
  failed 0`: the same "deficit" as boundary 3, but meaning "work accepted,
  nothing delivered yet" rather than "rows the patch had nothing to do for". A
  migration that copies `updated` into a progress column inherits both
  meanings. In this job `failed=1` is `fx-alpha-inbox-3`, the row 7a's intent
  already owned — its selection row is `changed=0`, in the same encoding the
  flags job uses for a row it had nothing to do for.
- **`pending_flags_push` is `NULL`, not `0`, on an untouched row.** The
  column is only ever written on the transition into pending, so "no pending
  push" and "a pending push was settled" are the same value; only
  `pending_flags_base_json` distinguishes them. Any predicate must use
  `COALESCE(pending_flags_push, 0)` — the projection SQL in `batch-jobs.ts`
  does, and a migration that tests `= 0` outright will miss every pending row.
  The fixture carries all three states, so the distinction is testable rather
  than asserted: **two** rows where `pending_flags_base_json` differs from
  `flags_json` (`fx-alpha-inbox-2`, 7b's, and `fx-alpha-sent-1`, boundary 1's
  claim source), **one** where the two are equal (`fx-alpha-inbox-8` — a marker
  whose push already settled, so it must NOT be re-pushed), and **twelve** with
  the column `NULL`.

### Other deliberate shapes

- **Inconsistent folder counters, and one impossible pair.** The stored
  `folders.total` disagrees with the messages the folder actually holds in
  **six folders**: `acc-alpha/Archive` 2 vs 7, `acc-alpha/INBOX` 6 vs 2,
  `acc-alpha/Sent` 3 vs 1, `acc-beta/INBOX` 0 vs 2, `acc-beta/Sent` 3 vs 0,
  `acc-beta/Trash` 1 vs 0. On top of that, `acc-beta`/INBOX carries
  `unseen=1` with `total=0` — a pair no derivation can ever produce, made
  reachable in the legacy columns by the clamped `DECREASE` plus the unclamped
  `INCREASE` (T5). The exporter applies that pair **after the last writer** and
  asserts it, because the build's own flags and move commits nudge these columns
  and the seeded value did not survive; it also prints the `total` drift it
  found, so a later seed edit cannot quietly wash the inconsistency out. Batch 3
  removes both columns, and this is the database it must be validated against.
  Note the drift the exporter *asserts* is `total` only — the `unseen` values
  here are a seeded impossible pair, not a reconciled set, and nothing in this
  fixture claims to be the truth about `unseen`.
- **`data_migrations` is not empty and `schema_meta` exists.** Five applied ids
  (`app_settings_intensity_check_0_100`, `app_settings_sound_check_v2`,
  `batch_jobs_move_kind`, `message-fts-v2`,
  `operation_queue_flags_push_kind`) and `schema_version = 1`. A migration
  must read these and **not** re-apply them; a fixture with empty bookkeeping
  would let a re-run pass as a first run.
- **A terminal queue row inside the TTL**, kept as the control that shows the 24h
  prune deleted jobE's rows by predicate rather than by a blanket delete.
- **A failed push row** (`operation_queue` `status='failed'` with an
  `error_message`). Note that **`batch_jobs.status='failed'` is unreachable**:
  the CHECK constraint allows it, but no code writes it — the only `'failed'` in
  `batch-jobs.ts` is the projection reading `operation_queue`'s. There is
  therefore no failed *job* row here, and a migration must not expect one.
- **A pre-encryption message.** `fx-alpha-inbox-4` has `encrypted_payload IS
  NULL`, `payload_version=0`, `payload_metadata_ready IS NULL`;
  `message-storage.ts`'s `legacyPayload` is its reader, and the FTS index above
  was built through it.
- **A snoozed message**, a message with attachments, a Sent row with
  `all_mail_archived=1`, and the archive row a move job's no-op branch counts as
  already-done.
- **Empty tables are still dumped on discovery.** `app_settings`, `contacts`,
  `filter_rules`, `mail_templates`, `calendar_events`, `bimi_logo_cache`,
  `outbound_attachment_drafts` and the auto-reply tables carry no rows here and
  need no entry in any list.

## What this snapshot does NOT prove

- It is a *shape* fixture, not a scale fixture: 15 messages, not 51 000. Batch
  3's 50k performance harness is a separate artifact.
- `outbound_attachments.storage_name` names a file that is **not** shipped — the
  encrypted blob lived in the builder's temp directory. Any path that tries to
  read the attachment's bytes will fail, by design.
- Nothing here proves the migration re-derives anything. It stores the legacy
  state a migration must read; what the migration does with it is the
  migration's test.
