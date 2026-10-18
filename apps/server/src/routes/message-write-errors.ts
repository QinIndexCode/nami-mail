/**
 * Failure mapping for the message write routes.
 *
 * Each route has to answer one question the same way: is this failure one the
 * server authored and can hand back verbatim, or is it a provider error whose
 * text has to be replaced with something a reader can act on? The local side
 * answers with a fixed vocabulary of messages (a set membership test); anything
 * else goes through `friendlyMailError`. The status codes follow the same split.
 *
 * They live here rather than in `messages.ts` so that file stays under the
 * monolith ratchet, and because the six of them together are the writer-facing
 * vocabulary: they should be read as a set, not five hundred lines apart.
 */
import { friendlyMailError } from "../mail.js";
import {
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
} from "../message-storage.js";
import { moveTargets, type MessageMoveTarget } from "../sync-moves.js";
import type { MoveRefusalReason } from "../tasks/index.js";

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/**
 * Why a move acceptance refused one id, in the words that refusal has always
 * been answered in.
 *
 * The acceptance carries the reason and no text (`kinds/move.ts`): the wording is
 * the routes' business because the two entries answer the same reason
 * differently -- this one throws it, the explicit batch route reports one entry
 * per id -- and because a task row per message in five locales is not a thing.
 * One mapping, two readers ({@link moveRefusalError}, {@link moveRefusalMessage}),
 * so the two entries cannot drift into telling the user different stories about
 * the same refusal.
 *
 * Three of the five sentences come straight from constants rather than being
 * retyped, and the fourth from the target table, so this file owns no move
 * wording of its own. `claimed` deliberately shares `reconciling`'s sentence: to
 * the reader both mean "another move owns this message, wait for the reconcile",
 * and the difference between them (who restores it) is internal. Contract §0.4
 * 十五 W3.
 */
export function moveRefusalMessage(reason: MoveRefusalReason, target: MessageMoveTarget): string {
  switch (reason) {
    case "not_found": return "Message not found.";
    case "unavailable": return moveTargets[target].unavailableMessage;
    case "reconciling": return PENDING_MOVE_RECONCILIATION_ERROR;
    case "location_unverified": return MOVE_LOCATION_UNVERIFIED_ERROR;
    case "claimed": return PENDING_MOVE_RECONCILIATION_ERROR;
  }
}

/**
 * The same refusal as the error the single-message route answers with.
 *
 * A plain `Error` on purpose: the route's own catch runs it through
 * `mailFailure` + {@link moveActionErrorMessage}, which is what maps every local
 * refusal to 422 with the message intact -- the exact path this route took before
 * the acceptance existed, so nothing about the answer changes for the renderer.
 */
export function moveRefusalError(reason: MoveRefusalReason, target: MessageMoveTarget): Error {
  return new Error(moveRefusalMessage(reason, target));
}

export function moveActionErrorMessage(error: unknown): string {
  const message = failureMessage(error);
  const knownLocalErrors = new Set([
    "Message not found.",
    "Account not found.",
    "邮件服务器未确认移动操作，请稍后重试。",
    "这个邮箱没有提供可用的归档文件夹。",
    "这个邮箱没有提供可用的废纸篓文件夹。",
    MAILBOX_SYNCING_ERROR,
    MAIL_MOVE_IN_FLIGHT_ERROR,
    PENDING_MOVE_RECONCILIATION_ERROR,
    MOVE_LOCATION_UNVERIFIED_ERROR,
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

export function messageFlagActionErrorMessage(error: unknown): string {
  const message = failureMessage(error);
  const knownLocalErrors = new Set(["Message not found.", "Account not found.", PENDING_MOVE_RECONCILIATION_ERROR, MOVE_LOCATION_UNVERIFIED_ERROR]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

export function draftActionErrorMessage(error: unknown): string {
  const message = failureMessage(error);
  const knownLocalErrors = new Set([
    "Account not found.",
    "这个邮箱没有提供可用的草稿文件夹。",
    "邮件服务器未确认草稿保存，请稍后重试。",
    "邮件服务器未确认草稿删除，请稍后重试。",
    "无法生成草稿内容，请重试。",
    "Draft not found.",
    "Message is not a draft.",
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

export function draftDiscardErrorStatus(error: unknown): number {
  const message = failureMessage(error);
  if (message === "Draft not found.") return 404;
  if (message === "Message is not a draft.") return 409;
  return 422;
}

export function attachmentActionErrorMessage(error: unknown): string {
  const message = failureMessage(error);
  const knownLocalErrors = new Set([
    "Message not found.",
    "Attachment not found. Sync this message again.",
    "Attachment part is invalid.",
    "Attachment is no longer available in this mailbox. Sync this message again.",
    "Message is no longer available in this mailbox. Sync this message again.",
    "Account not found.",
    "Attachment download did not return a readable stream.",
    PENDING_MOVE_RECONCILIATION_ERROR,
    MOVE_LOCATION_UNVERIFIED_ERROR,
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

export function attachmentErrorStatus(error: unknown): number {
  const message = failureMessage(error);
  if (message === "Attachment part is invalid.") return 400;
  if (message === "Message not found." || message === "Attachment not found. Sync this message again.") return 404;
  if (message === "Attachment is no longer available in this mailbox. Sync this message again." || message === "Message is no longer available in this mailbox. Sync this message again.") return 409;
  return 422;
}
