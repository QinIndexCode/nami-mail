/**
 * Message move operations extracted from sync.ts.
 *
 * This module contains every public and private function related to moving
 * messages between IMAP folders: single-message moves, batch moves via
 * aggregated IMAP MOVE commands, and the UIDPLUS / pending-reconciliation
 * persistence helpers shared by both paths.
 *
 * The module imports write-lock infrastructure and account state accessors
 * from sync.ts but does not depend on syncAccount itself, keeping the
 * dependency edge one-directional.
 */
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { friendlyMailError, imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import {
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
  moveActionBlockedError,
} from "./message-storage.js";
import { pendingPushRowById } from "./message-queries.js";
import {
  isAccountMoving,
  isAccountSyncing,
  markAccountMoving,
  unmarkAccountMoving,
  waitForAccountSyncIdle,
  withAccountWriteLocks,
} from "./sync-locks.js";
import { accountById } from "./account-store.js";
import {
  cachedDestinationCandidateUid,
  moveStatements,
  pendingMoveUid,
  removeTrashSystemViewMirrors,
  updateFolderCountsForMove,
  type MoveDestination,
  type MoveDuplicateRow,
} from "./sync-move-statements.js";

// ---------------------------------------------------------------------------
// Move-target definitions
// ---------------------------------------------------------------------------

export type MessageMoveTarget = "archive" | "trash" | "junk" | "inbox";

const moveTargets: Record<MessageMoveTarget, { specialUses: string[]; unavailableMessage: string }> = {
  archive: {
    // Some providers expose their archive view as \All. MOVE removes the source
    // mailbox membership and is therefore the provider-supported archive action.
    specialUses: ["\\Archive", "\\All"],
    unavailableMessage: "这个邮箱没有提供可用的归档文件夹。",
  },
  trash: {
    specialUses: ["\\Trash"],
    unavailableMessage: "这个邮箱没有提供可用的废纸篓文件夹。",
  },
  junk: {
    // The provider's canonical spam folder; some providers expose it under a
    // localized path, so resolve by SPECIAL-USE only.
    specialUses: ["\\Junk"],
    unavailableMessage: "这个邮箱没有提供可用的垃圾邮件文件夹。",
  },
  inbox: {
    // The "not spam" recovery path restores a misclassified message to the
    // real INBOX regardless of the account's folder naming.
    specialUses: ["\\Inbox"],
    unavailableMessage: "这个邮箱没有提供可用的收件箱。",
  },
};

// ---------------------------------------------------------------------------
// Public move result types
// ---------------------------------------------------------------------------

export type MessageMoveResult = {
  accountId: string;
  destination: string;
  refreshPending: boolean;
  uid?: number;
  uncertain?: boolean;
  locationUnverified?: boolean;
};

// ---------------------------------------------------------------------------
// Single-message moves
// ---------------------------------------------------------------------------

/**
 * Moves a message to an explicit folder path of its own account. Used by
 * filter rules so "move to folder" can address any known folder, not only
 * the archive/trash shortcuts.
 *
 * `options.client` runs the move on a connection the caller already holds
 * (batch-job undo moves a whole scope on one) instead of dialling its own.
 */
export async function moveMessageToFolder(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  folderPath: string,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  options?: MoveMessageOptions,
): Promise<MessageMoveResult> {
  const message = pendingPushRowById(db, messageId);
  if (!message) throw new Error("Message not found.");
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError && !isRecoverableStaleMove(message)) throw new Error(moveBlockedError);
  if (message.mailbox === folderPath) throw new Error("邮件已经在该文件夹中。");
  const folder = db.prepare(`
    SELECT path, special_use FROM folders WHERE account_id = ? AND path = ?
  `).get(message.account_id, folderPath) as MoveDestination | undefined;
  if (!folder) throw new Error("目标文件夹不存在或不可用。");
  return moveMessageCore(db, masterKey, messageId, folder, accessTokenProvider, agentEvents, options);
}

export type MoveMessageOptions = {
  /** A connected IMAP client to reuse (batch moves share one per account). */
  client?: Awaited<ReturnType<typeof imapClientForAccount>>;
  /** Overrides how long the move waits for a running sync pass (tests). */
  syncWaitMs?: number;
};

/**
 * Only an 'intent' left behind by an interrupted transfer can be re-probed
 * against the source mailbox and retried. A 'confirmed' move and an
 * unverified location stay blocked until a sync reconciles the target.
 */
function isRecoverableStaleMove(message: { pending_move_state: string | null; uid: number }): boolean {
  return message.pending_move_state === "intent" && message.uid > 0;
}

/**
 * Proves whether the source UID of a stale 'intent' is still live. Present:
 * the interrupted MOVE never executed, so the intent is discarded for a fresh
 * attempt (true). Absent: the MOVE did happen and reconciliation owns the
 * outcome (false).
 */
async function recoverStaleMoveIntent(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  message: { account_id: string; mailbox: string; uid: number },
  accessTokenProvider?: AccountAccessTokenProvider,
  sharedClient?: Awaited<ReturnType<typeof imapClientForAccount>>,
): Promise<boolean> {
  const account = accountById(db, message.account_id);
  if (!account) return false;
  const client = sharedClient ?? (await imapClientForAccount(account, masterKey, accessTokenProvider));
  const ownsClient = !sharedClient;
  try {
    if (ownsClient) await client.connect();
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      for await (const item of client.fetch([message.uid], { uid: true }, { uid: true })) {
        if (item.uid === message.uid) {
          moveStatements(db).clearMoveIntent.run(messageId);
          return true;
        }
      }
    } finally {
      lock.release();
    }
    return false;
  } finally {
    if (ownsClient && client.usable) await client.logout().catch(() => undefined);
  }
}

export async function moveMessage(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  target: MessageMoveTarget,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  options?: MoveMessageOptions,
): Promise<MessageMoveResult> {
  const message = pendingPushRowById(db, messageId);
  if (!message) throw new Error("Message not found.");
  // A move already being reconciled must block before the target folder is
  // resolved: the provider folder may not exist (e.g. no Trash on the account)
  // and must not shadow the reconciliation error. A stale 'intent' may be
  // retried after core proves the source UID is still live.
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError && !isRecoverableStaleMove(message)) throw new Error(moveBlockedError);
  const targetDefinition = moveTargets[target];
  const destination = resolveMoveDestination(db, message.account_id, target);
  if (!destination) throw new Error(targetDefinition.unavailableMessage);
  if (destination.path === message.mailbox) {
    // The message already lives in the target folder (e.g. a second delete
    // from the Trash view, or an archive action inside All Mail). Moving it
    // again is an idempotent no-op: report success so the renderer clears
    // the message from the current view instead of failing the action.
    return { accountId: message.account_id, destination: destination.path, refreshPending: false };
  }
  // The account-level write slot serializes concurrent user operations: a
  // move issued while another move is in flight waits its turn instead of
  // failing with a busy error. Reentrant callers (batch fallbacks, undo)
  // acquire the slot once at their own level, so this nesting never recurses.
  return withAccountWriteLocks([message.account_id], () =>
    moveMessageCore(db, masterKey, messageId, destination, accessTokenProvider, agentEvents, options),
  );
}

type MoveMessageFields = {
  account_id: string;
  mailbox: string;
  uid: number;
  flags_json: string;
  remote_id_lookup: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

/**
 * Resolves the provider folder a move target maps to, or null when the
 * account has no usable folder for the target. A message that already lives
 * in the resolved folder is handled as an idempotent no-op by the callers.
 * Exported for batch-job undo, which must know the job's target folder to
 * avoid dragging manually re-moved messages back.
 */
export function resolveMoveDestination(
  db: DatabaseHandle,
  accountId: string,
  target: MessageMoveTarget,
): MoveDestination | null {
  const specialUses = moveTargets[target].specialUses;
  // Only the `?` count varies in this statement, so it is compiled once per
  // width per connection (see `moveStatements`). The special-use names stay
  // bound, the precedence and the `IN` order are the SQL the uncached path
  // issued, and `.get()` still reads the folders row *now* — only the compile
  // is shared, never the result.
  const destination = moveStatements(db).destinationBySpecialUseCount(specialUses.length)
    .get(accountId, ...specialUses) as MoveDestination | undefined;
  return destination ?? null;
}

/**
 * Persists the UIDPLUS-confirmed outcome of a provider MOVE: the row is
 * rebound to the exact destination UID, duplicate destination rows from a
 * cached \All copy are dropped, and folder counts are adjusted. Shared by
 * single-message moves and aggregated batch moves so both keep identical
 * intent/UIDPLUS semantics.
 */
function applyMoveConfirmedUidPlus(
  db: DatabaseHandle,
  messageId: string,
  message: MoveMessageFields,
  destination: MoveDestination,
  destinationUid: number,
  agentEvents?: AgentMailEventSink,
  agentLease?: ReturnType<NonNullable<AgentMailEventSink["acquireLease"]>>,
): void {
  db.transaction(() => {
    const statements = moveStatements(db);
    // Gmail can already have a cached \All copy. UIDPLUS proves this is
    // the same server message, so preserve the current UI-facing id. The read
    // has to precede the DELETE below: it is what tells the Agent sink which
    // row ids disappeared, and by then the DELETE would have already removed
    // every one of them.
    const duplicateDestinationRows = statements.uidPlusDuplicateRows.all(message.account_id, destination.path, destinationUid, messageId) as MoveDuplicateRow[];
    const removedDestinationRow = statements.uidPlusRemoveDestinationRows.run(message.account_id, destination.path, destinationUid, messageId);
    const updated = statements.uidPlusConfirm.run(destination.path, destinationUid, destination.special_use === "\\All" ? 1 : null, messageId);
    if (updated.changes !== 1) throw new Error("Move intent was not available for UIDPLUS reconciliation.");
    updateFolderCountsForMove(statements, message, destination, removedDestinationRow.changes > 0);
    if (destination.special_use === "\\Trash") {
      removeTrashSystemViewMirrors(statements, message, messageId, agentEvents, agentLease);
    }
    if (agentEvents && agentLease) {
      for (const duplicate of duplicateDestinationRows) {
        agentEvents.messageDeletedWithinTransaction(agentLease, duplicate.id, {
          reason: "move-destination-duplicate",
          mailbox: duplicate.mailbox,
          uid: duplicate.uid,
          remoteIdLookup: duplicate.remote_id_lookup,
          flagsJson: duplicate.flags_json,
          allMailArchived: duplicate.all_mail_archived,
        });
      }
      agentEvents.messageUpsertedWithinTransaction(agentLease, messageId, {
        transition: "move-confirmed",
        mailbox: destination.path,
        uid: destinationUid,
        remoteIdLookup: message.remote_id_lookup,
        flagsJson: message.flags_json,
        allMailArchived: destination.special_use === "\\All" ? 1 : null,
      });
    }
  })();
}

/**
 * Persists a provider MOVE on a server without UIDPLUS: the encrypted source
 * row is kept durable at the destination and marked 'confirmed' so a later
 * sync can reconcile the exact opaque remote identifier.
 */
function applyMovePendingReconciliation(
  db: DatabaseHandle,
  messageId: string,
  message: MoveMessageFields,
  destination: MoveDestination,
  agentEvents?: AgentMailEventSink,
  agentLease?: ReturnType<NonNullable<AgentMailEventSink["acquireLease"]>>,
): { refreshPending: boolean; locationUnverified: boolean } {
  db.transaction(() => {
    const statements = moveStatements(db);
    const candidateUid = cachedDestinationCandidateUid(
      statements,
      message.account_id,
      destination.path,
      message.remote_id_lookup,
      messageId,
    );
    // The read still precedes the DELETE, and both stay behind the same
    // `remote_id_lookup` guard as before: without a stable remote identity
    // there is no destination copy to recognise, so neither statement is
    // compiled nor run.
    const duplicateDestinationRows = message.remote_id_lookup
      ? statements.reconcileDuplicateRows.all(message.account_id, destination.path, message.remote_id_lookup, messageId) as MoveDuplicateRow[]
      : [];
    const removedDestinationRows = message.remote_id_lookup
      ? statements.reconcileRemoveDestinationRows.run(message.account_id, destination.path, message.remote_id_lookup, messageId)
      : { changes: 0 };
    const localPendingUid = pendingMoveUid(statements, message.account_id, message.mailbox, message.uid);
    const confirmed = statements.reconcileConfirm.run(
      localPendingUid,
      destination.path,
      candidateUid,
      destination.special_use,
      destination.special_use === "\\All" ? 1 : null,
      messageId,
    );
    if (confirmed.changes !== 1) throw new Error("Move intent was not available for pending reconciliation.");
    updateFolderCountsForMove(statements, message, destination, removedDestinationRows.changes > 0);
    if (destination.special_use === "\\Trash") {
      removeTrashSystemViewMirrors(statements, message, messageId, agentEvents, agentLease);
    }
    if (agentEvents && agentLease) {
      for (const duplicate of duplicateDestinationRows) {
        agentEvents.messageDeletedWithinTransaction(agentLease, duplicate.id, {
          reason: "move-destination-duplicate",
          mailbox: duplicate.mailbox,
          uid: duplicate.uid,
          remoteIdLookup: duplicate.remote_id_lookup,
          flagsJson: duplicate.flags_json,
          allMailArchived: duplicate.all_mail_archived,
        });
      }
      agentEvents.messageUpsertedWithinTransaction(agentLease, messageId, {
        transition: "move-confirmed-pending-reconciliation",
        mailbox: message.mailbox,
        uid: localPendingUid,
        destination: destination.path,
        destinationSpecialUse: destination.special_use,
        remoteIdLookup: message.remote_id_lookup,
        flagsJson: message.flags_json,
        candidateUid,
        allMailArchived: destination.special_use === "\\All" ? 1 : null,
      });
    }
  })();
  return {
    refreshPending: message.remote_id_lookup !== null,
    locationUnverified: message.remote_id_lookup === null,
  };
}

async function moveMessageCore(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  destination: MoveDestination,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  options?: MoveMessageOptions,
): Promise<MessageMoveResult> {
  const message = pendingPushRowById(db, messageId);
  if (!message) throw new Error("Message not found.");
  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");
  const agentLease = agentEvents?.acquireLease(message.account_id);
  // Another move on this account is already dispatching. Report that specific
  // condition instead of the pending-move message, which describes a different
  // state and sent the last investigation after the wrong cause.
  if (isAccountMoving(message.account_id)) throw new Error(MAIL_MOVE_IN_FLIGHT_ERROR);

  const statements = moveStatements(db);
  const clearMoveIntent = statements.clearMoveIntent;
  let client: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;
  let ownedClient: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;
  let moveAttempted = false;
  let moveSettled = false;
  let commandRefused = false;
  let intentClaimed = false;
  // Claim the account *before* waiting: syncAccount skips an account that is
  // moving, so no new pass can start here and the wait is bounded by the pass
  // already underway. Waiting (rather than failing in ~2ms) matches how every
  // other write path behaves — a delete issued during a sync used to be
  // rejected with the pending-move message, which is not what the user saw.
  markAccountMoving(message.account_id);
  try {
    if (isAccountSyncing(message.account_id) && !await waitForAccountSyncIdle(message.account_id, options?.syncWaitMs)) {
      throw new Error(MAILBOX_SYNCING_ERROR);
    }
    // A stale 'intent' (an earlier MOVE whose response was lost) may never
    // have reached the provider. Prove whether the source UID is still live
    // before either retrying the move or leaving reconciliation in charge;
    // the probe reuses the connection the retry will move on.
    let moveBlockedError = moveActionBlockedError(message);
    if (moveBlockedError === PENDING_MOVE_RECONCILIATION_ERROR && isRecoverableStaleMove(message)) {
      if (!options?.client) {
        ownedClient = await imapClientForAccount(account, masterKey, accessTokenProvider);
        await ownedClient.connect();
      }
      const recovered = await recoverStaleMoveIntent(db, masterKey, messageId, message, accessTokenProvider, options?.client ?? ownedClient);
      if (recovered) moveBlockedError = null;
    }
    if (moveBlockedError) throw new Error(moveBlockedError);

    const intentCandidateUid = cachedDestinationCandidateUid(
      statements,
      message.account_id,
      destination.path,
      message.remote_id_lookup,
      messageId,
    );

    // The intent is durable before any provider command. If the process exits
    // after the command is accepted but before the response is persisted, sync
    // can either prove the source still exists or reconcile the exact target.
    const beganIntent = statements.beginMoveIntent.run(destination.path, intentCandidateUid, destination.special_use, messageId);
    if (beganIntent.changes !== 1) throw new Error(PENDING_MOVE_RECONCILIATION_ERROR);
    intentClaimed = true;

    if (options?.client) {
      client = options.client;
    } else {
      if (!ownedClient) {
        ownedClient = await imapClientForAccount(account, masterKey, accessTokenProvider);
        await ownedClient.connect();
      }
      client = ownedClient;
    }
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      moveAttempted = true;
      const moved = await client.messageMove(message.uid, destination.path, { uid: true });
      if (!moved) {
        commandRefused = true;
        clearMoveIntent.run(messageId);
        throw new Error("邮件服务器未确认移动操作，请稍后重试。");
      }
      const destinationUid = moved.uidMap?.get(message.uid);
      if (typeof destinationUid === "number" && Number.isSafeInteger(destinationUid) && destinationUid > 0) {
        applyMoveConfirmedUidPlus(db, messageId, message, destination, destinationUid, agentEvents, agentLease);
        moveSettled = true;
        return { accountId: message.account_id, destination: destination.path, refreshPending: false, uid: destinationUid };
      }
    } finally {
      lock.release();
    }
    // Servers without UIDPLUS do not identify the destination UID. Keep the
    // encrypted source row durable and expose its effective destination until
    // a later sync can reconcile the exact opaque remote identifier.
    const reconciled = applyMovePendingReconciliation(db, messageId, message, destination, agentEvents, agentLease);
    moveSettled = true;
    // Without a stable server identifier, the confirmed move is still real,
    // but the local cache cannot safely bind its preserved payload to a target
    // UID. Keep it readable at the confirmed destination and block operations
    // that would otherwise address the old, local-only UID.
    return {
      accountId: message.account_id,
      destination: destination.path,
      refreshPending: reconciled.refreshPending,
      ...(reconciled.locationUnverified ? { locationUnverified: true } : {}),
    };
  } catch (error) {
    if (moveSettled) throw error;
    if (!moveAttempted || commandRefused) {
      // An unclaimed intent (recovery probe, failed claim or failed connect)
      // must be left untouched: reconciliation owns it.
      if (intentClaimed) clearMoveIntent.run(messageId);
      throw error;
    }
    // A transport failure after MOVE was issued is ambiguous. Preserve the
    // intent and start reconciliation instead of claiming either outcome.
    return { accountId: message.account_id, destination: destination.path, refreshPending: true, uncertain: true };
  } finally {
    unmarkAccountMoving(message.account_id);
    if (ownedClient?.usable) await ownedClient.logout().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Batch moves
// ---------------------------------------------------------------------------

export type BatchMessageMoveOutcome = {
  updated: number;
  failed: number;
  failures: Array<{ id: string; message: string }>;
  pendingAccounts: Set<string>;
};

const knownLocalMoveErrors = new Set([
  "Message not found.",
  "Account not found.",
  "邮件服务器未确认移动操作，请稍后重试。",
  "这个邮箱没有提供可用的归档文件夹。",
  "这个邮箱没有提供可用的废纸篓文件夹。",
  "目标文件夹不存在或不可用。",
  "邮件已经在该文件夹中。",
  PENDING_MOVE_RECONCILIATION_ERROR,
  MOVE_LOCATION_UNVERIFIED_ERROR,
]);

function moveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return knownLocalMoveErrors.has(message) ? message : friendlyMailError(error);
}

/**
 * Moves every entry of one (account, source mailbox) group with a single
 * provider MOVE command (RFC 6851 message sets). The provider round-trip —
 * the dominant cost of a serial batch — drops from N commands to 1; intent
 * claiming and UIDPLUS reconciliation still run per message, sharing the
 * exact same persistence helpers as single-message moves.
 *
 * Per-message outcomes: moved (UIDPLUS-confirmed or pending reconciliation),
 * blocked (existing intent or a running sync), refused (the provider rejected
 * the whole message set — claimed intents are cleared), or ambiguous
 * (transport failure after the command was issued — intents are preserved for
 * sync's self-healing reconciliation, mirroring the single-move uncertain
 * path).
 */
async function moveMessagesInOneCommand(
  db: DatabaseHandle,
  masterKey: Buffer,
  entries: Array<MoveMessageFields & { id: string }>,
  destination: MoveDestination,
  accessTokenProvider: AccountAccessTokenProvider | undefined,
  agentEvents: AgentMailEventSink | undefined,
  client: Awaited<ReturnType<typeof imapClientForAccount>>,
): Promise<{ updated: number; failures: Array<{ id: string; message: string }>; pendingAccounts: Set<string> }> {
  const outcome = { updated: 0, failures: [] as Array<{ id: string; message: string }>, pendingAccounts: new Set<string>() };
  const accountId = entries[0]?.account_id;
  if (!accountId || entries.length === 0) return outcome;
  const agentLease = agentEvents?.acquireLease(accountId);
  if (isAccountMoving(accountId)) {
    for (const entry of entries) outcome.failures.push({ id: entry.id, message: MAIL_MOVE_IN_FLIGHT_ERROR });
    return outcome;
  }
  markAccountMoving(accountId);
  const statements = moveStatements(db);
  const clearMoveIntent = statements.clearMoveIntent;
  const claimed: Array<MoveMessageFields & { id: string }> = [];
  let commandAttempted = false;
  try {
    // Same policy as single moves: the account is claimed already, so no new
    // pass can start here; let the running one finish instead of failing every
    // entry with the pending-move message.
    if (isAccountSyncing(accountId) && !await waitForAccountSyncIdle(accountId)) {
      for (const entry of entries) outcome.failures.push({ id: entry.id, message: MAILBOX_SYNCING_ERROR });
      return outcome;
    }
    for (const entry of entries) {
      // A stale 'intent' (an earlier MOVE whose response was lost) may never
      // have reached the provider; probe the source UID on the shared
      // connection before either retrying or leaving reconciliation in charge.
      let moveBlockedError = moveActionBlockedError(entry);
      if (moveBlockedError === PENDING_MOVE_RECONCILIATION_ERROR && isRecoverableStaleMove(entry)) {
        const recovered = await recoverStaleMoveIntent(db, masterKey, entry.id, entry, accessTokenProvider, client);
        if (recovered) moveBlockedError = null;
      }
      if (moveBlockedError) {
        outcome.failures.push({ id: entry.id, message: moveBlockedError });
        continue;
      }
      const intentCandidateUid = cachedDestinationCandidateUid(
        statements,
        accountId,
        destination.path,
        entry.remote_id_lookup,
        entry.id,
      );
      // The intent is durable before the provider command; if the process
      // exits after the command is accepted but before the response is
      // persisted, sync can either prove the source still exists or reconcile
      // the exact target.
      const beganIntent = statements.beginMoveIntent.run(destination.path, intentCandidateUid, destination.special_use, entry.id);
      if (beganIntent.changes !== 1) {
        outcome.failures.push({ id: entry.id, message: PENDING_MOVE_RECONCILIATION_ERROR });
        continue;
      }
      claimed.push(entry);
    }
    if (claimed.length === 0) return outcome;

    const lock = await client.getMailboxLock(claimed[0]!.mailbox);
    try {
      commandAttempted = true;
      const moved = await client.messageMove(claimed.map((entry) => entry.uid), destination.path, { uid: true });
      if (!moved) {
        // The provider refused the whole message set. Every claimed intent was
        // recorded before the command and never executed, so clear them all.
        for (const entry of claimed) clearMoveIntent.run(entry.id);
        for (const entry of claimed) outcome.failures.push({ id: entry.id, message: "邮件服务器未确认移动操作，请稍后重试。" });
        return outcome;
      }
      for (const entry of claimed) {
        try {
          const destinationUid = moved.uidMap?.get(entry.uid);
          if (typeof destinationUid === "number" && Number.isSafeInteger(destinationUid) && destinationUid > 0) {
            applyMoveConfirmedUidPlus(db, entry.id, entry, destination, destinationUid, agentEvents, agentLease);
          } else {
            const reconciled = applyMovePendingReconciliation(db, entry.id, entry, destination, agentEvents, agentLease);
            if (reconciled.refreshPending) outcome.pendingAccounts.add(accountId);
          }
          outcome.updated += 1;
        } catch (error) {
          outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
        }
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    const claimedIds = new Set(claimed.map((entry) => entry.id));
    if (!commandAttempted) {
      // The command never reached the provider (e.g. the mailbox lock could
      // not be acquired). Mirror the single-move path: clear every claimed
      // intent and report the failure.
      for (const entry of claimed) clearMoveIntent.run(entry.id);
      for (const entry of entries) {
        outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
      }
    } else {
      // A transport failure after the MOVE was issued is ambiguous for every
      // claimed intent: preserve them and let sync's self-healing
      // reconciliation decide. Entries that never claimed an intent failed
      // before the command.
      for (const entry of entries) {
        if (claimedIds.has(entry.id)) {
          outcome.updated += 1;
          outcome.pendingAccounts.add(accountId);
        } else {
          outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
        }
      }
    }
  } finally {
    unmarkAccountMoving(accountId);
  }
  return outcome;
}

/**
 * Moves many messages with one IMAP connection per account and one MOVE
 * command per (account, source mailbox). Connection setup (not the MOVE
 * command itself) dominated the old serial batch: an 8-message delete needed
 * ~8 connects, and the message set still sent 8 commands. Sharing the client
 * and aggregating UIDs turns that into 1 connect + 1 command. Per-message
 * intent/UIDPLUS semantics are unchanged; failures are reported individually
 * instead of being swallowed.
 *
 * A caller running many batches in a row passes the `connections` cache it
 * owns, paying one connect per account for the whole run instead of per batch.
 */
export async function batchMoveMessages(
  db: DatabaseHandle,
  masterKey: Buffer,
  ids: string[],
  target: MessageMoveTarget,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  connections?: Map<string, Awaited<ReturnType<typeof imapClientForAccount>>>,
): Promise<BatchMessageMoveOutcome> {
  const outcome: BatchMessageMoveOutcome = {
    updated: 0,
    failed: 0,
    failures: [],
    pendingAccounts: new Set(),
  };
  if (ids.length === 0) return outcome;
  // Resolve every row up front so each group shares one destination lookup
  // and one provider MOVE command. The compiled statement is kept per IN
  // width on the handle (see `moveStatements`): a job calls this once per
  // MOVE_CHUNK_SIZE ids, so a 40 000-row selection compiles one statement here
  // instead of 400 identical ones. Ids stay bound parameters.
  const rows = moveStatements(db).rowsByIds(ids.length).all(...ids) as Array<MoveMessageFields & { id: string }>;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, Array<MoveMessageFields & { id: string }>>();
  for (const id of ids) {
    const row = rowsById.get(id);
    if (!row) {
      outcome.failed += 1;
      outcome.failures.push({ id, message: "Message not found." });
      continue;
    }
    const key = `${row.account_id}\u0000${row.mailbox}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const clientsByAccount = connections ?? new Map<string, Awaited<ReturnType<typeof imapClientForAccount>>>();
  try {
    for (const group of groups.values()) {
      const accountId = group[0]!.account_id;
      try {
        const account = accountById(db, accountId);
        if (!account) {
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: "Account not found." });
          }
          continue;
        }
        const destination = resolveMoveDestination(db, accountId, target);
        if (!destination) {
          const unavailable = moveTargets[target].unavailableMessage;
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: unavailable });
          }
          continue;
        }
        if (destination.path === group[0]!.mailbox) {
          // Idempotent no-op: the whole group already lives in the target
          // folder (e.g. a second delete from the Trash view). Count every
          // entry as moved so the renderer clears them from the view.
          outcome.updated += group.length;
          continue;
        }
        let client = clientsByAccount.get(accountId);
        if (!client || !client.usable) {
          if (client) await client.logout().catch(() => undefined);
          // Drop the corpse first: a failed connect() must not stay cached.
          clientsByAccount.delete(accountId);
          client = await imapClientForAccount(account, masterKey, accessTokenProvider);
          await client.connect();
          clientsByAccount.set(accountId, client);
        }
        // The account-level write slot serializes this group behind any move
        // already in flight on the same account instead of failing the whole
        // group with a busy error.
        const groupOutcome = await withAccountWriteLocks([accountId], () =>
          moveMessagesInOneCommand(db, masterKey, group, destination, accessTokenProvider, agentEvents, client),
        );
        outcome.updated += groupOutcome.updated;
        outcome.failed += groupOutcome.failures.length;
        outcome.failures.push(...groupOutcome.failures);
        for (const pending of groupOutcome.pendingAccounts) outcome.pendingAccounts.add(pending);
      } catch {
        // Fall back to per-message moves so a group-level failure (e.g. a
        // guard error) keeps the previous per-message granularity.
        for (const entry of group) {
          try {
            const result = await moveMessage(db, masterKey, entry.id, target, accessTokenProvider, agentEvents, { client: clientsByAccount.get(accountId) });
            outcome.updated += 1;
            if (result.refreshPending) outcome.pendingAccounts.add(accountId);
          } catch (entryError) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: moveErrorMessage(entryError) });
          }
        }
      }
    }
  } finally {
    // A caller's cache is theirs to hang up; only one this call opened is closed.
    if (!connections) for (const client of clientsByAccount.values()) {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }
  return outcome;
}
