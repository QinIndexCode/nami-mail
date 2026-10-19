/**
 * What a move target names, and the one lookup that turns a name or an explicit
 * folder path into a provider destination.
 *
 * Split out of sync-moves.ts (a frozen-size monolith) because the task layer's
 * acceptance asks the same question without running a move: acceptance refuses
 * an unreachable destination before it commits a goal, and the runner resolves
 * it again before dialling. Keeping both spellings here is what stops the
 * acceptance and the engine from answering differently.
 */
import type { DatabaseHandle } from "./db.js";
import { moveStatements, type MoveDestination } from "./sync-move-statements.js";

export type MessageMoveTarget = "archive" | "trash" | "junk" | "inbox";

/** Exported for the refused-move vocabulary: `move-refusals.ts` reads its wording. */
export const moveTargets: Record<MessageMoveTarget, { specialUses: string[]; unavailableMessage: string }> = {
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

/**
 * The refusal an explicit-folder move answers when the folder is not in the
 * message's account. Shared with the task layer's acceptance, which refuses the
 * same condition without a provider call: the sentence is the one both entries
 * have always used, and a second copy would be a second wording for one fact.
 */
export const MOVE_FOLDER_UNAVAILABLE_ERROR = "目标文件夹不存在或不可用。";

/**
 * The folder a path names inside one account, or `null` when that account has
 * no such folder.
 *
 * The one definition of "is this folder addressable": the direct move path and
 * the task acceptance both ask it, because the acceptance refuses before
 * committing a goal and the runner re-resolves before dialling. Ownership is
 * part of the lookup -- the account is an equality term, not a post-check --
 * which is what keeps a path from one account out of another's move.
 */
export function resolveFolderDestination(
  db: DatabaseHandle,
  accountId: string,
  folderPath: string,
): MoveDestination | null {
  const folder = db.prepare(`
    SELECT path, special_use FROM folders WHERE account_id = ? AND path = ?
  `).get(accountId, folderPath) as MoveDestination | undefined;
  return folder ?? null;
}

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
