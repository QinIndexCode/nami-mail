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
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id IN (${placeholders})`)
    .all(...messageIds) as PendingRow[];

  type PreparedMessage = {
    message: PendingRow;
    nextFlags: string[];
    add: string[];
    remove: string[];
    seenChanged: boolean;
  };
  const prepared: PreparedMessage[] = [];
  const blocked: string[] = [];
  for (const message of rows) {
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

  const changedIds: string[] = [];
  // One durable push row per account. Entries carry the delta against the
  // remote-confirmed flags (the pre-patch local cache), so ordered execution
  // composes consecutive user toggles to the latest local state.
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
  const startPushes: Array<() => void> = [];
  db.transaction(() => {
    for (const item of prepared) {
      const { message } = item;
      if (!item.add.length && !item.remove.length) continue;
      db.prepare("UPDATE messages SET flags_json = ?, pending_flags_push = 1 WHERE id = ?")
        .run(JSON.stringify(item.nextFlags), message.id);
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
      startPushes.push(operationQueue.stageBackgroundInTransaction([accountId], "flags-push", { accountId, entries }));
    }
  })();
  for (const startPush of startPushes) startPush();

  const failed = blocked.length + (messageIds.length - rows.length);
  const changedSet = new Set(changedIds);
  return {
    updated: rows.length - blocked.length,
    failed,
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
 * same message is exactly a `pending` row: only when NO pending row names the
 * message is its marker cleared. A push's own row is `running` (never
 * `pending`) while it settles, so self-references do not block the clear.
 */
export function clearPendingFlagsMarkers(db: DatabaseHandle, messageIds: readonly string[]): void {
  const update = db.prepare(`
    UPDATE messages SET pending_flags_push = 0
    WHERE id = ? AND pending_flags_push = 1
      AND NOT EXISTS (
        SELECT 1
        FROM operation_queue
        WHERE operation_queue.kind = 'flags-push'
          AND operation_queue.status = 'pending'
          AND json_valid(operation_queue.payload_json)
          AND EXISTS (
            SELECT 1
            FROM json_each(operation_queue.payload_json, '$.entries') AS entry
            WHERE json_extract(entry.value, '$.id') = messages.id
          )
      )
  `);
  for (const id of messageIds) update.run(id);
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
 * The `flags-push` executor: pushes committed local deltas to the provider
 * with one IMAP connection per account and one STORE per (mailbox, flag-group).
 * Throws on provider failure so the queue retries; markers are cleared by the
 * caller only when the push has settled (success or permanent failure).
 */
export async function pushFlagsRemote(
  deps: FlagsPushDeps,
  payload: { accountId: string; entries: FlagsPushEntry[] },
): Promise<void> {
  const account = accountById(deps.db, payload.accountId);
  if (!account) throw new Error("Account not found.");
  const client = await imapClientForAccount(account, deps.masterKey, deps.accessTokenProvider);
  try {
    await client.connect();
    const byMailbox = new Map<string, FlagsPushEntry[]>();
    for (const entry of payload.entries) {
      const group = byMailbox.get(entry.mailbox) ?? [];
      group.push(entry);
      byMailbox.set(entry.mailbox, group);
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
