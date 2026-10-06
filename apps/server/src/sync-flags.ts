/**
 * Message flag operations extracted from sync.ts.
 *
 * This module contains single-message and batch flag update logic, including
 * IMAP STORE coordination, unread badge adjustments, and agent event
 * propagation. It depends on sync.ts for write-lock infrastructure and
 * account lookups.
 */
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { moveActionBlockedError } from "./message-storage.js";
import { messageFlagNames, type MessageFlagsPatch } from "./message-flags.js";
export type { MessageFlagsPatch };
import { messageAccountId, messageAccountIds, type PendingPushRow } from "./message-queries.js";
import { withAccountWriteLocks } from "./sync-locks.js";
import { accountById } from "./account-store.js";


export async function updateMessageFlags(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  patch: MessageFlagsPatch,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<void> {
  // Only the account id is read outside the lock: it is what names the lock.
  // Everything the patch is computed from — including the existence and
  // pending-move checks — is re-read inside it, so the read-modify-write is
  // serialized as a whole against a concurrent move or flag update. Reading
  // flags_json out here instead would let two writers compute their next flags
  // from the same stale snapshot, and the later write would overwrite the
  // earlier one's local flags even though both STOREs reached the server.
  const accountId = messageAccountId(db, messageId);
  if (!accountId) throw new Error("Message not found.");
  // The account-level write slot queues a flag update behind any move in
  // flight on the same account. Without it, starring a message while its
  // delete is still dispatching fails with a "pending move" error instead of
  // simply waiting its turn. This also serializes filter-rule and agent flag
  // writes against user moves.
  await withAccountWriteLocks([accountId], async () => {
    const { messages, blocked } = planFlagPatch(db, [messageId], patch);
    const prepared = messages[0];
    if (!prepared) throw new Error(blocked.get(messageId) ?? "Message not found.");
    const { message, nextFlags, add, remove, seenChanged } = prepared;
    // The requested state is already reflected in the last server-confirmed
    // cache. Avoid a redundant STORE command and, importantly, a second count
    // adjustment for an idempotent read/open action.
    if (!add.length && !remove.length) return;
    const account = accountById(db, message.account_id);
    if (!account) throw new Error("Account not found.");
    const agentLease = agentEvents?.acquireLease(message.account_id);
    const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(message.mailbox);
      try {
        if (add.length) {
          const added = await client.messageFlagsAdd(message.uid, add, { uid: true });
          if (added === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
        }
        if (remove.length) {
          const removed = await client.messageFlagsRemove(message.uid, remove, { uid: true });
          if (removed === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
        }
      } finally {
        lock.release();
      }
      db.transaction(() => {
        db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify([...nextFlags]), messageId);
        if (seenChanged) {
          // Keep the cached sidebar badge aligned with the successful remote
          // STORE. The folder refresh remains authoritative, but it must not
          // briefly restore an already-read message to the unread total.
          db.prepare(`
            UPDATE folders
            SET unseen = CASE
              WHEN ? = 1 THEN CASE WHEN unseen > 0 THEN unseen - 1 ELSE 0 END
              ELSE unseen + 1
            END
            WHERE account_id = ? AND path = ?
          `).run(nextFlags.includes("\\Seen") ? 1 : 0, message.account_id, message.mailbox);
        }
        if (agentEvents && agentLease) {
          agentEvents.messageUpsertedWithinTransaction(agentLease, messageId, {
            mailbox: message.mailbox,
            uid: message.uid,
            remoteIdLookup: message.remote_id_lookup,
            flags: [...nextFlags].sort(),
            pendingMoveDestination: message.pending_move_destination,
            pendingMoveState: message.pending_move_state,
          });
        }
      })();
    } finally {
      await safeLogout(client);
    }
  });
}

/** Columns a flag patch needs, in both the single and the batch path. */
const FLAG_PATCH_ROW_SQL =
  "SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages";

/** One message's next flags, derived from a snapshot read while the account
 * write slot was held. */
type PreparedFlagMessage = {
  message: PendingPushRow & { id: string };
  nextFlags: string[];
  add: string[];
  remove: string[];
  seenChanged: boolean;
};

/** What a patch would do to a set of ids, with the reason for every id it
 * cannot touch. */
type FlagPatchPlan = {
  messages: PreparedFlagMessage[];
  /** id -> the error explaining why it was left alone (missing row, or a move
   * that has to be reconciled first). The single-message path rethrows it; the
   * batch counts it as a failure. */
  blocked: Map<string, string>;
};

/**
 * Computes the next flags for `messageIds` from one snapshot of their rows.
 *
 * Callers must hold the account write slot(s) for the accounts involved while
 * calling this: it is the snapshot the read-modify-write is computed from, and
 * the whole point of the slot is that no other writer can advance the row
 * between this read and the write that follows. Reading it before taking the
 * slot is what let two writers compute their next flags from the same stale
 * state and the later one silently drop the earlier one's local flags.
 *
 * Messages already in the requested state are kept (with empty add/remove) so
 * the caller can still count them as idempotently updated.
 */
function planFlagPatch(db: DatabaseHandle, messageIds: readonly string[], patch: MessageFlagsPatch): FlagPatchPlan {
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`${FLAG_PATCH_ROW_SQL} WHERE id IN (${placeholders})`)
    .all(...messageIds) as Array<{ id: string } & PendingPushRow>;
  const messages: PreparedFlagMessage[] = [];
  const blocked = new Map<string, string>();
  for (const message of rows) {
    const moveBlockedError = moveActionBlockedError(message);
    if (moveBlockedError) {
      blocked.set(message.id, moveBlockedError);
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
    messages.push({
      message,
      nextFlags: [...nextFlags],
      add,
      remove,
      seenChanged: currentFlags.has("\\Seen") !== nextFlags.has("\\Seen"),
    });
  }
  return { messages, blocked };
}

/**
 * Applies the same flag patch to many messages using one IMAP connection per
 * account and one STORE command per mailbox, instead of one connection and one
 * command per message. Failures are per-message: the caller receives how many
 * messages were updated and how many failed, mirroring the per-id behavior of
 * the previous loop.
 */
export async function updateMessageFlagsBatch(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageIds: readonly string[],
  patch: MessageFlagsPatch,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentMailEvents?: AgentMailEventSink,
): Promise<{ updated: number; failed: number; changedIds: string[] }> {
  if (!messageIds.length) return { updated: 0, failed: 0, changedIds: [] };
  // Only the id -> account routing is read outside the lock: it is what names
  // the lock each group of ids waits for. The rows themselves are re-read
  // inside it (planFlagPatch), so a batch never writes next flags computed
  // from a snapshot another writer has already superseded.
  const idsByAccount = new Map<string, string[]>();
  for (const { id, account_id: accountId } of messageAccountIds(db, messageIds)) {
    const group = idsByAccount.get(accountId) ?? [];
    group.push(id);
    idsByAccount.set(accountId, group);
  }
  const routed = [...idsByAccount.values()].reduce((total, ids) => total + ids.length, 0);
  // Ids with no message row at all (deleted, or never in this database) cannot
  // be updated; the rest of the accounting happens under the lock.
  let failed = messageIds.length - routed;
  let updated = 0;
  const changedIds: string[] = [];
  for (const [accountId, accountMessageIds] of idsByAccount) {
    // The account write slot serializes the whole read-modify-write — the
    // snapshot the next flags are computed from included — against any move or
    // flag update in flight on the same account, mirroring the single-message
    // `updateMessageFlags` path. Without it, a batch STORE racing a move (or a
    // concurrent flag update) overwrites the freshly reconciled flags_json.
    await withAccountWriteLocks([accountId], async () => {
      const { messages, blocked } = planFlagPatch(db, accountMessageIds, patch);
      // A row can also disappear between the routing read and this one.
      failed += blocked.size;
      if (!messages.length) return;
      const account = accountById(db, accountId);
      if (!account) {
        failed += messages.length;
        return;
      }
      const agentLease = agentMailEvents?.acquireLease(accountId);
      const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
      let remoteSucceeded = false;
      try {
        await client.connect();
        const byMailbox = new Map<string, PreparedFlagMessage[]>();
        for (const item of messages) {
          const group = byMailbox.get(item.message.mailbox) ?? [];
          group.push(item);
          byMailbox.set(item.message.mailbox, group);
        }
        for (const [mailbox, mailboxMessages] of byMailbox) {
          const lock = await client.getMailboxLock(mailbox);
          try {
            // Messages in the same mailbox may need different flag changes
            // (some add \\Seen, others already have it). Group by the exact
            // flag set so each STORE command covers a uniform batch.
            const byFlagGroup = new Map<string, { add: string[]; remove: string[]; uids: number[] }>();
            for (const item of mailboxMessages) {
              const key = `${item.add.join(",")}\u0000${item.remove.join(",")}`;
              let group = byFlagGroup.get(key);
              if (!group) {
                group = { add: item.add, remove: item.remove, uids: [] };
                byFlagGroup.set(key, group);
              }
              group.uids.push(item.message.uid);
            }
            for (const group of byFlagGroup.values()) {
              if (group.add.length && group.uids.length) {
                const added = await client.messageFlagsAdd(group.uids, group.add, { uid: true });
                if (added === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
              }
              if (group.remove.length && group.uids.length) {
                const removed = await client.messageFlagsRemove(group.uids, group.remove, { uid: true });
                if (removed === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
              }
            }
          } finally {
            lock.release();
          }
        }
        remoteSucceeded = true;
      } catch {
        remoteSucceeded = false;
      } finally {
        await safeLogout(client);
      }
      if (!remoteSucceeded) {
        failed += messages.length;
        return;
      }

      // Persist locally only after the remote STORE succeeded for every message
      // in the account.
      db.transaction(() => {
        for (const item of messages) {
          const { message } = item;
          db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify(item.nextFlags), message.id);
          // Only messages that actually changed state are undo candidates;
          // idempotent no-ops (already in the requested state) stay in `updated`.
          if (item.add.length || item.remove.length) changedIds.push(message.id);
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
          if (agentMailEvents && agentLease) {
            agentMailEvents.messageUpsertedWithinTransaction(agentLease, message.id, {
              mailbox: message.mailbox,
              uid: message.uid,
              remoteIdLookup: message.remote_id_lookup,
              flags: [...item.nextFlags].sort(),
              pendingMoveDestination: message.pending_move_destination,
              pendingMoveState: message.pending_move_state,
            });
          }
        }
      })();
      updated += messages.length;
    });
  }
  const changedSet = new Set(changedIds);
  return { updated, failed, changedIds: messageIds.filter((id) => changedSet.has(id)) };
}

export async function markMessageSeen(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  seen: boolean,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<void> {
  await updateMessageFlags(db, masterKey, messageId, { seen }, accessTokenProvider, agentEvents);
}
