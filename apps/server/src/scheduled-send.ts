/**
 * The startup repair pass for parked scheduled sends.
 *
 * The due pass this module used to own -- `submitDueScheduledSubmissions`, a
 * four-worker scan of `outbound_submissions WHERE send_at <= now` -- is gone: a
 * parked send is a `send` task carrying `due_at`, and the scheduler's claim
 * predicate is what decides when it runs, with the same serial-per-account
 * ordering every other write gets. What remains here is the one job that is about
 * the ledger and its uploads rather than about scheduling, and that has to happen
 * on every start, before the stale-attachment cleanup.
 */

import type { DatabaseHandle } from "./db.js";
import { linkOutboundAttachmentsToSubmission } from "./outbound-attachments.js";
import { markSubmissionFailed, submissionRequestForId } from "./outbox.js";

/**
 * Startup pass for scheduled sends parked before the route started linking
 * uploads at park time. Their durable requests carry the attachment tokens,
 * but no link row exists, so the 24h TTL cleanup would remove the uploads and
 * the send would fail long after the user expected the mail. Runs before
 * `cleanupExpiredOutboundAttachments`: tokens whose rows still exist and
 * belong to the task's account are re-linked idempotently; a submission whose
 * upload is definitively gone is marked failed now with the same
 * `attachment_unavailable` code the send route reports — honesty over a
 * pending task that can only ever fail later.
 *
 * Every submission the current acceptance parks is linked inside its own
 * transaction, so this pass serves the rows an older build left behind; it stays
 * because a start that skips it would let the cleanup take an upload a parked
 * send still names.
 *
 * The `send` attempt remains the final gate: it re-resolves and reads the actual
 * bytes, so an upload that disappears after startup still fails the task then, with
 * the same code (`tasks/kinds/send.ts`).
 */
export function restoreScheduledSubmissionAttachments(
  db: DatabaseHandle,
  masterKey: Buffer,
): { restored: number; failed: number } {
  const pending = db.prepare(`
    SELECT id, account_id FROM outbound_submissions
    WHERE status = 'pending' AND send_at IS NOT NULL
  `).all() as Array<{ id: string; account_id: string }>;
  let restored = 0;
  let failed = 0;
  for (const row of pending) {
    const request = submissionRequestForId(db, masterKey, row.id);
    if (!request?.attachmentTokens.length) continue;
    try {
      linkOutboundAttachmentsToSubmission(db, row.account_id, row.id, request.attachmentTokens);
      restored += 1;
    } catch (error) {
      try {
        markSubmissionFailed(
          db,
          masterKey,
          row.id,
          "attachment_unavailable",
          error instanceof Error ? error.message : "附件已不存在，无法发送。",
        );
        failed += 1;
      } catch {
        // The status may have been claimed elsewhere; keep moving.
      }
    }
  }
  return { restored, failed };
}
