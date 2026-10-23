/**
 * Message move operations extracted from sync.ts.
 *
 * This module contains the moving itself: single-message moves, batch moves
 * via aggregated IMAP MOVE commands, and the UIDPLUS / pending-reconciliation
 * persistence helpers shared by both paths. What a target names and how a name
 * or path resolves to a provider folder lives in `move-destinations.ts`, which
 * the task layer also asks without issuing a move.
 *
 * The module imports write-lock infrastructure and account state accessors
 * from sync.ts but does not depend on syncAccount itself, keeping the
 * dependency edge one-directional.
 */
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { moveErrorMessage, type BatchMessageMoveOutcome } from "./batch-move-outcome.js";
import {
  MOVE_FOLDER_UNAVAILABLE_ERROR,
  moveTargets,
  resolveFolderDestination,
  resolveMoveDestination,
  type MessageMoveTarget,
} from "./move-destinations.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import {
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
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
import { isRecoverableStaleMove, recoverStaleMoveIntent } from "./move-recovery.js";
import { UID_GENERATION_CHANGED_ERROR, liveUidValidity, moveAcceptanceEvidence, partitionRefusedByGeneration, refuseRebuiltMailbox, type AcceptedUidGeneration } from "./mailbox-generation.js";
import {
  cachedDestinationCandidateUid,
  moveStatements,
  pendingMoveUid,
  removeTrashSystemViewMirrors,
  type MoveDestination,
  type MoveDuplicateRow,
} from "./sync-move-statements.js";

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
  const folder = resolveFolderDestination(db, message.account_id, folderPath);
  if (!folder) throw new Error(MOVE_FOLDER_UNAVAILABLE_ERROR);
  return moveMessageCore(db, masterKey, messageId, folder, accessTokenProvider, agentEvents, options);
}

export type MoveMessageOptions = {
  /** A connected IMAP client to reuse (batch moves share one per account). */
  client?: Awaited<ReturnType<typeof imapClientForAccount>>;
  /** Overrides how long the move waits for a running sync pass (tests). */
  syncWaitMs?: number;
  /**
   * The generation the caller froze when it accepted this move. Omitted, the
   * cache's current value is used instead -- correct for an immediate move,
   * because the account's write slot keeps a sync from rewriting `folders`
   * between the read and the lock. A queued move passes its acceptance-time
   * value; `null` (froze none) is refused, not back-filled.
   */
  expectedUidValidity?: string | null;
};

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

/**
 * Runs a move on a destination the caller has already resolved. The batch
 * fallback uses it so an explicit folder and a named target share one path, and
 * so a row carrying the batch's own acceptance-time goal reaches
 * `moveMessageCore`, which is where that goal is claimed. The public single-
 * message entries keep their own pre-checks: a reconciling move must be
 * reported before the destination lookup can fail for an unrelated reason.
 */
async function moveEntryToDestination(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  accountId: string,
  destination: MoveDestination,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  options?: MoveMessageOptions,
): Promise<MessageMoveResult> {
  return withAccountWriteLocks([accountId], () =>
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
  /**
   * The generation of `mailbox` as the cache recorded it. Read in the same
   * statement as the row, so it is the generation this UID was last written
   * under -- falling back to it is the best evidence an immediate move has.
   */
  origin_uid_validity?: string | null;
};

/**
 * Persists the UIDPLUS-confirmed outcome of a provider MOVE: the row is
 * rebound to the exact destination UID and duplicate destination rows from a
 * cached \All copy are dropped. Shared by single-message moves and aggregated
 * batch moves so both keep identical intent/UIDPLUS semantics.
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
    statements.uidPlusRemoveDestinationRows.run(message.account_id, destination.path, destinationUid, messageId);
    const updated = statements.uidPlusConfirm.run(destination.path, destinationUid, destination.special_use === "\\All" ? 1 : null, messageId);
    if (updated.changes !== 1) throw new Error("Move intent was not available for UIDPLUS reconciliation.");
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
    if (message.remote_id_lookup) {
      statements.reconcileRemoveDestinationRows.run(message.account_id, destination.path, message.remote_id_lookup, messageId);
    }
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

/**
 * True when the row carries this move's own acceptance-time goal: a destination
 * a local-first job wrote when the user confirmed the selection, not yet
 * claimed as an intent. `moveActionBlockedError` exists to stop a *user* action
 * from hijacking somebody's pending move; the worker that owns the goal has to
 * get past its own record, and only for the destination it was accepted for —
 * a goal pointing elsewhere is a newer user decision and still blocks.
 */
function ownsMoveGoal(message: MoveMessageFields, destination: MoveDestination): boolean {
  return message.pending_move_state === null && message.pending_move_destination === destination.path;
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
    // A local-first job's own acceptance-time goal is not "another move in
    // progress": the job owns that record and claims it below, instead of
    // blocking on its own bookkeeping.
    const claimedGoal = ownsMoveGoal(message, destination);
    let moveBlockedError = claimedGoal ? null : moveActionBlockedError(message);
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
    // A goal the job wrote at acceptance is claimed through the statement that
    // admits it; anything else keeps the original "no destination yet" claim.
    const beganIntent = claimedGoal
      ? statements.claimMoveGoal.run(destination.path, intentCandidateUid, destination.special_use, messageId, destination.path)
      : statements.beginMoveIntent.run(destination.path, intentCandidateUid, destination.special_use, messageId);
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
      // Nothing has been sent yet, so clearing the intent is the whole rollback.
      try {
        refuseRebuiltMailbox(db, message.account_id, message.mailbox, client, options?.expectedUidValidity);
      } catch (error) {
        clearMoveIntent.run(messageId);
        throw error;
      }
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
    await safeLogout(ownedClient);
  }
}

// ---------------------------------------------------------------------------
// Batch moves
// ---------------------------------------------------------------------------

// The outcome shape lives with the error vocabulary it is reported with.
export type { BatchMessageMoveOutcome } from "./batch-move-outcome.js";

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
  /** Acceptance-time generations, keyed by message id (see `batchMoveMessages`). */
  acceptedGenerations?: ReadonlyMap<string, AcceptedUidGeneration>,
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
  // Every claimed entry remembers whether it came from the job's own
  // acceptance-time goal: those rows already left their source folder when the
  // selection was accepted, so the confirm step must not count that departure
  // a second time.
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
      // A row carrying this job's own acceptance-time goal is not blocked by
      // its own record; it is claimed through the statement that admits it.
      const claimedGoal = ownsMoveGoal(entry, destination);
      let moveBlockedError = claimedGoal ? null : moveActionBlockedError(entry);
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
      const beganIntent = claimedGoal
        ? statements.claimMoveGoal.run(destination.path, intentCandidateUid, destination.special_use, entry.id, destination.path)
        : statements.beginMoveIntent.run(destination.path, intentCandidateUid, destination.special_use, entry.id);
      if (beganIntent.changes !== 1) {
        outcome.failures.push({ id: entry.id, message: PENDING_MOVE_RECONCILIATION_ERROR });
        continue;
      }
      claimed.push(entry);
    }
    if (claimed.length === 0) return outcome;

    const lock = await client.getMailboxLock(claimed[0]!.mailbox);
    try {
      // The generation check (see `mailbox-generation.ts`): under this lock and
      // before the command, because the live value only means something once the
      // mailbox is selected. Nothing was sent for the refused ids.
      const refused = partitionRefusedByGeneration(claimed, liveUidValidity(client), acceptedGenerations);
      if (refused.length > 0) {
        for (const entry of refused) {
          clearMoveIntent.run(entry.id);
          outcome.failures.push({ id: entry.id, message: UID_GENERATION_CHANGED_ERROR });
        }
        // Also the runner's "kick a sync" channel: a pass is what fixes this.
        outcome.pendingAccounts.add(accountId);
        if (claimed.length === 0) return outcome;
      }
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
 * A selection is either a named target or an explicit folder path. Both are
 * resolved once per group, and the path form is validated against each group's
 * own account, so one selection can span accounts without leaking a folder
 * name across them.
 *
 * A caller running many batches in a row passes the `connections` cache it
 * owns, paying one connect per account for the whole run instead of per batch.
 *
 * `acceptedGenerations` carries what each id's acceptance froze (the `move`
 * task's `task_items`). An id missing from it is judged by the cache -- the
 * right evidence for an immediate call -- while one the task accepted without
 * freezing a generation is refused instead.
 */
export async function batchMoveMessages(
  db: DatabaseHandle,
  masterKey: Buffer,
  ids: string[],
  selection: MessageMoveTarget | { folderPath: string },
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  connections?: Map<string, Awaited<ReturnType<typeof imapClientForAccount>>>,
  acceptedGenerations?: ReadonlyMap<string, AcceptedUidGeneration>,
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
      // Resolved before the guarded block and kept for the per-entry fallback:
      // a group-level failure after resolution still knows where each entry was
      // headed. Only a failure during resolution itself leaves it null.
      let destination: MoveDestination | null = null;
      try {
        const account = accountById(db, accountId);
        if (!account) {
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: "Account not found." });
          }
          continue;
        }
        destination = typeof selection === "string"
          ? resolveMoveDestination(db, accountId, selection)
          : resolveFolderDestination(db, accountId, selection.folderPath);
        if (!destination) {
          const unavailable = typeof selection === "string"
            ? moveTargets[selection].unavailableMessage
            : MOVE_FOLDER_UNAVAILABLE_ERROR;
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: unavailable });
          }
          continue;
        }
        // A local binding after the guard: the callback below is a closure, and
        // a closure does not preserve the narrowing of the outer `let`.
        const resolved = destination;
        if (resolved.path === group[0]!.mailbox) {
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
          moveMessagesInOneCommand(db, masterKey, group, resolved, accessTokenProvider, agentEvents, client, acceptedGenerations),
        );
        outcome.updated += groupOutcome.updated;
        outcome.failed += groupOutcome.failures.length;
        outcome.failures.push(...groupOutcome.failures);
        for (const pending of groupOutcome.pendingAccounts) outcome.pendingAccounts.add(pending);
      } catch (error) {
        // Fall back to per-message moves so a group-level failure (e.g. a
        // guard error) keeps the previous per-message granularity. A failure
        // before the destination was resolved has nothing to fall back to, so
        // its error is the only thing to report per entry.
        if (!destination) {
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
          }
          continue;
        }
        for (const entry of group) {
          try {
            // One move at a time: the acceptance evidence must be carried, or a queued id is judged by the cache.
            const evidence = moveAcceptanceEvidence(entry, acceptedGenerations);
            const result = await moveEntryToDestination(
              db,
              masterKey,
              entry.id,
              accountId,
              destination,
              accessTokenProvider,
              agentEvents,
              { client: clientsByAccount.get(accountId), ...(evidence.source === "accepted" ? { expectedUidValidity: evidence.value } : {}) },
            );
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
      await safeLogout(client);
    }
  }
  return outcome;
}
