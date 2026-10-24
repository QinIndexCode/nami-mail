import type { DatabaseHandle } from "../db.js";

/**
 * The settlement surface: what a task's terminal status obliges the app to put
 * back.
 *
 * A task states these facts structurally: `task_items` lists the messages a
 * task names, so "does another live push still hold this id" is a join over
 * `tasks` + `task_items`. Index-backed, and with no payload JSON to validate.
 * The legacy queue answered the same questions by `json_each`-ing every live
 * payload -- with a `json_valid` guard and a MATERIALIZED CTE, because the query
 * planner is otherwise free to reorder the guard away from the function that
 * needs it. That reader is gone with the queue.
 *
 * The mailbox side is not a query at all any more. The legacy
 * `stagedMailboxes` re-read the settling row's `payload_json` and parsed it,
 * because the hook it fed only ever received the row's id; the new hook receives
 * the payload already decrypted (`TaskHooks` in `types.ts`). That also sidesteps
 * a problem that would otherwise have blocked the switch: once
 * `sealMigratedTaskPayloads` has run, a migrated row's payload is an envelope,
 * so nothing can read the staged positions out of SQL at all.
 *
 * Everything here reads only `tasks`, `task_items` and `messages`, which is why
 * it lives in the layer rather than in the modules that used to own it: those
 * modules are deleted, and the queries outlive them.
 *
 * What is deliberately NOT here: the move half of the settlement surface
 * (`pendingMoveJobIds` / `revertMoveJobFailures`). Those are column-for-column
 * ports to `task_items`, but they need the move mechanics (`moveStatements`,
 * `neverArrived`), so they travel with the `move`
 * runner that owns those mechanics rather than being duplicated here. See the
 * contract's §4.7.
 *
 * The flags rollback IS here (`revertRefusedFlagsTargets`): it is the third
 * reader of `flagsProtectedMessageIds` and the second of `mailboxesStagedBy`.
 * Only the data source differs from the legacy rollback it replaces: that one
 * re-read the settling row's `payload_json` out of SQL, this one takes the
 * payload the hook was handed, which is also the only thing that works once
 * `sealMigratedTaskPayloads` has sealed a migrated row.
 */

/**
 * Message ids that an in-flight `flags` task still names, other than the task
 * being settled.
 *
 * A `pending_flags_push` marker is the message's "the local value is not yet the
 * server's" flag, and the settlement hook clears it. It must not clear one that
 * a *newer* push also holds: that push supersedes the settling one, and clearing
 * the marker would let `flags_json` be read as the server's state while the newer
 * intent is still in flight (the legacy `CONFIRMED_FLAGS_SQL` reasoning).
 *
 * `kind = 'flags'` covers both roads into a push. The outbox road stages entries
 * and the direct road stages a patch, but after the unification in the contract's
 * §4.7 B both are one task kind with one payload shape, and both scopes are live
 * work: a single-message `flags` task holds a marker exactly as a batch one does.
 *
 * Passing no `settledTaskId` asks the question without the exclusion, which is
 * what the startup reconciliation wants (nothing is settling at boot).
 */
export function flagsProtectedMessageIds(db: DatabaseHandle, settledTaskId?: string): Set<string> {
  const rows = db
    .prepare(`
      SELECT DISTINCT item.message_id AS message_id
      FROM task_items AS item
      JOIN tasks AS task ON task.id = item.task_id
      WHERE task.kind = 'flags'
        AND task.status IN ('pending', 'running')
        AND task.id != ?
    `)
    .all(settledTaskId ?? "") as Array<{ message_id: string }>;
  return new Set(rows.map((row) => row.message_id));
}

/**
 * Clears the push markers of ids no other live push is holding.
 *
 * The "no other push" filter is applied in JS rather than in the UPDATE's WHERE
 * clause so the two callers cannot drift: `flagsProtectedMessageIds` is also what
 * the failure rollback reads (`revertRefusedFlagsTargets`), and a rollback and a
 * clear that disagreed about what "protected" means would leave a message whose
 * target was given back while its marker stayed, or the reverse.
 *
 * Returns how many markers were cleared, which is how the startup obligation
 * replay knows a pass repaired something without logging the no-op ones.
 */
export function clearConfirmedFlagsMarkers(
  db: DatabaseHandle,
  messageIds: readonly string[],
  settledTaskId?: string,
): number {
  if (!messageIds.length) return 0;
  const protectedIds = flagsProtectedMessageIds(db, settledTaskId);
  const clearable = [...new Set(messageIds)].filter((id) => !protectedIds.has(id));
  // Chunked so the statement stays well inside SQLite's host-parameter limit
  // regardless of how large the settled batch is -- the legacy limit, kept for
  // the same reason, and it is reachable: a 10k-message batch is one task.
  const chunkSize = 10_000;
  let cleared = 0;
  for (let start = 0; start < clearable.length; start += chunkSize) {
    const chunk = clearable.slice(start, start + chunkSize);
    cleared += db
      .prepare(`
        UPDATE messages SET pending_flags_push = 0
        WHERE pending_flags_push = 1 AND id IN (${chunk.map(() => "?").join(", ")})
      `)
      .run(...chunk).changes;
  }
  return cleared;
}

/**
 * Startup reconciliation: clears markers that no live push is behind.
 *
 * Exists because a build could record the `pending_flags_push` marker and the
 * push task in two separate transactions, leaving the first committed and the
 * second lost. Such a row makes sync skip that message's flags for good (the
 * marker is only ever cleared by settlement), so local and remote state diverge
 * silently until the user happens to toggle that flag again. `commitTask` records
 * both in one transaction, so this only has to repair rows a crash already left
 * behind.
 *
 * The match is per message, not per account, and it is asked without the
 * "excluding this row" clause: a push that is still queued or retrying must never
 * be disturbed, and at startup nothing is settling. Because it reads `tasks`
 * rather than a queue's payloads, a marker held by a *running* row counts too,
 * which is why the status filter names both live statuses explicitly.
 *
 * `heldByAnotherStore` used to be this function's second parameter: a seam for
 * the window in which `operation_queue` still existed and a marker could be
 * behind a live push in *either* store. The caller that knew both stores read
 * the other's held ids and handed them in, because neither store's own
 * reconciliation could see the other's and sequential calls could not compose --
 * each is defined by "no live push *here*", so the first one's survivors look
 * orphaned to the second. There is one store now, so the parameter is gone
 * (contract §9 D19) and this is a single statement again.
 *
 * Returns how many markers were cleared.
 */
export function clearOrphanedFlagsMarkers(db: DatabaseHandle): number {
  const orphaned = db
    .prepare(`
      SELECT id FROM messages
      WHERE pending_flags_push = 1
        AND NOT EXISTS (
          SELECT 1
          FROM task_items AS item
          JOIN tasks AS task ON task.id = item.task_id
          WHERE task.kind = 'flags'
            AND task.status IN ('pending', 'running')
            AND item.message_id = messages.id
        )
    `)
    .pluck()
    .all() as string[];
  // Chunked for the same reason `clearConfirmedFlagsMarkers` is: a 10k-message
  // batch is one marker set, and SQLite's host-parameter limit is not.
  const chunkSize = 10_000;
  let cleared = 0;
  for (let start = 0; start < orphaned.length; start += chunkSize) {
    const chunk = orphaned.slice(start, start + chunkSize);
    cleared += db
      .prepare(`UPDATE messages SET pending_flags_push = 0 WHERE pending_flags_push = 1 AND id IN (${chunk.map(() => "?").join(", ")})`)
      .run(...chunk).changes;
  }
  return cleared;
}

/**
 * The mailbox each id was committed in, as the push task staged it.
 *
 * A staged entry carries the position the message had when the commit applied its
 * flags, and a foreground or background move rewrites `messages.mailbox`/`uid`
 * without touching the payload. Rolling a refused delta back therefore has to ask
 * the *staging task* where the commit landed, not the message where it is now --
 * a move between the two folders would otherwise leave the origin short and hand
 * the destination a count nobody asked for.
 *
 * The map is deliberately partial. An id it does not name -- a direct caller, a
 * migrated row whose payload is the legacy `{messageId, patch}` spelling rather
 * than the `{entries}` one, an unreadable payload -- falls back to the message's
 * current mailbox at the call site, which is the behavior the legacy
 * `stagedMailboxes` documented for exactly these cases. Returning a map that
 * covered them with an invented value would be worse than leaving the fallback in
 * charge.
 */
export function mailboxesStagedBy(payload: unknown): Map<string, string> {
  const mailboxes = new Map<string, string>();
  const entries = (payload as { entries?: unknown } | null | undefined)?.entries;
  if (!Array.isArray(entries)) return mailboxes;
  for (const entry of entries as Array<{ id?: unknown; mailbox?: unknown } | null>) {
    if (typeof entry?.id === "string" && typeof entry.mailbox === "string") {
      mailboxes.set(entry.id, entry.mailbox);
    }
  }
  return mailboxes;
}

/**
 * The message ids a frozen push payload names, in payload order, de-duplicated.
 *
 * A payload that is not the frozen spelling names none: a migrated
 * `{ids|messageId, patch}` row re-accepts on every attempt
 * (`kinds/flags.ts:307-314`), so its children own the markers and this row has no
 * message of its own to protect or to give back. The legacy flags hook guarded on
 * the same thing (`Array.isArray(entries)`, `app.ts:298` against the pre-batch-4
 * revision; that hook is deleted).
 *
 * Non-string ids are dropped rather than trusted: the payload crossed a JSON
 * boundary, and `undefined` reaching a `WHERE id IN (?)` would silently match
 * nothing while looking like it matched one row.
 */
export function frozenFlagsMessageIds(payload: unknown): string[] {
  const entries = (payload as { entries?: unknown } | null | undefined)?.entries;
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  for (const entry of entries as Array<{ id?: unknown } | null>) {
    if (typeof entry?.id === "string") ids.push(entry.id);
  }
  return [...new Set(ids)];
}

/**
 * Puts back the local target of every message a push never delivered, and the
 * unread delta that went with it. Returns how many were given back.
 *
 * This is the replacement for the deleted `restoreFailedFlagsTargets`, whose
 * reasons all still hold, and one of them is why this must run *before* the
 * markers are cleared: `flags_json` is read as the server's state the moment
 * `pending_flags_push` is clear (`CONFIRMED_FLAGS_SQL`), so a target the
 * provider refused would be reported as confirmed for good -- and the
 * `WHERE pending_flags_push = 1` below would find no rows at all.
 *
 * The two exclusions are the legacy ones: a message a newer push still names
 * keeps its target (that push supersedes this one), and a row with no recorded
 * baseline keeps its target too (there is nothing trustworthy to restore it to,
 * and inventing a value is worse than leaving the optimistic one for the next
 * sync).
 *
 * No folder counter moves here any more. The rollback used to hand the unread
 * delta back to the mailbox the commit landed in (`mailboxesStagedBy`, not
 * `messages.mailbox`, so an intervening move could not leave the origin short) --
 * and that paragraph, including the net-error bound it could not escape when the
 * bit flipped twice across two mailboxes, is exactly what contract §3.6 removed:
 * the sidebar number is a COUNT over `messages`, so restoring `flags_json`
 * restores the number with it. There is no mailbox to pick and no drift to bound.
 */
export function revertRefusedFlagsTargets(db: DatabaseHandle, payload: unknown, settledTaskId: string): number {
  const ids = frozenFlagsMessageIds(payload);
  if (!ids.length) return 0;
  const protectedIds = flagsProtectedMessageIds(db, settledTaskId);
  const restorable = ids.filter((id) => !protectedIds.has(id));
  if (!restorable.length) return 0;
  let givenBack = 0;
  // Chunked so the statement stays well inside SQLite's host-parameter limit
  // regardless of how large the settled batch is. A 10k-message batch is one
  // task, so this is reachable, not defensive.
  const chunkSize = 10_000;
  for (let offset = 0; offset < restorable.length; offset += chunkSize) {
    const chunk = restorable.slice(offset, offset + chunkSize);
    const rows = db
      .prepare(`
        SELECT id, pending_flags_base_json
        FROM messages
        WHERE pending_flags_push = 1 AND id IN (${chunk.map(() => "?").join(", ")})
      `)
      .all(...chunk) as Array<{ id: string; pending_flags_base_json: string | null }>;
    for (const row of rows) {
      if (row.pending_flags_base_json === null) continue;
      db.prepare("UPDATE messages SET flags_json = ?, pending_flags_push = 0, pending_flags_base_json = NULL WHERE id = ?")
        .run(row.pending_flags_base_json, row.id);
      givenBack += 1;
    }
  }
  return givenBack;
}
