import type { OutboundSubmission } from "@nami/agent-contracts";
import type { DatabaseHandle } from "../db.js";
import { submissionForId, submissionRequestForId, markSubmissionFailed, type OutboundSubmissionRequest } from "../outbox.js";
import { serverLog } from "../logging.js";

export type AutoReplyDelivery = {
  messageId: string; accountId: string; threadKey: string;
  submissionId: string; requestId: string; confirmationId: string;
};

export function trackAutoReplyDelivery(db: DatabaseHandle, row: AutoReplyDelivery, now: string): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO auto_reply_processed(message_id,account_id,decision,thread_key,occurred_at,updated_at)
      VALUES (?,?,'pending',?,?,?) ON CONFLICT(message_id) DO UPDATE SET decision='pending',thread_key=excluded.thread_key,updated_at=excluded.updated_at`)
      .run(row.messageId, row.accountId, row.threadKey, now, now);
    db.prepare(`INSERT INTO auto_reply_deliveries(message_id,submission_id,request_id,confirmation_id) VALUES (?,?,?,?)`)
      .run(row.messageId, row.submissionId, row.requestId, row.confirmationId);
  })();
}

const trackedSelect = `SELECT d.message_id AS messageId,p.account_id AS accountId,p.thread_key AS threadKey,
  d.submission_id AS submissionId,d.request_id AS requestId,d.confirmation_id AS confirmationId
  FROM auto_reply_deliveries d JOIN auto_reply_processed p ON p.message_id=d.message_id
  JOIN outbound_submissions s ON s.id=d.submission_id WHERE p.decision='pending'`;

export function resumableAutoReplyDeliveries(db: DatabaseHandle): AutoReplyDelivery[] {
  return db.prepare(`${trackedSelect} AND s.status='pending'
    AND NOT EXISTS(SELECT 1 FROM tasks WHERE submission_id=s.id) LIMIT 40`).all() as AutoReplyDelivery[];
}

/** An exception after a durable acceptance cannot turn a possibly live send into a failure. */
export function retainAcceptedAutoReply(db: DatabaseHandle, key: Buffer, messageId: string): boolean {
  const row = db.prepare(`SELECT s.id,s.status,EXISTS(SELECT 1 FROM tasks WHERE submission_id=s.id) AS dispatched
    FROM auto_reply_deliveries d JOIN outbound_submissions s ON s.id=d.submission_id WHERE d.message_id=?`).get(messageId) as
    { id: string; status: string; dispatched: number } | undefined;
  if (!row) return false;
  if (row.dispatched || row.status !== "pending") return true;
  markSubmissionFailed(db, key, row.id, "auto_reply_dispatch_failed", "The automatic reply could not be queued. No SMTP attempt was started.");
  return false;
}

export function reconcileAutoReplyDeliveries(db: DatabaseHandle, key: Buffer, now: string,
  onResult: (row: AutoReplyDelivery, submission: OutboundSubmission, request: OutboundSubmissionRequest, sent: boolean) => void): void {
  const rows = db.prepare(`${trackedSelect} AND s.status IN ('submitted','confirmed','failed') LIMIT 40`).all() as AutoReplyDelivery[];
  for (const row of rows) {
    try {
      const submission = submissionForId(db, key, row.submissionId);
      const request = submissionRequestForId(db, key, row.submissionId);
      if (!submission || !request) continue;
      const sent = submission.deliveryStatus !== "failed" && !submission.recipientDelivery?.rejected.length;
      const changed = db.prepare(`UPDATE auto_reply_processed SET decision=?,occurred_at=?,updated_at=? WHERE message_id=? AND decision='pending'`)
        .run(sent ? "sent" : "failed", sent ? submission.submittedAt ?? now : now, now, row.messageId).changes;
      if (changed) onResult(row, submission, request, sent);
    } catch (error) { serverLog.warn({ messageId: row.messageId }, "Auto-reply delivery reconciliation failed", error); }
  }
}
