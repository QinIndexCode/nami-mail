/**
 * The retained remote-first flag write, for the one caller that is not a user
 * action: filter rules (`sync-filter-rules.ts`).
 *
 * Everything a user initiates goes through the task layer's local-first commit
 * (`tasks/kinds/flags.ts`) and returns before the provider answers. A filter
 * rule runs on freshly synced mail with no user watching, so it keeps the
 * simple shape: hold the account write slot, STORE, then mirror the confirmed
 * flags. The batch form that used to sit next to it, and the `markMessageSeen`
 * wrapper, had no caller left after the routes and the Agent moved to the task
 * layer (contract §4.7 B1); both are deleted rather than kept as a second way
 * to write flags.
 */
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { moveActionBlockedError } from "./message-storage.js";
import { messageFlagNames, type MessageFlagsPatch } from "./message-flags.js";
export type { MessageFlagsPatch };
import { messageAccountId, type PendingPushRow } from "./message-queries.js";
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
    const { message, nextFlags, add, remove } = prepared;
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
        // Flags are now the whole truth locally: the sidebar's unread number is
        // a COUNT over this table (contract §3.6), so the successful STORE has
        // nothing left to nudge. A folder refresh mid-flight can no longer
        // restore an already-read message to a total, because there is no
        // separate total to restore.
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
    });
  }
  return { messages, blocked };
}
