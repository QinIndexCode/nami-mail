import type { DatabaseHandle } from "./db.js";
import { accountById } from "./account-store.js";
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import { discardDraft } from "./drafts.js";
import type { AccountAccessTokenProvider } from "./mail.js";
import { sendMail } from "./mail.js";
import { messagePayloadById } from "./message-storage.js";
import {
  discardDraftOutboundAttachments,
  linkOutboundAttachmentsToSubmission,
  OutboundAttachmentError,
  releaseSubmissionOutboundAttachments,
  resolveOutboundAttachments,
} from "./outbound-attachments.js";
import {
  deliveryFailureStatus,
  markSubmissionFailed,
  markSubmissionSubmitted,
  markSubmissionUnknownDelivery,
  startSubmission,
  submissionForId,
  submissionRequestForId,
} from "./outbox.js";

export type ScheduledSendDependencies = {
  /** Outbound temporary-attachment directory resolved from runtime config. */
  outboundAttachmentDirectory: string;
  accessTokenProvider?: AccountAccessTokenProvider;
  agentMailEvents?: AgentMailEventSink;
  scheduleSentVerification: (submissionId: string) => void;
  onFailure?: (submissionId: string, error: unknown) => void;
};

function storedDraftMessageId(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  localDraftId: string | undefined,
): string | undefined {
  if (!localDraftId) return undefined;
  const stored = messagePayloadById(db, masterKey, localDraftId);
  return stored?.row.account_id === accountId ? stored.payload.messageId ?? undefined : undefined;
}

function threadingHeaders(message: { inReplyTo?: string; references?: string[] }) {
  const references = [...new Set([
    ...(message.references ?? []),
    ...(message.inReplyTo ? [message.inReplyTo] : []),
  ])].slice(-50);
  return {
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(references.length ? { references } : {}),
  };
}

// Bounded pool for due sends. Each submission spends most of its time inside
// an SMTP conversation, so a backlog that accumulated while the app was
// closed would otherwise serialize into N sequential round trips; a fixed
// cap keeps the client, the outbox directory, and the SMTP server from being
// hammered all at once.
const SCHEDULED_SEND_CONCURRENCY = 4;

/**
 * Submits scheduled sends whose time has arrived through the same SMTP
 * pipeline as the interactive send route. The durable submission keeps the
 * exact RFC Message-ID and attachment links, so a process interruption can
 * never create a duplicate email.
 */
export async function submitDueScheduledSubmissions(
  db: DatabaseHandle,
  masterKey: Buffer,
  deps: ScheduledSendDependencies,
  nowIso = new Date().toISOString(),
): Promise<{ submitted: number; failed: number }> {
  const due = db.prepare(`
    SELECT id FROM outbound_submissions
    WHERE status = 'pending' AND send_at IS NOT NULL AND send_at <= ?
    ORDER BY send_at ASC
  `).all(nowIso) as Array<{ id: string }>;
  if (!due.length) return { submitted: 0, failed: 0 };

  let submitted = 0;
  let failed = 0;
  const submitOne = async (row: { id: string }): Promise<void> => {
    const submission = submissionForId(db, masterKey, row.id);
    if (!submission) return;
    const account = accountById(db, submission.accountId);
    if (!account) return;
    const request = submissionRequestForId(db, masterKey, row.id);
    if (!request) return;
    try {
      const attachments = resolveOutboundAttachments(
        db,
        deps.outboundAttachmentDirectory,
        masterKey,
        account.id,
        request.attachmentTokens,
      );
      linkOutboundAttachmentsToSubmission(db, account.id, row.id, request.attachmentTokens);
      const attempt = startSubmission(db, masterKey, row.id);
      if (!attempt.shouldAttempt) return;
      const result = await sendMail(account, masterKey, {
        to: request.to,
        cc: request.cc,
        messageId: attempt.submission.messageId,
        ...threadingHeaders(request),
        subject: request.subject,
        text: request.text,
        html: request.html,
        attachments,
      }, deps.accessTokenProvider);
      const confirmed = markSubmissionSubmitted(db, masterKey, row.id, result.messageId);
      deps.scheduleSentVerification(confirmed.id);

      if (request.discardDraftId) {
        try {
          const sourceDraftMessageId = storedDraftMessageId(db, masterKey, account.id, request.discardDraftId);
          await discardDraft(db, masterKey, account, request.discardDraftId, deps.accessTokenProvider, deps.agentMailEvents);
          if (sourceDraftMessageId) {
            discardDraftOutboundAttachments(db, deps.outboundAttachmentDirectory, account.id, sourceDraftMessageId);
          }
        } catch {
          // SMTP accepted the message. A failed draft cleanup is reported by
          // the next sync and must not change the terminal delivery status.
        }
      }
      try {
        releaseSubmissionOutboundAttachments(db, deps.outboundAttachmentDirectory, account.id, row.id);
      } catch {
        // The durable link prevents premature stale cleanup, so this can be
        // retried by a later pass without changing the send outcome.
      }
      submitted += 1;
    } catch (error) {
      try {
        if (error instanceof OutboundAttachmentError) {
          // An attachment that vanished before the send is a definitive,
          // diagnosable failure — never an ambiguous unknown-delivery state,
          // and never a reason to send without the file.
          markSubmissionFailed(db, masterKey, row.id, "attachment_unavailable", errorMessage(error));
        } else if (deliveryFailureStatus(error) === "failed") {
          markSubmissionFailed(db, masterKey, row.id, "scheduled_send_failed", errorMessage(error));
        } else {
          markSubmissionUnknownDelivery(db, masterKey, row.id, "scheduled_send_unknown", errorMessage(error));
        }
      } catch {
        // The status may have been claimed by another pass; keep moving.
      }
      failed += 1;
      try {
        deps.onFailure?.(row.id, error);
      } catch {
        // Reporting must not break the remaining scheduled sends.
      }
    }
  };

  // Each worker claims the next due row; the claim and the synchronous DB
  // transitions run on the same thread, so the cursor advance is atomic and
  // a row can never be processed twice even though the SMTP calls overlap.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SCHEDULED_SEND_CONCURRENCY, due.length) }, async () => {
    while (cursor < due.length) {
      const row = due[cursor]!;
      cursor += 1;
      await submitOne(row);
    }
  });
  await Promise.all(workers);
  return { submitted, failed };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Startup pass for scheduled sends parked before the route started linking
 * uploads at park time. Their durable requests carry the attachment tokens,
 * but no link row exists, so the 24h TTL cleanup would remove the uploads and
 * the due pass would fail long after the user expected the mail. Runs before
 * `cleanupExpiredOutboundAttachments`: tokens whose rows still exist and
 * belong to the task's account are re-linked idempotently; a task whose
 * upload is definitively gone is marked failed now with the same
 * `attachment_unavailable` code the send route reports — honesty over a
 * pending task that can only ever fail later.
 *
 * The due pass remains the final gate: it re-validates and reads the actual
 * bytes, so an upload that disappears after startup still fails at send time.
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
