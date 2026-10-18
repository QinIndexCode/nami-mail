/**
 * The compiled statements the message-move paths issue, plus the helpers that
 * run them.
 *
 * Why this file exists
 * --------------------
 * Every move — a single one, a 100-message aggregated batch, or a chunk of a
 * 40 000-row background job — reaches the same handful of SQL statements
 * through the same code. Building them with `db.prepare` at the point of use
 * meant a 40 000-message job paid 240 000 `sqlite3_prepare` calls (measured:
 * 4.6s of the job's runtime) for SQL text that is byte-identical every time.
 * The statements are compiled once per database handle here and replayed with
 * the caller's bound parameters.
 *
 * Shape and lifecycle
 * -------------------
 * * Scope: keyed by the `DatabaseHandle` in a `WeakMap`, so a statement can
 *   only ever be handed back to the connection it was compiled against — a
 *   statement compiled for one database is never run against another, and the
 *   cache entry disappears with the handle it belongs to. A caller that wraps
 *   the handle in a proxy (the test-side `memoizingDb`) gets its own entry,
 *   which is the safe direction: a miss costs a compile, never a mismatch.
 * * Threading: the whole server is single-threaded and every move runs inside
 *   an already-serialized account write slot, so a lazily-built statement is
 *   compiled by the same synchronous call stack that first needs it. There is
 *   no await between the "is it compiled?" check and the assignment.
 * * Transaction boundary: this module never opens, extends or closes a
 *   transaction. Statements are compiled *outside* any transaction and only
 *   ever run inside the transaction their caller already opened, so each
 *   message keeps its own single-message transaction exactly as before.
 * * Laziness is load-bearing, not an optimization: the duplicate-destination
 *   statements only ever run for a message that has a `remote_id_lookup`, and
 *   the pending-reconciliation statements only ever run on a server without
 *   UIDPLUS. Compiling a statement the path would never execute would turn a
 *   conditional into an unconditional one, so every statement is compiled on
 *   first use and never before.
 *
 * Is replaying one Statement across transactions safe?
 * --------------------------------------------------
 * Yes, and it is what better-sqlite3 itself does: its `db.transaction()`
 * implementation keeps one prepared BEGIN / COMMIT / ROLLBACK / SAVEPOINT /
 * RELEASE / ROLLBACK TO set per connection in a `WeakMap` and re-runs them for
 * every transaction (`node_modules/better-sqlite3/lib/methods/transaction.js`),
 * so statement reuse across transaction boundaries is a property the driver
 * already depends on. Each `.run()/.get()/.all()` call resets the statement and
 * rebinds its parameters, so nothing from a previous call — including a
 * rolled-back one — survives: bindings are per-call, `changes` /
 * `lastInsertRowid` are per-call results, a read statement never pins a
 * snapshot, a statement created before an `ALTER TABLE` is re-prepared by
 * SQLite and keeps working, and a statement used inside a transaction still
 * sees that transaction's own uncommitted writes. `tests/sync-move-statements.test.ts`
 * pins all of that down against the real driver.
 *
 * Nothing here interpolates a value into SQL: every user-supplied value is a
 * bound parameter, and the only thing that varies in a statement's text is the
 * number of `?` placeholders.
 */
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";

export type MoveDestination = { path: string; special_use: string | null };

/** A cached destination row a confirmed move drops as a duplicate. */
export type MoveDuplicateRow = {
  id: string;
  mailbox: string;
  uid: number;
  remote_id_lookup: string | null;
  flags_json: string;
  all_mail_archived: number | null;
};

/** A stale \All / \Important / \Flagged / \Inbox mirror of a trashed message. */
export type TrashMirrorRow = {
  id: string;
  mailbox: string;
  uid: number;
  flags_json: string;
  all_mail_archived: number | null;
};

/** The driver's default prepared-statement type, resolved through a helper. */
function compile(db: DatabaseHandle, sql: string) {
  return db.prepare(sql);
}
export type MoveStatement = ReturnType<typeof compile>;

// Every statement below is the SQL the move paths issued before, character for
// character; only *where* it is compiled and *how often* changed.
const CLEAR_MOVE_INTENT_SQL = `
    UPDATE messages
    SET pending_move_destination = NULL,
        pending_move_state = NULL,
        pending_move_candidate_uid = NULL,
        pending_move_special_use = NULL
    WHERE id = ? AND pending_move_state = 'intent'
  `;
const BEGIN_MOVE_INTENT_SQL = `
      UPDATE messages
      SET pending_move_destination = ?,
          pending_move_state = 'intent',
          pending_move_candidate_uid = ?,
          pending_move_special_use = ?
      WHERE id = ? AND COALESCE(pending_move_destination, '') = ''
    `;
// The acceptance-time GOAL of a local-first move job. `pending_move_state` is
// deliberately NULL: every reader in the codebase already treats "a destination
// without the 'intent' state" as "this message belongs to the destination
// folder", which is exactly the user's goal the moment they confirm a bulk
// delete — the row leaves the source view immediately, the remote-deletion
// probe and backup skip it (they key off `pending_move_destination`), and the
// archived filter's COALESCE(state,'confirmed') files an archive goal in the
// archived view. 'intent' stays reserved for "the MOVE command may be in
// flight", which the worker writes below as it claims its own goal.
//
// The guard mirrors `moveActionBlockedError`: a row that already carries a
// destination is somebody else's pending move (or the user's own newer
// action) and must not be hijacked.
const BEGIN_MOVE_GOAL_SQL = `
    UPDATE messages
    SET pending_move_destination = ?,
        pending_move_special_use = ?,
        pending_move_candidate_uid = NULL,
        pending_move_state = NULL
    WHERE id = ? AND COALESCE(pending_move_destination, '') = '' AND pending_move_state IS NULL
  `;
// The worker claiming the goal it wrote at acceptance: `BEGIN_MOVE_INTENT_SQL`
// refuses any row that already has a destination, which is right for a user
// action and wrong for the job that owns the goal — it would block on its own
// record. This claims exactly the one case that belongs to the caller: a row
// whose untouched goal points at the very destination this move is going to.
const CLAIM_MOVE_GOAL_SQL = `
    UPDATE messages
    SET pending_move_destination = ?,
        pending_move_state = 'intent',
        pending_move_candidate_uid = ?,
        pending_move_special_use = ?
    WHERE id = ? AND (
      COALESCE(pending_move_destination, '') = ''
      OR (pending_move_state IS NULL AND pending_move_destination = ?)
    )
  `;
// Puts a goal back: the provider refused the message, or the work gave up on
// it. The guard is what makes this safe to run twice — only an untouched goal
// for this exact destination is cleared, so an intent the worker already
// claimed (and the recovery paths that own it) is never clobbered.
const CLEAR_MOVE_GOAL_SQL = `
    UPDATE messages
    SET pending_move_destination = NULL,
        pending_move_special_use = NULL,
        pending_move_candidate_uid = NULL,
        pending_move_state = NULL
    WHERE id = ? AND pending_move_state IS NULL AND pending_move_destination = ?
  `;
const CANDIDATE_UID_SQL = `
    SELECT uid FROM messages
    WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
    ORDER BY uid
    LIMIT 2
  `;
const PREFERRED_UID_IN_USE_SQL = `
    SELECT 1 FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?
  `;
const LOWEST_PENDING_UID_SQL = `
    SELECT MIN(uid) AS uid FROM messages
    WHERE account_id = ? AND mailbox = ? AND uid < 0
  `;
const UIDPLUS_DUPLICATE_ROWS_SQL = `
      SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
      FROM messages
      WHERE account_id = ? AND mailbox = ? AND uid = ? AND id <> ?
    `;
const UIDPLUS_REMOVE_DESTINATION_ROWS_SQL = `
      DELETE FROM messages
      WHERE account_id = ? AND mailbox = ? AND uid = ? AND id <> ?
    `;
const UIDPLUS_CONFIRM_SQL = `
      UPDATE messages
      SET mailbox = ?,
          uid = ?,
          all_mail_archived = ?,
          pending_move_destination = NULL,
          pending_move_state = NULL,
          pending_move_candidate_uid = NULL,
          pending_move_special_use = NULL
      WHERE id = ? AND pending_move_state = 'intent'
    `;
const RECONCILE_DUPLICATE_ROWS_SQL = `
        SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
        FROM messages
        WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
      `;
const RECONCILE_REMOVE_DESTINATION_ROWS_SQL = `
        DELETE FROM messages
        WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
      `;
const RECONCILE_CONFIRM_SQL = `
      UPDATE messages
      SET uid = ?,
          pending_move_destination = ?,
          pending_move_state = 'confirmed',
          pending_move_candidate_uid = ?,
          pending_move_special_use = ?,
          all_mail_archived = ?
      WHERE id = ? AND pending_move_state = 'intent'
    `;
const TRASH_SYSTEM_VIEW_MIRRORS_SQL = `
    SELECT id, mailbox, uid, flags_json, all_mail_archived
    FROM messages
    WHERE account_id = ?
      AND remote_id_lookup = ?
      AND id <> ?
      AND COALESCE(pending_move_destination, '') = ''
      AND pending_move_state IS NULL
      AND mailbox IN (
        SELECT path FROM folders
        WHERE account_id = ?
          AND (
            special_use IN ('\\All', '\\Important', '\\Flagged', '\\Inbox')
            OR path LIKE '[Gmail]/%'
          )
      )
  `;
const DELETE_MIRROR_ROW_SQL = `
    DELETE FROM messages
    WHERE id = ? AND account_id = ? AND mailbox = ?
      AND COALESCE(pending_move_destination, '') = ''
      AND pending_move_state IS NULL
  `;
const ROWS_BY_IDS_SELECT = "SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state";
/**
 * `resolveMoveDestination`'s folder lookup. The `?` count is the *only* thing
 * that varies — the special-use names are always bound — so one statement per
 * width covers every target.
 */
const resolveDestinationSql = (placeholders: string) => `
    SELECT path, special_use FROM folders
    WHERE account_id = ? AND special_use IN (${placeholders})
    ORDER BY CASE special_use
      WHEN '\\Archive' THEN 0
      WHEN '\\Trash' THEN 0
      ELSE 1
    END
    LIMIT 1
  `;

/**
 * The statements one connection's move paths use. Every field compiles on
 * first access, so a path that never reaches a statement never pays for it.
 */
export type MoveStatements = {
  /** Drops a claimed intent: refusal, recovery, and the stale-intent probe. */
  readonly clearMoveIntent: MoveStatement;
  /** Claims the durable 'intent' before the provider command is issued. */
  readonly beginMoveIntent: MoveStatement;
  /** Writes the acceptance-time goal of a local-first move job. */
  readonly beginMoveGoal: MoveStatement;
  /** Claims a job's own goal as an 'intent' before the command is issued. */
  readonly claimMoveGoal: MoveStatement;
  /** Puts an unclaimed goal back after a refusal or a give-up. */
  readonly clearMoveGoal: MoveStatement;
  /** The unique cached destination copy to reconcile onto, if there is one. */
  readonly candidateUid: MoveStatement;
  /** Is the preferred negative placeholder UID still occupied? */
  readonly preferredUidInUse: MoveStatement;
  /** Lowest negative UID in the mailbox, for the collision fallback. */
  readonly lowestPendingUid: MoveStatement;
  /** UIDPLUS path: destination duplicates, read *before* the DELETE below. */
  readonly uidPlusDuplicateRows: MoveStatement;
  readonly uidPlusRemoveDestinationRows: MoveStatement;
  readonly uidPlusConfirm: MoveStatement;
  /** No-UIDPLUS path: the same three steps, keyed by remote identity. */
  readonly reconcileDuplicateRows: MoveStatement;
  readonly reconcileRemoveDestinationRows: MoveStatement;
  readonly reconcileConfirm: MoveStatement;
  readonly trashSystemViewMirrors: MoveStatement;
  readonly deleteMirrorRow: MoveStatement;
  /** `batchMoveMessages`' row lookup, one compiled statement per IN width. */
  rowsByIds(size: number): MoveStatement;
  /** `resolveMoveDestination`'s lookup, one compiled statement per IN width. */
  destinationBySpecialUseCount(size: number): MoveStatement;
};

export function createMoveStatements(db: DatabaseHandle): MoveStatements {
  const compiled = new Map<string, MoveStatement>();
  const once = (key: string, sql: string): MoveStatement => {
    let statement = compiled.get(key);
    if (!statement) {
      statement = compile(db, sql);
      compiled.set(key, statement);
    }
    return statement;
  };
  // Only the `?` count varies here, never a value: the ids are always bound,
  // so the driver's per-statement variable ceiling still sees exactly the SQL
  // the uncached path issued. A batch job calls `batchMoveMessages` once per
  // MOVE_CHUNK_SIZE ids, so a 40 000-row job compiles 1 statement here instead
  // of 400 (measured on the origin snapshot's equivalent: 40 -> 2 compiles,
  // where repeated compilation was 58.8% of that lookup's runtime).
  const rowsBySize = new Map<number, MoveStatement>();
  const rowsByIds = (size: number): MoveStatement => {
    let statement = rowsBySize.get(size);
    if (!statement) {
      statement = compile(db, `${ROWS_BY_IDS_SELECT}\n    FROM messages\n    WHERE id IN (${new Array(size).fill("?").join(", ")})`);
      rowsBySize.set(size, statement);
    }
    return statement;
  };
  // The batch move path resolves one destination per (account, mailbox) group
  // and rebuilt this SQL each time (measured: 25 compiles of byte-identical SQL
  // for a 2500-row selection). `moveTargets` has exactly two special-use list
  // lengths — 2 for `archive` (`\Archive`, `\All`), 1 for `trash` / `junk` /
  // `inbox` — so the compiled statement is keyed by the `?` count and by
  // nothing else. The three width-1 targets therefore share one statement and
  // differ only in the values they bind, which is exactly what the uncached
  // path issued: same text, same precedence, same bound values. Keying on
  // anything else (the target name, a shared bucket) would hand a caller a
  // statement whose placeholder count does not match its bindings.
  const destinationByWidth = new Map<number, MoveStatement>();
  const destinationBySpecialUseCount = (size: number): MoveStatement => {
    let statement = destinationByWidth.get(size);
    if (!statement) {
      statement = compile(db, resolveDestinationSql(new Array(size).fill("?").join(", ")));
      destinationByWidth.set(size, statement);
    }
    return statement;
  };
  return {
    get clearMoveIntent() { return once("clearMoveIntent", CLEAR_MOVE_INTENT_SQL); },
    get beginMoveIntent() { return once("beginMoveIntent", BEGIN_MOVE_INTENT_SQL); },
    get beginMoveGoal() { return once("beginMoveGoal", BEGIN_MOVE_GOAL_SQL); },
    get claimMoveGoal() { return once("claimMoveGoal", CLAIM_MOVE_GOAL_SQL); },
    get clearMoveGoal() { return once("clearMoveGoal", CLEAR_MOVE_GOAL_SQL); },
    get candidateUid() { return once("candidateUid", CANDIDATE_UID_SQL); },
    get preferredUidInUse() { return once("preferredUidInUse", PREFERRED_UID_IN_USE_SQL); },
    get lowestPendingUid() { return once("lowestPendingUid", LOWEST_PENDING_UID_SQL); },
    get uidPlusDuplicateRows() { return once("uidPlusDuplicateRows", UIDPLUS_DUPLICATE_ROWS_SQL); },
    get uidPlusRemoveDestinationRows() { return once("uidPlusRemoveDestinationRows", UIDPLUS_REMOVE_DESTINATION_ROWS_SQL); },
    get uidPlusConfirm() { return once("uidPlusConfirm", UIDPLUS_CONFIRM_SQL); },
    get reconcileDuplicateRows() { return once("reconcileDuplicateRows", RECONCILE_DUPLICATE_ROWS_SQL); },
    get reconcileRemoveDestinationRows() { return once("reconcileRemoveDestinationRows", RECONCILE_REMOVE_DESTINATION_ROWS_SQL); },
    get reconcileConfirm() { return once("reconcileConfirm", RECONCILE_CONFIRM_SQL); },
    get trashSystemViewMirrors() { return once("trashSystemViewMirrors", TRASH_SYSTEM_VIEW_MIRRORS_SQL); },
    get deleteMirrorRow() { return once("deleteMirrorRow", DELETE_MIRROR_ROW_SQL); },
    rowsByIds,
    destinationBySpecialUseCount,
  };
}

/** One statement bundle per connection, alive exactly as long as its handle. */
const bundles = new WeakMap<DatabaseHandle, MoveStatements>();

export function moveStatements(db: DatabaseHandle): MoveStatements {
  const existing = bundles.get(db);
  if (existing) return existing;
  const created = createMoveStatements(db);
  bundles.set(db, created);
  return created;
}

// `messageIsUnseen`, `updateFolderCountsForMove`, `countSourceFolderDeparture`
// and `revertSourceFolderDeparture` used to live here, along with the two
// `UPDATE folders SET total = ..., unseen = ...` statements they ran. All four
// are deleted with the count columns (contract §3.6): a move now changes only
// which rows `messages` holds, and every sidebar number is derived from that
// table, so there is no counter to decrement here, nothing for the acceptance
// commit to take out early, and nothing for a refusal to hand back. The
// depart/revert pair's whole reason to exist -- that a clamped ±1 counter is not
// an identity under composition -- disappears with the counter.
//
// What did NOT move with them: the UIDPLUS/reconcile bookkeeping above, the
// mirror-row deletion below, and the move's own state machine. Those change rows,
// not counters.

export function pendingMoveUid(
  statements: MoveStatements,
  accountId: string,
  mailbox: string,
  sourceUid: number,
): number {
  const preferredUid = -sourceUid;
  const preferredInUse = statements.preferredUidInUse.get(accountId, mailbox, preferredUid);
  if (!preferredInUse) return preferredUid;

  // UIDVALIDITY resets can make a new live UID collide with the negative
  // placeholder left by an older pending move. Allocate below the current
  // local negative range; this UID is never sent back to the server.
  const lowestPendingUid = statements.lowestPendingUid.get(accountId, mailbox) as { uid: number | null };
  const nextUid = (lowestPendingUid.uid ?? 0) - 1;
  if (!Number.isSafeInteger(nextUid)) throw new Error("Too many pending message moves to allocate a local identifier.");
  return nextUid;
}

export function cachedDestinationCandidateUid(
  statements: MoveStatements,
  accountId: string,
  destinationMailbox: string,
  remoteIdLookupValue: string | null,
  sourceMessageId: string,
): number | null {
  if (!remoteIdLookupValue) return null;
  const candidates = statements.candidateUid.all(accountId, destinationMailbox, remoteIdLookupValue, sourceMessageId) as Array<{ uid: number }>;
  if (candidates.length !== 1) return null;
  const candidateUid = candidates[0]?.uid;
  return typeof candidateUid === "number" && Number.isSafeInteger(candidateUid) && candidateUid > 0
    ? candidateUid
    : null;
}

/**
 * Gmail's IMAP virtual folders exclude messages in Trash, but the local cache
 * keeps one row per folder view. After a confirmed move to \Trash those mirror
 * rows are stale and would keep deleted mail visible in the All Mail /
 * Important views until the slow remote-deletion probe sweep happens to reach
 * them. Removes them — the affected folders' counts need no adjustment, since
 * they are derived from the rows this deletes (contract §3.6). Custom-label
 * folder rows are kept: Gmail preserves those labels on trashed messages.
 *
 * Gmail reports \All / \Flagged / \Inbox via LIST special-use but not
 * \Important (the 重要 folder arrives with special_use NULL), so system views
 * are additionally matched by the provider's reserved "[Gmail]/" namespace
 * prefix — the prefix is locale-independent while the folder suffix is not.
 * User labels live at the top level and never match. Shared by the UIDPLUS and
 * pending-reconciliation move paths.
 */
export function removeTrashSystemViewMirrors(
  statements: MoveStatements,
  message: { account_id: string; remote_id_lookup: string | null },
  messageId: string,
  agentEvents?: AgentMailEventSink,
  agentLease?: ReturnType<NonNullable<AgentMailEventSink["acquireLease"]>>,
): void {
  if (!message.remote_id_lookup) return;
  const mirrorRows = statements.trashSystemViewMirrors.all(message.account_id, message.remote_id_lookup, messageId, message.account_id) as TrashMirrorRow[];
  if (!mirrorRows.length) return;
  for (const mirror of mirrorRows) {
    statements.deleteMirrorRow.run(mirror.id, message.account_id, mirror.mailbox);
    if (agentEvents && agentLease) {
      agentEvents.messageDeletedWithinTransaction(agentLease, mirror.id, {
        reason: "move-mirror-removed",
        mailbox: mirror.mailbox,
        uid: mirror.uid,
        remoteIdLookup: message.remote_id_lookup,
        flagsJson: mirror.flags_json,
        allMailArchived: mirror.all_mail_archived,
      });
    }
  }
}
