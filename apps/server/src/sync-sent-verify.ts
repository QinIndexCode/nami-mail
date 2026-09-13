/**
 * Sent-mailbox verification extracted from sync.ts.
 *
 * This module contains the IMAP-only confirmation pass that verifies a
 * provider stored a sent copy after SMTP acceptance. It depends on
 * sync.ts for the account lookup and outbox helpers for submission state.
 */
import type { ListResponse } from "imapflow";
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { markSubmissionConfirmed, submissionForId } from "./outbox.js";
import { accountById } from "./sync.js";

const scheduledSentVerifications = new Map<string, Promise<void>>();
const sentVerificationRetryDelaysMs = [0, 2_000, 10_000] as const;

function backgroundDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    // Delayed verification must not keep the desktop process alive while it
    // is closing. The next regular sync can still reconcile the status.
    timer.unref?.();
  });
}

/**
 * Checks the provider's live Sent mailbox for one exact RFC Message-ID.
 * A match confirms that the provider stored a sent copy; it does not claim
 * recipient delivery or a read receipt, which IMAP/SMTP cannot establish.
 */
export async function verifySubmissionInSentMailbox(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  messageId: string,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<boolean> {
  const account = accountById(db, accountId);
  if (!account) throw new Error("Account not found.");
  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  try {
    await client.connect();
    const sentFolders = (await client.list()).filter(
      (folder: ListResponse) => folder.listed && !folder.flags.has("\\Noselect") && folder.specialUse === "\\Sent",
    );
    for (const folder of sentFolders) {
      const lock = await client.getMailboxLock(folder.path);
      try {
        // HEADER is only a candidate lookup. Fetch and compare the returned
        // ENVELOPE so a partial header match can never confirm another mail.
        const matchingUids = await client.search({ header: { "Message-ID": messageId } }, { uid: true });
        if (!matchingUids) continue;
        for (const uid of matchingUids.slice(-20)) {
          const candidate = await client.fetchOne(uid, { envelope: true }, { uid: true });
          if (candidate && candidate.envelope?.messageId === messageId) return true;
        }
      } finally {
        lock.release();
      }
    }
    return false;
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

type SentVerificationScheduleOptions = {
  abortSignal?: AbortSignal;
  onDeferred?: (error: unknown) => void;
};

/**
 * Starts a bounded, IMAP-only confirmation pass after SMTP acceptance or an
 * uncertain SMTP disconnect. It never calls SMTP and therefore cannot create
 * a duplicate message. A delayed/missing Sent copy leaves the durable status
 * as submitted or unknown_delivery for the normal periodic sync to revisit.
 */
export function scheduleSentSubmissionVerification(
  db: DatabaseHandle,
  masterKey: Buffer,
  submissionId: string,
  accessTokenProvider?: AccountAccessTokenProvider,
  options: SentVerificationScheduleOptions = {},
): void {
  if (scheduledSentVerifications.has(submissionId)) return;
  const job = (async () => {
    let lastVerificationError: unknown;
    for (const delay of sentVerificationRetryDelaysMs) {
      if (delay > 0) await backgroundDelay(delay);
      if (options.abortSignal?.aborted) return;
      try {
        const submission = submissionForId(db, masterKey, submissionId);
        if (!submission || (submission.deliveryStatus !== "submitted" && submission.deliveryStatus !== "unknown_delivery")) {
          return;
        }
        const foundInSent = await verifySubmissionInSentMailbox(
          db,
          masterKey,
          submission.accountId,
          submission.messageId,
          accessTokenProvider,
        );
        if (options.abortSignal?.aborted) return;
        if (foundInSent) {
          markSubmissionConfirmed(db, masterKey, submission.id);
          return;
        }
      } catch (error) {
        lastVerificationError = error;
      }
    }
    if (!options.abortSignal?.aborted && lastVerificationError) options.onDeferred?.(lastVerificationError);
  })();
  scheduledSentVerifications.set(submissionId, job);
  void job.finally(() => {
    if (scheduledSentVerifications.get(submissionId) === job) scheduledSentVerifications.delete(submissionId);
  });
}
