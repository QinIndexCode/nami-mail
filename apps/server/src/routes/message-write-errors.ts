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
import { moveRefusalMessage, type MoveRefusalSelection } from "../move-refusals.js";
import { MOVE_FOLDER_UNAVAILABLE_ERROR } from "../move-destinations.js";
import type { MoveRefusalReason } from "../tasks/index.js";

// Re-exported rather than moved out of every importer's reach: the routes read
// their failure vocabulary from this module, and the Agent service reads the
// same mapping from `move-refusals.ts`.
export { moveRefusalMessage };

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/**
 * The same refusal as the error the single-message route answers with.
 *
 * A plain `Error` on purpose: the route's own catch runs it through
 * `mailFailure` + {@link moveActionErrorMessage}, which is what maps every local
 * refusal to 422 with the message intact -- the exact path this route took before
 * the acceptance existed, so nothing about the answer changes for the renderer.
 */
export function moveRefusalError(reason: MoveRefusalReason, selection: MoveRefusalSelection): Error {
  return new Error(moveRefusalMessage(reason, selection));
}

export function moveActionErrorMessage(error: unknown): string {
  const message = failureMessage(error);
  const knownLocalErrors = new Set([
    "Message not found.",
    "Account not found.",
    "邮件服务器未确认移动操作，请稍后重试。",
    "这个邮箱没有提供可用的归档文件夹。",
    "这个邮箱没有提供可用的废纸篓文件夹。",
    MOVE_FOLDER_UNAVAILABLE_ERROR,
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
