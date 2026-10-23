/**
 * The flag-push half of the flags pipeline: what the task layer consumes.
 *
 * The synchronous flag path (`sync-flags.ts`) still waits for the IMAP STORE
 * before committing the local cache, so a user action on that path costs one
 * provider round-trip. The local-first path writes the target state first and
 * pushes it from a durable task; both share this module's vocabulary and the
 * push below.
 *
 * Three exports, and each has exactly one consumer:
 *
 * - {@link prepareLocalFlags} reads the rows and diffs the patch against the
 *   current cache, writing nothing. `tasks/kinds/flags.ts` applies the result
 *   itself, so the direct route and the outbox route compute the same delta the
 *   same way.
 * - {@link pushFlagsRemote} is the provider half of the `flags` runner: one IMAP
 *   connection per account, one STORE per (mailbox, flag-group), and every
 *   position re-resolved from the stable local message id, because a move can
 *   rewrite `mailbox`/`uid` between the commit and the push.
 * - {@link flagsPushError} is the user-facing half of a refused push.
 *
 * The local-first commit that used to live here (`commitLocalFlags` and its
 * transaction body) applied the patch locally and staged durable `flags-push`
 * rows into `operation_queue` in that same transaction. Both halves are gone:
 * the local writes are `tasks/kinds/flags.ts` and the durable row is a `tasks`
 * row written by `commitTask`. The startup repair for markers left without a
 * push behind them (`clearOrphanedPendingFlagsMarkers`) is
 * `clearOrphanedFlagsMarkers` in `tasks/settlement.ts`; it needs no second store
 * to consult because there is no second store.
 *
 * What the push payload means is unchanged and still load-bearing: while
 * `messages.pending_flags_push` is set the delta is against the
 * remote-confirmed flag set, sync must not overwrite `flags_json` from the stale
 * remote, and a push is idempotent (a STORE of an already-applied flag is a
 * no-op), which is what makes a retry safe.
 */
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, safeMailError, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { moveActionBlockedError } from "./message-storage.js";
import { messageFlagNames, type MessageFlagsPatch } from "./message-flags.js";
import { accountById } from "./account-store.js";

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
    prepared.push({ message, nextFlags: [...nextFlags], add, remove });
  }
  return { prepared, blocked };
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
 * Resolves each id's CURRENT position from the local cache. A `flags` task's
 * payload is sealed with the position the message had at commit time; a
 * foreground move can rewrite `mailbox`/`uid` before the runner pushes, and
 * STOREing at the stale UID would either miss the message or, worse, hit
 * whichever message inherited that UID in the old mailbox. The stable local
 * message id is the only position-independent handle, so the push re-resolves
 * from it.
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

/** A STORE the provider accepted but did not confirm. Ours, and already written
 * for the user, so it is one of the two texts {@link flagsPushError} passes
 * through verbatim. Named so this module's three throws cannot drift apart. */
const FLAGS_PUSH_UNCONFIRMED = "邮件服务器未确认状态更新，请稍后重试。";

/** Thrown when the attempt's signal arrived before any IMAP command was sent.
 * Not offered to the user: the scheduler already gave up on this attempt, the
 * task is retried, and `flagsPushError` translates it like any other socket
 * failure. */
const FLAGS_PUSH_ABORTED = "Flags push aborted before it reached the provider.";

/**
 * The user-facing half of a refused flags push, as `{code, message}`.
 *
 * Two kinds of error come out of {@link pushFlagsRemote}, and only one of them
 * may be shown: its own refusals, which are written for the user already (an
 * account that is gone, a STORE the provider never confirmed), and whatever came
 * off the socket. This text does not stay in a log -- the task layer writes it to
 * `tasks.error_message`, `GET /api/batch-jobs/:id` hands it to the renderer, and
 * the batch poller toasts it verbatim (`batchJobRunner.ts`, `showToast(job.error)`).
 * A socket's message can carry the server's banner, the account name or a
 * credential, so it is translated by `safeMailError` exactly as the send
 * runner's failures are (contract §十七 (9), (11)): the code is ours, the
 * sentence is ours, and the raw error stays reachable as `cause`, in-process.
 */
export function flagsPushError(error: unknown): { code?: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message === FLAGS_PUSH_UNCONFIRMED || message === "Account not found.") return { message };
  return safeMailError(error);
}

/**
 * The provider half of the `flags` runner: pushes committed local deltas to the
 * provider with one IMAP connection per account and one STORE per (mailbox,
 * flag-group).
 * Entries carry the delta as staged and are re-positioned by message id at
 * execution time; an entry whose message is gone from the cache is dropped
 * (there is nothing left to push). Throws on provider failure so the task
 * scheduler retries the `flags` task (`tasks/scheduler.ts:250`); markers are
 * cleared by the caller only when the push has settled (success or permanent
 * failure).
 *
 * The counts are returned for the task layer's benefit and mean nothing unless
 * the call resolved: any STORE that the provider did not confirm throws, so a
 * returned `pushed` is the number of entries every STORE covering them accepted.
 * `dropped` is the share the caller stops owing -- a message that left the cache
 * between the commit and the push can never be delivered, and the legacy caller
 * (which ignores this return) left that share unaccounted for in both directions.
 */
export async function pushFlagsRemote(
  deps: FlagsPushDeps,
  payload: { accountId: string; entries: FlagsPushEntry[] },
  /** The task attempt's cancellation signal (`TaskRunner.signal`). Aborting it
   * closes the connection, which is what rejects an in-flight STORE: the scheduler
   * releases the account slot on timeout, and an abandoned push that kept the
   * socket alive would still be writing when the next task on that account runs. */
  signal?: AbortSignal,
): Promise<{ pushed: number; dropped: number }> {
  const account = accountById(deps.db, payload.accountId);
  if (!account) throw new Error("Account not found.");
  // Nothing has been sent yet, so this is the cheapest place to stop an attempt
  // the scheduler has already given up on -- and it avoids dialling a server to
  // immediately hang up on it.
  if (signal?.aborted) throw new Error(FLAGS_PUSH_ABORTED);
  const positions = currentPositions(deps.db, payload.entries.map((entry) => entry.id));
  let dropped = 0;
  const client = await imapClientForAccount(account, deps.masterKey, deps.accessTokenProvider);
  // Registered before `connect()`, because the timeout can fire during it. A
  // signal that flipped between the check above and here is caught by the
  // immediate replay; otherwise the listener fires once, at abort.
  const closeOnAbort = () => client.close();
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  if (signal?.aborted) closeOnAbort();
  try {
    await client.connect();
    const byMailbox = new Map<string, FlagsPushEntry[]>();
    for (const entry of payload.entries) {
      const position = positions.get(entry.id);
      if (!position) {
        dropped += 1;
        continue;
      }
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
            if (added === false) throw new Error(FLAGS_PUSH_UNCONFIRMED);
          }
          if (group.remove.length) {
            const removed = await client.messageFlagsRemove(group.uids, group.remove, { uid: true });
            if (removed === false) throw new Error(FLAGS_PUSH_UNCONFIRMED);
          }
        }
      } finally {
        lock.release();
      }
    }
    return { pushed: payload.entries.length - dropped, dropped };
  } finally {
    // Detached first: after this point the attempt has no more work to cancel,
    // and leaving the listener on a long-lived signal would close a client the
    // logout below is already handling.
    signal?.removeEventListener("abort", closeOnAbort);
    await safeLogout(client);
  }
}
