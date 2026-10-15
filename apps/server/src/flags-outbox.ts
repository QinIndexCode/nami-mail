/**
 * Write-behind flag updates.
 *
 * The synchronous flag path (sync-flags.ts) waits for the IMAP STORE before
 * committing the local cache, so a user action costs one provider round-trip —
 * and queues behind whatever else holds the account write slot (measured: a
 * flag toggle waiting 16s behind a batch). This module inverts the order for
 * user-initiated flag writes:
 *
 * 1. `commitLocalFlags` applies the patch to the local cache inside one
 *    transaction (single-digit milliseconds — no network, no write slot) and
 *    records a durable `flags-push` operation per account **in that same
 *    transaction**, so a marker and its push can never be committed apart.
 * 2. The operation queue drives `flags-push` in the background (FIFO per
 *    account, bounded retries), pushing the flag delta to the provider.
 *
 * Correctness:
 * - The push payload carries the delta against the remote-confirmed flag set
 *   (the local cache mirrors it until a push lands). Rows for the same account
 *   push in commit order, so chained deltas compose to the latest local state.
 * - While `messages.pending_flags_push` is set, sync must not overwrite
 *   flags_json from the stale remote (guarded at the sync write sites).
 * - Rows are durable: a crash mid-push is resumed on the next start, and the
 *   push is idempotent (STORE on an already-applied flag is a no-op).
 * - A marker left behind with no push behind it (only ever possible on a build
 *   that wrote the two in separate transactions) would block that message's
 *   flags from syncing for good, so startup reconciles them — see
 *   {@link clearOrphanedPendingFlagsMarkers}.
 */
import type { DatabaseHandle } from "./db.js";
import type { OperationQueue } from "./operation-queue.js";
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { moveActionBlockedError } from "./message-storage.js";
import { messageFlagNames, type MessageFlagsPatch } from "./message-flags.js";
export type { MessageFlagsPatch };
import { accountById } from "./account-store.js";


export type LocalFlagsCommit = {
  updated: number;
  failed: number;
  changedIds: string[];
};

type PendingRow = {
  id: string;
  account_id: string;
  mailbox: string;
  uid: number;
  flags_json: string;
  remote_id_lookup: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

export type PreparedFlagsChange = {
  message: PendingRow;
  nextFlags: string[];
  add: string[];
  remove: string[];
  seenChanged: boolean;
};

export type PreparedFlagsPatch = {
  prepared: PreparedFlagsChange[];
  blocked: string[];
};

/**
 * Reads the rows and diffs the patch against the current cache — no writes.
 * Shared by every local-first flags entry point so all of them prepare the
 * exact same delta shape. The read is chunked because a predicate selection
 * has no id cap and one IN (...) list would hit the driver's per-statement
 * variable ceiling (measured at 32 766 in this codebase).
 */
export function prepareLocalFlags(
  db: DatabaseHandle,
  messageIds: readonly string[],
  patch: MessageFlagsPatch,
): PreparedFlagsPatch {
  if (!messageIds.length || !Object.keys(patch).length) return { prepared: [], blocked: [] };
  const readChunkSize = 10_000;
  const rowsById = new Map<string, PendingRow>();
  for (let offset = 0; offset < messageIds.length; offset += readChunkSize) {
    const chunk = messageIds.slice(offset, offset + readChunkSize);
    const rows = db
      .prepare(`SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .all(...chunk) as PendingRow[];
    for (const row of rows) rowsById.set(row.id, row);
  }

  const prepared: PreparedFlagsChange[] = [];
  const blocked: string[] = [];
  const visited = new Set<string>();
  for (const id of messageIds) {
    if (visited.has(id)) continue;
    visited.add(id);
    const message = rowsById.get(id);
    if (!message) continue;
    if (moveActionBlockedError(message)) {
      blocked.push(message.id);
      continue;
    }
    const currentFlags = new Set<string>(JSON.parse(message.flags_json));
    const nextFlags = new Set(currentFlags);
    const add: string[] = [];
    const remove: string[] = [];
    for (const [field, flag] of Object.entries(messageFlagNames) as Array<[keyof MessageFlagsPatch, string]>) {
      const value = patch[field];
      if (value === undefined || currentFlags.has(flag) === value) continue;
      if (value) {
        nextFlags.add(flag);
        add.push(flag);
      } else {
        nextFlags.delete(flag);
        remove.push(flag);
      }
    }
    prepared.push({ message, nextFlags: [...nextFlags], add, remove, seenChanged: currentFlags.has("\\Seen") !== nextFlags.has("\\Seen") });
  }
  return { prepared, blocked };
}

export type AppliedFlagsCommit = {
  changedIds: string[];
  /**
   * Starters that join the staged `flags-push` rows to their per-account FIFO
   * chains. MUST be called only after the enclosing transaction commits — the
   * rows are not readable before that.
   */
  starters: Array<() => void>;
};

/**
 * The transaction-body half of a local-first flags commit: per-message
 * `flags_json`/marker writes, folder unread accounting, agent events, and the
 * durable per-account `flags-push` rows. Runs inside the caller's transaction
 * (commitLocalFlags opens its own; the batch-job materializer runs inside the
 * acceptance transaction so job, selection, and metadata commit as one).
 *
 * `maxEntriesPerPushRow` splits an account's delta across several FIFO rows
 * (each carrying at most that many entries). A predicate selection is
 * unbounded, and one row with tens of thousands of entries would turn into
 * one enormous STORE command and one enormous payload for every later
 * settlement scan; chunked rows keep each push bounded and the per-account
 * FIFO chain composes the slices in order.
 */
export function applyPreparedFlagsInTransaction(
  db: DatabaseHandle,
  prepared: readonly PreparedFlagsChange[],
  operationQueue: OperationQueue,
  agentEvents?: AgentMailEventSink,
  options: { maxEntriesPerPushRow?: number } = {},
): AppliedFlagsCommit {
  const changedIds: string[] = [];
  // Entries carry the delta against the remote-confirmed flags (the
  // pre-patch local cache), so ordered execution composes consecutive user
  // toggles to the latest local state.
  const entriesByAccount = new Map<string, Array<{ id: string; mailbox: string; uid: number; add: string[]; remove: string[] }>>();
  for (const item of prepared) {
    if (!item.add.length && !item.remove.length) continue;
    const entries = entriesByAccount.get(item.message.account_id) ?? [];
    entries.push({ id: item.message.id, mailbox: item.message.mailbox, uid: item.message.uid, add: item.add, remove: item.remove });
    entriesByAccount.set(item.message.account_id, entries);
  }
  // The lease is acquired inside the transaction so agent listeners observe
  // the committed local state immediately, mirroring the synchronous path.
  const leases = new Map<string, ReturnType<NonNullable<AgentMailEventSink>["acquireLease"]>>();
  // The push rows are recorded inside the same transaction as the markers they
  // belong to: a marker without a queued push is a permanent orphan that makes
  // sync skip this message's flags forever, so the two must commit or roll
  // back as one unit. The FIFO chain is only joined after the commit, because
  // the row is not readable before it.
  const starters: Array<() => void> = [];
  for (const item of prepared) {
    const { message } = item;
    if (!item.add.length && !item.remove.length) continue;
    // The pending baseline changes only on the TRANSITION into pending: a
    // commit that lands while an earlier push for the same row is still
    // outstanding must keep the older baseline, or the optimistic value would
    // be recorded as the server's state. SQLite evaluates every SET expression
    // against the pre-update row, so the CASE below reads the old marker.
    db.prepare(`
      UPDATE messages
      SET flags_json = ?,
          pending_flags_push = 1,
          pending_flags_base_json = CASE WHEN pending_flags_push = 1 THEN pending_flags_base_json ELSE flags_json END
      WHERE id = ?
    `).run(JSON.stringify(item.nextFlags), message.id);
    changedIds.push(message.id);
    if (item.seenChanged) {
      db.prepare(`
        UPDATE folders
        SET unseen = CASE
          WHEN ? = 1 THEN CASE WHEN unseen > 0 THEN unseen - 1 ELSE 0 END
          ELSE unseen + 1
        END
        WHERE account_id = ? AND path = ?
      `).run(item.nextFlags.includes("\\Seen") ? 1 : 0, message.account_id, message.mailbox);
    }
    if (agentEvents) {
      const lease = leases.get(message.account_id) ?? agentEvents.acquireLease(message.account_id);
      leases.set(message.account_id, lease);
      if (lease) {
        agentEvents.messageUpsertedWithinTransaction(lease, message.id, {
          mailbox: message.mailbox,
          uid: message.uid,
          remoteIdLookup: message.remote_id_lookup,
          flags: [...item.nextFlags].sort(),
          pendingMoveDestination: message.pending_move_destination,
          pendingMoveState: message.pending_move_state,
        });
      }
    }
  }
  for (const [accountId, entries] of entriesByAccount) {
    const limit = options.maxEntriesPerPushRow;
    const rowSize = limit && limit > 0 ? limit : entries.length;
    for (let offset = 0; offset < entries.length; offset += rowSize) {
      const slice = entries.slice(offset, offset + rowSize);
      starters.push(operationQueue.stageBackgroundInTransaction([accountId], "flags-push", { accountId, entries: slice }));
    }
  }
  return { changedIds, starters };
}

/**
 * Applies the patch to the local cache and queues the remote push. Throws
 * "Message not found." when none of the ids exist (the single-message route
 * maps that to its 404/422 contract); messages that are move-blocked count as
 * failed, mirroring the synchronous path's per-message semantics.
 */
export function commitLocalFlags(
  db: DatabaseHandle,
  messageIds: readonly string[],
  patch: MessageFlagsPatch,
  operationQueue: OperationQueue,
  agentEvents?: AgentMailEventSink,
): LocalFlagsCommit {
  if (!messageIds.length || !Object.keys(patch).length) return { updated: 0, failed: 0, changedIds: [] };
  const { prepared, blocked } = prepareLocalFlags(db, messageIds, patch);
  const applied = db.transaction(() => applyPreparedFlagsInTransaction(db, prepared, operationQueue, agentEvents))();
  for (const startPush of applied.starters) startPush();

  const changedSet = new Set(applied.changedIds);
  return {
    updated: prepared.length - blocked.length,
    // blocked + missing: every input id that is not a found, unblocked row
    // (rows are deduplicated by the IN read, so duplicates count as missing),
    // matching the original per-row accounting.
    failed: messageIds.length - prepared.length,
    changedIds: messageIds.filter((id) => changedSet.has(id)),
  };
}

/**
 * Clears the per-message push markers after the push has settled for good.
 *
 * The clear is per message and conditional: a message whose flag delta was
 * committed twice in quick succession (seen=true then seen=false) is named by
 * TWO `flags-push` rows. When the older row settles, the newer row may still
 * be pending — clearing unconditionally would drop the newer push's
 * protection and let the next sync overwrite the user's newest local choice
 * with stale remote state. Same-account `flags-push` rows run serially
 * (per-account FIFO chains), so at settlement time any newer push for the
 * same message is a `pending` row (queued or between retries) or a `running`
 * one (executing right now): only when NO other pending-or-running row names
 * the message is its marker cleared.
 *
 * `settledRowId` names the queue row whose settlement triggered this clear
 * (from the `onOperationSettled` hook), and is excluded from the protection
 * scan. The exclusion is already implied — the hook fires only once the row has
 * reached its terminal state, so the status filter below cannot match it — and
 * is kept so that a lone push clearing its own messages does not depend on that
 * ordering holding. Omit it (startup reconciliation, tests) to check every row.
 *
 * Callers settle this from the queue's durable-settle hook
 * (`onOperationSettled`), never from inside the executor: an executor can
 * complete late — after a write-slot timeout already settled its row — and a
 * late clear would otherwise drop a newer push's protection.
 *
 * The clear is set-based: one pass over the pending-or-running `flags-push`
 * rows materializes the message ids those rows still protect, and the callers'
 * ids are then cleared in bulk primary-key chunks. The previous form ran one
 * conditional UPDATE per message whose EXISTS re-scanned and re-parsed every
 * queue payload's entries for each message — quadratic in the batch size and
 * measured at 4.4s of event-loop stall for a 3,000-message settlement while a
 * 3,000-entry push row was still pending.
 */
function flagsPushProtectedMessageIds(db: DatabaseHandle, settledRowId?: string): Set<string> {
  // The valid-payload filter runs inside a MATERIALIZED CTE so json_each only
  // ever receives payloads json_valid has already accepted, independent of the
  // query planner's predicate order.
  const rows = db.prepare(`
    WITH push AS MATERIALIZED (
      SELECT payload_json
      FROM operation_queue
      WHERE operation_queue.kind = 'flags-push'
        AND operation_queue.id != ?
        AND operation_queue.status IN ('pending', 'running')
        AND json_valid(operation_queue.payload_json)
    )
    SELECT DISTINCT json_extract(entry.value, '$.id') AS id
    FROM push, json_each(push.payload_json, '$.entries') AS entry
  `).all(settledRowId ?? "") as Array<{ id: string | null }>;
  const ids = new Set<string>();
  for (const row of rows) if (row.id !== null) ids.add(row.id);
  return ids;
}

export function clearPendingFlagsMarkers(
  db: DatabaseHandle,
  messageIds: readonly string[],
  settledRowId?: string,
): void {
  if (!messageIds.length) return;
  const protectedIds = flagsPushProtectedMessageIds(db, settledRowId);
  const clearable = messageIds.filter((id) => !protectedIds.has(id));
  // Chunked so the statement stays well inside SQLite's host-parameter limit
  // regardless of how large the settled batch is.
  const chunkSize = 10_000;
  for (let start = 0; start < clearable.length; start += chunkSize) {
    const chunk = clearable.slice(start, start + chunkSize);
    db.prepare(`
      UPDATE messages SET pending_flags_push = 0
      WHERE pending_flags_push = 1 AND id IN (${chunk.map(() => "?").join(", ")})
    `).run(...chunk);
  }
}

/**
 * Startup reconciliation for markers with no push behind them. Builds that
 * recorded the `pending_flags_push` marker and the `flags-push` queue row in
 * two separate transactions could leave the first committed and the second
 * lost; such a row makes sync skip this message's flags for good (the marker
 * is only ever cleared by the queue's settlement hooks), so local and remote
 * state diverge silently until the user happens to toggle that flag again.
 * `commitLocalFlags` now records both in one transaction, so this only has to
 * repair rows a crash already left behind.
 *
 * The match is per message, not per account: a message is only cleared when
 * *no* pending or running `flags-push` row names it in its entries, so a push
 * that is still queued or retrying for the same account is never disturbed.
 * The queue rows are read as they stand on disk at this point (before
 * `resumePending` changes any status), so a row that is pending now and
 * running later is still seen as pending. Returns how many markers were
 * cleared.
 */
export function clearOrphanedPendingFlagsMarkers(db: DatabaseHandle): number {
  const cleared = db.prepare(`
    UPDATE messages SET pending_flags_push = 0
    WHERE pending_flags_push = 1
      AND NOT EXISTS (
        SELECT 1
        FROM operation_queue
        WHERE operation_queue.kind = 'flags-push'
          AND operation_queue.status IN ('pending', 'running')
          AND json_valid(operation_queue.payload_json)
          AND EXISTS (
            SELECT 1
            FROM json_each(operation_queue.payload_json, '$.entries') AS entry
            WHERE json_extract(entry.value, '$.id') = messages.id
          )
      )
  `).run();
  return cleared.changes;
}

export type FlagsPushDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  accessTokenProvider?: AccountAccessTokenProvider;
};

export type FlagsPushEntry = {
  id: string;
  mailbox: string;
  uid: number;
  add: string[];
  remove: string[];
};

/**
 * Resolves each id's CURRENT position from the local cache. A `flags-push` row
 * is staged with the position the message had at commit time; a foreground
 * move can rewrite `mailbox`/`uid` before the row runs, and STOREing at the
 * stale UID would either miss the message or, worse, hit whichever message
 * inherited that UID in the old mailbox. The stable local message id is the
 * only position-independent handle, so the executor re-resolves from it.
 * Chunked like every other id-list read (the driver's variable ceiling).
 */
function currentPositions(db: DatabaseHandle, ids: readonly string[]): Map<string, { mailbox: string; uid: number }> {
  const chunkSize = 10_000;
  const unique = [...new Set(ids)];
  const positions = new Map<string, { mailbox: string; uid: number }>();
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const rows = db
      .prepare(`SELECT id, mailbox, uid FROM messages WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .all(...chunk) as Array<{ id: string; mailbox: string; uid: number }>;
    for (const row of rows) positions.set(row.id, { mailbox: row.mailbox, uid: row.uid });
  }
  return positions;
}

/**
 * Rolls a permanently failed push's local target back to the value the server
 * was known to hold before it.
 *
 * The settlement hook clears the push marker whether the provider took the
 * delta or the queue gave up on it, and once the marker is clear `flags_json`
 * IS read as the server's state (see CONFIRMED_FLAGS_SQL). A refused target
 * left in place would therefore be reported as confirmed for good: the badge
 * and every later selection would treat a write the server never accepted as
 * fact, and nothing would ever correct it.
 *
 * Messages that a newer push still names keep their target — that push
 * supersedes this one, and rolling back would overwrite the newer intent.
 * Legacy rows without a recorded baseline keep their target too: there is
 * nothing trustworthy to restore them to, and inventing a value would be worse
 * than leaving the optimistic one for the next sync to correct.
 */
export function restoreFailedFlagsTargets(db: DatabaseHandle, messageIds: readonly string[], settledRowId: string): void {
  const unique = [...new Set(messageIds)];
  if (!unique.length) return;
  const protectedIds = flagsPushProtectedMessageIds(db, settledRowId);
  const restorable = unique.filter((id) => !protectedIds.has(id));
  const chunkSize = 10_000;
  for (let offset = 0; offset < restorable.length; offset += chunkSize) {
    const chunk = restorable.slice(offset, offset + chunkSize);
    const rows = db
      .prepare(`
        SELECT id, account_id, mailbox, flags_json, pending_flags_base_json
        FROM messages
        WHERE pending_flags_push = 1 AND id IN (${chunk.map(() => "?").join(", ")})
      `)
      .all(...chunk) as Array<{ id: string; account_id: string; mailbox: string; flags_json: string; pending_flags_base_json: string | null }>;
    for (const row of rows) {
      if (row.pending_flags_base_json === null) continue;
      const target = JSON.parse(row.flags_json) as string[];
      const restored = JSON.parse(row.pending_flags_base_json) as string[];
      db.prepare("UPDATE messages SET flags_json = ?, pending_flags_push = 0, pending_flags_base_json = NULL WHERE id = ?")
        .run(row.pending_flags_base_json, row.id);
      // The commit moved the folder's unread count optimistically; rolling the
      // target back has to move it back the same way, mirroring the statement
      // in applyPreparedFlagsInTransaction (its argument is "is seen now").
      //
      // Known bound: the delta is reversed on the row's CURRENT mailbox. A row
      // moved after the commit that applied the delta carries no record of
      // where that was, so the correction lands on the destination folder and
      // the origin stays decremented — two badges off until the next sync
      // upserts folder counts from the provider. Reversing exactly needs the
      // per-flip history the metadata phase is meant to record, not one more
      // column: the counters move on every flip, not only on the first.
      if (target.includes("\\Seen") !== restored.includes("\\Seen")) {
        db.prepare(`
          UPDATE folders
          SET unseen = CASE
            WHEN ? = 1 THEN CASE WHEN unseen > 0 THEN unseen - 1 ELSE 0 END
            ELSE unseen + 1
          END
          WHERE account_id = ? AND path = ?
        `).run(restored.includes("\\Seen") ? 1 : 0, row.account_id, row.mailbox);
      }
    }
  }
}

/**
 * The `flags-push` executor: pushes committed local deltas to the provider
 * with one IMAP connection per account and one STORE per (mailbox, flag-group).
 * Entries carry the delta as staged and are re-positioned by message id at
 * execution time; an entry whose message is gone from the cache is dropped
 * (there is nothing left to push). Throws on provider failure so the queue
 * retries; markers are cleared by the caller only when the push has settled
 * (success or permanent failure).
 */
export async function pushFlagsRemote(
  deps: FlagsPushDeps,
  payload: { accountId: string; entries: FlagsPushEntry[] },
): Promise<void> {
  const account = accountById(deps.db, payload.accountId);
  if (!account) throw new Error("Account not found.");
  const positions = currentPositions(deps.db, payload.entries.map((entry) => entry.id));
  const client = await imapClientForAccount(account, deps.masterKey, deps.accessTokenProvider);
  try {
    await client.connect();
    const byMailbox = new Map<string, FlagsPushEntry[]>();
    for (const entry of payload.entries) {
      const position = positions.get(entry.id);
      if (!position) continue;
      const group = byMailbox.get(position.mailbox) ?? [];
      group.push({ ...entry, mailbox: position.mailbox, uid: position.uid });
      byMailbox.set(position.mailbox, group);
    }
    for (const [mailbox, entries] of byMailbox) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const byFlagGroup = new Map<string, { add: string[]; remove: string[]; uids: number[] }>();
        for (const entry of entries) {
          const key = `${entry.add.join(",")}\u0000${entry.remove.join(",")}`;
          let group = byFlagGroup.get(key);
          if (!group) {
            group = { add: entry.add, remove: entry.remove, uids: [] };
            byFlagGroup.set(key, group);
          }
          group.uids.push(entry.uid);
        }
        for (const group of byFlagGroup.values()) {
          if (group.add.length) {
            const added = await client.messageFlagsAdd(group.uids, group.add, { uid: true });
            if (added === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
          }
          if (group.remove.length) {
            const removed = await client.messageFlagsRemove(group.uids, group.remove, { uid: true });
            if (removed === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await safeLogout(client);
  }
}
