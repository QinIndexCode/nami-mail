/**
 * What a batch move reports back with: the outcome one row of it resolves to,
 * and the message a failed entry is described by.
 *
 * Split out of sync-moves.ts (a frozen-size monolith) because this is the
 * reporting vocabulary rather than the move engine: the batch-job executor and
 * the batch-move route read it, and neither needs the engine to do so.
 */
import { friendlyMailError } from "./mail.js";
import {
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
} from "./message-storage.js";

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
  // The two "wait your turn" conditions are local, retryable states, not
  // provider failures. They stay verbatim so the batch-job executor can tell a
  // retryable refusal from a terminal one by its message — flattening them into
  // the generic provider error would make a bulk move give its goals back
  // instead of retrying them. Same treatment the route layer already gives them
  // (see `knownLocalErrors` in routes/messages.ts).
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
]);

export function moveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return knownLocalMoveErrors.has(message) ? message : friendlyMailError(error);
}
