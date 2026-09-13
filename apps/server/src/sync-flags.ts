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
import { moveActionBlockedError } from "./message-storage.js";
import { accountById, withAccountWriteLocks } from "./sync.js";

export type MessageFlagsPatch = {
  seen?: boolean;
  flagged?: boolean;
};

const messageFlagNames = {
  seen: "\\Seen",
  flagged: "\\Flagged",
} as const;

export async function updateMessageFlags(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  patch: MessageFlagsPatch,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<void> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(messageId) as {
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
    } | undefined;
  if (!message) throw new Error("Message not found.");
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError) throw new Error(moveBlockedError);
  // The account-level write slot queues a flag update behind any move in
  // flight on the same account. Without it, starring a message while its
  // delete is still dispatching fails with a "pending move" error instead of
  // simply waiting its turn. This also serializes filter-rule and agent flag
  // writes against user moves.
  await withAccountWriteLocks([message.account_id], async () => {
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
      const seenChanged = currentFlags.has("\\Seen") !== nextFlags.has("\\Seen");
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
          `).run(nextFlags.has("\\Seen") ? 1 : 0, message.account_id, message.mailbox);
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
      if (client.usable) await client.logout().catch(() => undefined);
    }
  });
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
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id IN (${placeholders})`)
    .all(...messageIds) as Array<{
      id: string;
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
    }>;

  // Prepare per-message next flags; skip messages that no longer exist or
  // would not change. These are counted as "updated" to keep the overall
  // operation idempotent (they were already in the requested state).
  type PreparedMessage = {
    message: typeof rows[number];
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

  // Group by account: one connection per account, one STORE per mailbox.
  const byAccount = new Map<string, PreparedMessage[]>();
  for (const item of prepared) {
    const group = byAccount.get(item.message.account_id) ?? [];
    group.push(item);
    byAccount.set(item.message.account_id, group);
  }

  let updated = 0;
  let failed = blocked.length + (messageIds.length - rows.length);
  const changedIds: string[] = [];
  for (const [accountId, messages] of byAccount) {
    // The account write slot serializes the read-modify-write against any move
    // or flag update in flight on the same account, mirroring the single-message
    // `updateMessageFlags` path. Without it, a batch STORE racing a move (or
    // sync) can overwrite the freshly reconciled flags_json.
    await withAccountWriteLocks([accountId], async () => {
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
        const byMailbox = new Map<string, PreparedMessage[]>();
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
        if (client?.usable) await client.logout().catch(() => undefined);
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
