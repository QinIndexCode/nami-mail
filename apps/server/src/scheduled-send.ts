import type { DatabaseHandle } from "./db.js";
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import { discardDraft } from "./drafts.js";
import type { AccountAccessTokenProvider } from "./mail.js";
import { sendMail } from "./mail.js";
import { messagePayloadById } from "./message-storage.js";
import {
  discardDraftOutboundAttachments,
  linkOutboundAttachmentsToSubmission,
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
import type { AccountRecord } from "./types.js";

export type ScheduledSendDependencies = {
  /** Outbound temporary-attachment directory resolved from runtime config. */
  outboundAttachmentDirectory: string;
  accessTokenProvider?: AccountAccessTokenProvider;
  agentMailEvents?: AgentMailEventSink;
  scheduleSentVerification: (submissionId: string) => void;
  onFailure?: (submissionId: string, error: unknown) => void;
};

function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}

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
  for (const row of due) {
    const submission = submissionForId(db, masterKey, row.id);
    if (!submission) continue;
    const account = accountById(db, submission.accountId);
    if (!account) continue;
    const request = submissionRequestForId(db, masterKey, row.id);
    if (!request) continue;
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
      if (!attempt.shouldAttempt) continue;
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
        if (deliveryFailureStatus(error) === "failed") {
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
  }
  return { submitted, failed };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
