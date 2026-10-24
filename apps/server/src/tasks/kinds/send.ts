import { accountById } from "../../account-store.js";
import type { AgentMailEventSink } from "../../agent/mail-state-events.js";
import type { DatabaseHandle } from "../../db.js";
import { discardDraft } from "../../drafts.js";
import { safeMailError, sendMail, type AccountAccessTokenProvider } from "../../mail.js";
import { messagePayloadById } from "../../message-storage.js";
import {
  discardDraftOutboundAttachments,
  linkOutboundAttachmentsToSubmission,
  OutboundAttachmentError,
  releaseSubmissionOutboundAttachments,
  resolveOutboundAttachments,
  validateOutboundAttachmentSet,
  type ResolvedOutboundAttachment,
} from "../../outbound-attachments.js";
import {
  deletePendingScheduledSubmission,
  deliveryFailureStatus,
  markSubmissionFailed,
  markSubmissionSubmitted,
  markSubmissionUnknownDelivery,
  prepareSubmission,
  startSubmission,
  submissionForId,
  submissionRequestForId,
  type OutboundSubmission,
  type OutboundSubmissionRequest,
} from "../../outbox.js";
import { hasPendingSentRow, writePendingSentRow } from "../../pending-sent.js";
import { detectProvider } from "../../providers.js";
import { withTimeout } from "../../sync-locks.js";
import type { AccountRecord } from "../../types.js";
import { isoToEpochMs } from "../../utc-time.js";
import { TASK_RUN_TIMEOUT_MS, TaskAbortError } from "../scheduler.js";
import { commitTask, taskIdForSubmission, type CommitTaskDeps } from "../store.js";
import type { TaskRunner } from "../types.js";

/**
 * The `send` kind: dispatching one durable outbound submission.
 *
 * This runner owns no payload. The ledger row (`outbound_submissions`) is the
 * payload -- its sealed request and details are the recipient list, the body and
 * the RFC Message-ID -- and `task.submission_id` is the only thing the task
 * carries (contract §4.3). Copying the request into `payload_ciphertext` would be
 * the same ciphertext in two places, drifting apart, while the legacy
 * `legacyRequestFingerprint` check only ever honors the ledger's copy.
 *
 * **The ledger status is the whole judgement table**, and reading it is the
 * first thing an attempt does. That ordering is not tidiness: `submitting`
 * belongs to an attempt that no longer exists and `unknown_delivery` means the
 * mail may already have left, so an attempt that reached SMTP before consulting
 * the ledger would be able to send a second copy of a message the user was told
 * to check for by hand.
 *
 * The execution body is `submitOne`'s (`scheduled-send.ts:84-155`) with two
 * things changed: the submission id comes from the task instead of a due-time
 * query, and the outcome is expressed in the task vocabulary (return / throw
 * retryable / `TaskAbortError`) instead of being shown to a caller. The two
 * helpers it needs that live in that module today (`threadingHeaders`,
 * `storedDraftMessageId`) are duplicated here on purpose: the atomic switch
 * deletes their legacy copies along with the routes that call them, and until
 * then a legacy module importing from this layer would be the port reaching
 * backwards.
 */

export type SendTaskDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  /** Outbound temporary-attachment directory resolved from runtime config. */
  outboundAttachmentDirectory: string;
  accessTokenProvider?: AccountAccessTokenProvider;
  agentEvents?: AgentMailEventSink;
  /**
   * The Sent-folder verification pass.
   *
   * Required, on purpose: `confirmSubmissionsInSent` is the only thing that moves
   * a submission from `submitted` to `confirmed`, so a runner built without this
   * would leave every mail it sends unconfirmed for good, silently. The legacy
   * `ScheduledSendDependencies` made it required for the same reason.
   */
  scheduleSentVerification: (submissionId: string) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The reply graph's headers, rebuilt from the ledger's stored request.
 *
 * `references` gains the `inReplyTo` id when it is missing it: the stored array
 * is whatever the composing client sent, and a reply whose References omits its
 * own parent breaks threading in the recipient's client. The `slice(-50)` bound
 * is the SMTP header-size guard the composing side also applies.
 */
function threadingHeaders(request: { inReplyTo?: string; references?: string[] }) {
  const references = [...new Set([
    ...(request.references ?? []),
    ...(request.inReplyTo ? [request.inReplyTo] : []),
  ])].slice(-50);
  return {
    ...(request.inReplyTo ? { inReplyTo: request.inReplyTo } : {}),
    ...(references.length ? { references } : {}),
  };
}

/**
 * The RFC Message-ID of the draft this send discards, if it can still be read.
 *
 * Best-effort by construction: the payload may have been pruned between park and
 * submit, and a missing id only costs the draft's temporary attachments their
 * early cleanup -- the draft row itself still goes through `discardDraft`.
 */
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

/**
 * The instant a parked send becomes claimable, or `undefined` for a send the
 * scheduler must not hold back.
 *
 * Read from the **stored** ledger row rather than from the caller's string,
 * because that row is what every other reader compares against: the cancel route
 * refuses to delete a row whose `send_at <= now` (that comparison is the guard
 * against cancelling a mail already on its way), and the migration reads a legacy
 * `send_at` into `due_at` with the same `isoToEpochMs`. One ruler, so a parked
 * task and its ledger row can never disagree about the instant.
 *
 * A `send_at` that cannot be read as an instant is refused rather than treated as
 * "due now". It is unreachable — the row was written by `prepareSubmission`, which
 * normalizes through `requireUtcTimestamp` and rejects anything else — and the
 * reason to throw rather than default is the failure mode: defaulting to `undefined`
 * would change the task's meaning from "send at the date the user chose" to "send
 * on this call", i.e. mail the user's message before the day they asked for.
 */
function scheduledDueAt(submission: OutboundSubmission): number | undefined {
  if (submission.sendAt === null) return undefined;
  const dueAt = isoToEpochMs(submission.sendAt);
  if (dueAt === undefined) {
    throw new Error(`Outbound submission "${submission.id}" carries an unreadable send_at.`);
  }
  return dueAt;
}

export type AcceptSendInput = {
  account: AccountRecord;
  request: OutboundSubmissionRequest;
  /**
   * The composing client's dedupe key. Absent only when the caller has none to
   * offer; `prepareSubmission` then mints one, and the task row carries whichever
   * key the ledger ended up with so the two agree.
   */
  idempotencyKey?: string;
  /**
   * The user's own instant, when the send is theirs to schedule rather than this
   * attempt's to make: `prepareSubmission` stores it as the ledger's `send_at`, and
   * the dispatch task is parked on the same moment as its `due_at` instead of being
   * claimable at once.
   *
   * The instant that reaches the scheduler is read back from the **stored** row and
   * never from this string — see `scheduledDueAt`. The two spellings are the same
   * instant today, and the row is what every later reader compares against (the
   * cancel route's guard, the migration's `isoToEpochMs(row.send_at)`).
   */
  sendAt?: string;
};

export type AcceptPreparedSendInput = {
  /** The account the caller has already authorized this submission under. */
  account: AccountRecord;
  /** The ledger row `prepareSubmission` returned. */
  submissionId: string;
};

export type SendAcceptance = {
  submission: OutboundSubmission;
  /**
   * The task that will dispatch this send, or `null` when the call was a replay
   * and no task stands for the row any more: a settled task is pruned at its 24h
   * terminal TTL, and a cancelled one may be deleted outright.
   */
  taskId: string | null;
  /** False when the ledger row already existed, i.e. this call committed nothing. */
  created: boolean;
};

/**
 * Accepts a send: the ledger row, its uploads' links, the optimistic Sent row and
 * the dispatch task, in one transaction.
 *
 * This is everything the route used to do before calling SMTP, minus the
 * provider and minus the disk: no attachment file is read, no socket is opened,
 * no draft is discarded, no queue is touched. The transaction body must stay
 * **synchronous** -- `better-sqlite3` inspects a transaction function's return
 * value *after* the body has returned, so an `async` body's continuation would
 * run outside the transaction while looking atomic to the caller.
 *
 * The order inside is the order the errors imply:
 *
 *   1. `prepareSubmission` first, so its own diagnoses keep their precedence. A
 *      replayed key with different content is a 409 from there and would be a 404
 *      if the attachment check answered first. Its inner `db.transaction` becomes
 *      a SAVEPOINT under this one, so a throw rolls back through both.
 *   2. The attachment set: shape, ownership and the cumulative size bound, checked
 *      against the database and never against the filesystem -- file existence
 *      belongs to the attempt, because the 24h TTL cleanup may legitimately have
 *      taken a file by the time the runner runs (see
 *      `validateOutboundAttachmentSet`).
 *   3. The uploads' links, in this same transaction but deliberately **not**
 *      through `prepareSubmission`'s `linkAttachmentsInCreate` hook: that hook
 *      runs at step 1 and would let the linker's own rejection -- an unlocalized
 *      404 written for the scheduled path -- answer before the validator's
 *      message, changing what a bad token says to the user. The hook exists
 *      because a caller could only link *after* the row's inner transaction; here
 *      the whole acceptance is one transaction, so an explicit link after the
 *      validation is equivalent and in the documented order.
 *   4. The optimistic Sent row, so the mail is visible where the user was told it
 *      went out. A server with no Sent mailbox gets none (`writePendingSentRow`
 *      answers `null`), and the send proceeds regardless. **A parked send writes
 *      none**: the user was told the mail is *scheduled*, not sent, and the row's
 *      own contract says it "proves nothing" — it is our writing, and a reader has
 *      to be able to distinguish it from the provider's copy
 *      (`pending-sent.ts`, invariant 4). Parking one would put a mail the provider
 *      has never seen into Sent for as long as the schedule runs. The row the user
 *      reads is the scheduled one the route reports; when the attempt does happen,
 *      the confirmation still arrives the way it does for every send
 *      (`claimPendingSentRow` on the next sync).
 *   5. The task, last, so nothing is executable before everything it needs is
 *      written.
 *
 * `total` is passed rather than counted from items because a send carries no
 * items: its payload is the ledger row, and one submission is one unit of work.
 * The task's `id` **is** the submission id, which turns a second acceptance of the
 * same send into a primary-key collision rather than a second dispatch, and makes
 * `idx_tasks_submission` unnecessary for this read path -- `taskIdForSubmission`
 * is the reverse lookup that finds it.
 *
 * A parked send (`input.sendAt`) is the same commit with one extra column: the
 * task carries `due_at` derived from the ledger row (`scheduledDueAt`), so the
 * scheduler holds it until that instant instead of claiming it in this call's
 * drain. Nothing else about the acceptance differs, which is the point of parking
 * here rather than in a scheduler of its own: the exact Message-ID, the attachment
 * links and the idempotency key are written before anything can run, so no
 * interruption between accepting and sending can produce a second copy.
 *
 * Nothing is `start()`ed inside the transaction: the starter hands work to the
 * account's FIFO chain, and a rollback afterwards would leave work dispatched for
 * a row that no longer exists. The scheduler re-claims by predicate, so doing it
 * early would be harmless today; it is after the commit so that it stays harmless.
 */
export function acceptSendTask(deps: CommitTaskDeps, input: AcceptSendInput): SendAcceptance {
  const { db, masterKey } = deps;
  const { account, request } = input;
  const accepted = db.transaction(() => {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: account.id,
      accountEmail: account.email,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.sendAt === undefined ? {} : { sendAt: input.sendAt }),
      request,
    });
    if (!prepared.created) {
      // A replay. The row, its links, its placeholder and its task all belong to
      // the first acceptance, so this call commits none of them and reports the
      // ledger as it stands. The route's own peek has already answered the
      // statuses that need no attempt at all, so what reaches here is a `pending`
      // row whose task is either about to be attempted or is already running --
      // and in the latter case waiting for it is exactly right. A parked replay is
      // the same answer one step earlier: its task is waiting on its `due_at`, and
      // the row reported is the one the first acceptance parked.
      return { prepared, taskId: taskIdForSubmission(db, prepared.submission.id) ?? null, handle: null };
    }
    const attachments = validateOutboundAttachmentSet(db, masterKey, account.id, request.attachmentTokens);
    linkOutboundAttachmentsToSubmission(db, account.id, prepared.submission.id, request.attachmentTokens);
    const dueAt = scheduledDueAt(prepared.submission);
    if (dueAt === undefined) {
      writePendingSentRow(db, masterKey, {
        account,
        submissionId: prepared.submission.id,
        rfcMessageId: prepared.submission.messageId,
        request,
        attachments,
      });
    }
    const handle = commitTask(deps, {
      id: prepared.submission.id,
      accountId: account.id,
      kind: "send",
      scope: "single",
      // The ledger's key, which `prepareSubmission` may have minted: one send, one
      // key, in both tables.
      idempotencyKey: prepared.idempotencyKey,
      submissionId: prepared.submission.id,
      total: 1,
      ...(dueAt === undefined ? {} : { dueAt }),
    });
    return { prepared, taskId: handle.id, handle };
  })();
  accepted.handle?.start();
  return {
    submission: accepted.prepared.submission,
    taskId: accepted.taskId,
    created: accepted.prepared.created,
  };
}

/**
 * Accepts a submission the caller has already persisted with `prepareSubmission`.
 *
 * This is the Agent path's second half (contract §0.4 (h) ①). The Agent prepares in
 * one request and submits in a second, so by the time it asks for the send the
 * ledger row, its idempotency key and its exact RFC Message-ID already exist.
 * `acceptSendTask` would answer that shape as a replay and commit nothing -- which
 * is right for the interactive route, whose replay means "the first acceptance
 * already owns this", but wrong here, because no first acceptance ever ran.
 *
 * So this commits only what the row does not have yet:
 *
 *   1. the uploads' links, which `prepareSubmission` may have written already
 *      (`linkOutboundAttachmentsToSubmission` is `INSERT OR IGNORE`);
 *   2. the optimistic Sent row, **only when the submission has none** -- a retry
 *      of this call must not append a second placeholder for one submission
 *      (`hasPendingSentRow`);
 *   3. the `send` task, keyed by the submission id exactly as `acceptSendTask`
 *      keys it, so the two entries cannot produce two dispatches for one row.
 *
 * `pending` and `failed` are accepted, matching `startSubmission`'s own retry
 * table (`outbox.ts:590-613`): a definitive SMTP refusal left the ledger `failed`
 * and is exactly what a retry is for. Every other status commits nothing and is
 * reported as it stands -- `submitting` is owned by an attempt, `submitted` and
 * `confirmed` mean the mail is already out, and `unknown_delivery` must never be
 * retried automatically. A task that still exists is returned as-is rather than
 * replaced: its attempt owns the outcome, and replacing it would double-dispatch.
 *
 * The ledger read and both writes share one transaction, and `start()` runs after
 * the commit, for the same reasons as `acceptSendTask`.
 */
export function acceptPreparedSendTask(deps: CommitTaskDeps, input: AcceptPreparedSendInput): SendAcceptance {
  const { db, masterKey } = deps;
  const accepted = db.transaction(() => {
    const submission = submissionForId(db, masterKey, input.submissionId);
    if (!submission) throw new Error(`No outbound submission "${input.submissionId}".`);
    if (submission.accountId !== input.account.id) {
      throw new Error(`Outbound submission "${input.submissionId}" belongs to another account.`);
    }
    const existingTaskId = taskIdForSubmission(db, input.submissionId);
    if (submission.deliveryStatus !== "pending" && submission.deliveryStatus !== "failed") {
      return { submission, taskId: existingTaskId ?? null, created: false, handle: null };
    }
    if (existingTaskId) {
      // An attempt already stands for this row. Waiting for it is right: it will
      // read the same ledger status this call just did, and starting a second
      // task would be the double-send this key exists to prevent.
      return { submission, taskId: existingTaskId, created: false, handle: null };
    }
    const request = submissionRequestForId(db, masterKey, input.submissionId);
    if (!request) throw new Error(`Outbound submission "${input.submissionId}" has no readable request.`);
    const attachments = validateOutboundAttachmentSet(db, masterKey, input.account.id, request.attachmentTokens);
    linkOutboundAttachmentsToSubmission(db, input.account.id, input.submissionId, request.attachmentTokens);
    const dueAt = scheduledDueAt(submission);
    if (dueAt === undefined && !hasPendingSentRow(db, input.submissionId)) {
      writePendingSentRow(db, masterKey, {
        account: input.account,
        submissionId: input.submissionId,
        rfcMessageId: submission.messageId,
        request,
        attachments,
      });
    }
    const handle = commitTask(deps, {
      id: input.submissionId,
      accountId: input.account.id,
      kind: "send",
      scope: "single",
      // No `idempotencyKey`: the ledger's key is not part of the public
      // submission shape, and the task's primary key is the submission id --
      // the collision that key would guard against cannot happen here.
      submissionId: input.submissionId,
      total: 1,
      ...(dueAt === undefined ? {} : { dueAt }),
    });
    return { submission, taskId: handle.id, created: true, handle };
  })();
  accepted.handle?.start();
  return {
    submission: accepted.submission,
    taskId: accepted.taskId,
    created: accepted.created,
  };
}

/**
 * Withdraws a parked scheduled send: the ledger row and its task, or neither.
 *
 * This is `acceptSendTask`'s counterpart and the only way to take back what that
 * acceptance committed, which is why the transaction lives here rather than at
 * the call site. Half of the pair is the ghost this function exists to prevent --
 * a `send` task with no submission, which the runner can only abort as
 * `no_submission` -- and a caller free to run the two deletes separately could
 * still produce it. That is also why the route layer no longer names either half
 * or opens a transaction around them: doing so is executing SQL by another name
 * (`eslint.config.mjs`, the routes half of the layering gate).
 *
 * Returns whether the ledger row was still cancellable. `false` is a normal
 * answer, not a failure: the guard is the ledger delete's own predicate
 * (`status = 'pending' AND send_at > now`), so a send that has come due, one
 * already in flight, and one that never existed all land here as `false` -- and in
 * every one of those cases the task has to be left exactly as it is, which is why
 * the second delete is conditional on the first.
 */
export function cancelScheduledSend(db: DatabaseHandle, submissionId: string): boolean {
  return db.transaction(() => {
    if (!deletePendingScheduledSubmission(db, submissionId)) return false;
    discardPendingSendTask(db, submissionId);
    return true;
  })();
}

/**
 * Deletes the task of a cancelled scheduled send, inside `cancelScheduledSend`'s
 * transaction.
 *
 * The cancellation itself is the ledger delete (`deletePendingScheduledSubmission`),
 * whose predicate is the whole guard: `status = 'pending' AND send_at > now`. The
 * task's lifetime is that row's, so the two deletes must commit together -- and the
 * order matters in the other direction than one would guess. `tasks.submission_id`
 * is `ON DELETE SET NULL` (`tasks/schema.ts`), so by the time this runs, after the
 * ledger row is gone, the reverse reference has already been nulled: keying on
 * `submission_id` would find nothing and leave behind exactly the ghost this
 * function exists to prevent -- a `send` task with no submission, which the runner
 * can only abort as `no_submission`. Hence the primary key, which
 * `acceptSendTask` and the migration's `backfillScheduledSends` both set to the
 * submission id.
 *
 * `kind = 'send' AND status = 'pending'` are guardrails rather than race windows:
 * a task becomes claimable only when `due_at <= now`, `due_at` is
 * `Date.parse(send_at)`, and the ledger delete already required `send_at > now`, so
 * a running (or settled) task cannot be the one a successful cancellation names.
 *
 * Zero changes is a normal answer, not a failure: a submission parked by a build
 * that predates the task layer has no task until the migration's backfill gives it
 * one, and that backfill runs at open.
 *
 * Deliberately not exported: the pair above is the seam, and a caller that could
 * name this half alone could leave the other one behind.
 */
function discardPendingSendTask(db: DatabaseHandle, submissionId: string): number {
  const result = db.prepare(`
    DELETE FROM tasks WHERE id = ? AND kind = 'send' AND status = 'pending'
  `).run(submissionId);
  return result.changes;
}

/** Reserved after the SMTP race for the ledger write that records the verdict. */
const SMTP_POST_SEND_RESERVE_MS = 10_000;

/** Below this there is no time to finish a claimed attempt, so none is claimed. */
const SMTP_ATTEMPT_MIN_MS = 30_000;

/**
 * How long a `submitting` claim may be trusted as live.
 *
 * The scheduler abandons any runner after `TASK_RUN_TIMEOUT_MS`, and the next
 * attempt can wait at most its default maximum backoff (30s). One minute of
 * slack on top of both bounds means a row older than this cannot belong to a
 * live scheduler run: its owner either finished (and the status would have
 * moved on) or was abandoned.
 */
const SUBMITTING_CLAIM_STALE_MS = TASK_RUN_TIMEOUT_MS + 60_000;

// Spelled without "timeout"/"timed out": the web layer's classifier turns those
// words into a retryable connection error (`errorPresentation.ts:145`), which is
// the wrong advice for a mail that may already have left. This code is meant to
// fall through to the localized "delivery unconfirmed" notice.
const SMTP_ATTEMPT_TIMEOUT_CODE = "smtp_attempt_unconfirmed";
const SMTP_ATTEMPT_TIMEOUT_MESSAGE = "The SMTP attempt did not finish in time, so delivery is unconfirmed. Check Sent before sending again.";
const INTERRUPTED_CLAIM_CODE = "submission_interrupted";
const INTERRUPTED_CLAIM_MESSAGE = "The previous SMTP attempt was interrupted before delivery could be confirmed. Check Sent before sending again.";
const SUBMISSION_RECORD_FAILED_CODE = "submission_record_failed";
const SUBMISSION_RECORD_FAILED_MESSAGE = "The message was sent, but its delivery record could not be updated; it should appear in Sent.";

/** Distinguishes the race's own timeout from every error the transport throws. */
class SmtpAttemptTimeoutError extends Error {
  constructor() {
    super(SMTP_ATTEMPT_TIMEOUT_MESSAGE);
    this.name = "SmtpAttemptTimeoutError";
  }
}

/**
 * The `send` executor.
 *
 * Five ledger states, and each one is a decision this runner must make before it
 * is allowed to touch the socket (the table is in §4.7 B4):
 *
 *   - `pending` / `failed` -> claim and send. `startSubmission` names exactly
 *     these two as attemptable, and `failed` being attemptable is what the
 *     interactive route's manual retry relies on (`routes/messages.ts:853`).
 *   - `submitting` -> no SMTP. A fresh claim may still be owned by a live
 *     executor, so this attempt waits; a claim older than the scheduler's run
 *     timeout cannot belong to a live run, so it is converted to
 *     `unknown_delivery` here. Waiting on the startup recovery alone is what
 *     let a possibly-delivered mail end as `failed` after the ladder ran out.
 *   - `unknown_delivery` -> terminal, no SMTP. Retrying could deliver the mail a
 *     second time, which is the whole reason `startSubmission` refuses to retry
 *     this state automatically.
 *   - `submitted` / `confirmed` -> a normal return. The mail has left; this is
 *     the net under a double dispatch, where the second claim must not become a
 *     second email.
 *
 * The three error mappings mirror `scheduled-send.ts:134-149`; what changes is
 * who retries. The legacy path had to hand every failure to the user because it
 * had no retry mechanism, so it collapsed "the connection dropped" and "the mail
 * may be out" into the same visible answer. Here the first is retryable and the
 * second is terminal, and the split is `deliveryFailureStatus`'s -- which is
 * itself `isKnownPreAcceptanceFailure` (`outbox.ts:746-774`): the mail error
 * codes that mean nothing was transferred, plus SMTP command rejections up to
 * and including DATA, deliberately excluding `CONN` because a socket timeout is
 * indistinguishable from a lost final response.
 *
 * Four terminal answers sit outside that classification, and each one is the
 * cheapest true answer rather than a guess: no submission id or no such ledger
 * row (`no_submission`), a ledger row belonging to another account
 * (`account_mismatch`), a ledger whose sealed payload will not open
 * (`unreadable_submission`) and a request that is not there (`no_request`). All
 * four are deterministic, so the ladder would only re-read the same bytes, and
 * none of them is a delivery verdict: no attempt was claimed, so none reports the
 * mail as failed or as possibly sent.
 *
 * The one structural change from the legacy shape is the phase split, and it is
 * what makes that classification trustworthy: **everything that happens before
 * `sendMail` cannot have transferred anything**, so it is never classified as an
 * ambiguous delivery. The legacy code put the resolution, the claim and the SMTP
 * conversation in one `try`, which meant a stored attachment file that would not
 * open was answered as "the mail may be out, check Sent" -- a lie that also
 * disabled the retry. Here preparation has its own catch: a definitively
 * unavailable attachment (`OutboundAttachmentError`, which the attachment reader
 * now raises for its own failures too, `outbound-attachments.ts:251`) is terminal
 * and truthful, and anything else unexplained about the preparation is retryable,
 * which cannot duplicate the mail for the same reason.
 *
 * Counting: `total` is 1 (the mail), and every count this runner writes is the
 * row's **remainder** -- `1 - updated - failed` as of the claim -- rather than a
 * delta. That is what makes the count idempotent under the retry ladder: a task
 * resumed after a crash mid-attempt (the process died between recording the
 * send and counting it) reports the unit it never counted, while one resumed
 * after the count reports nothing, so the row converges on 1/0 or 0/1 instead of
 * 2/0. A retryable failure reports nothing -- the attempt that decides is the
 * attempt that counts. The paths this leaves to the permanent-failure hook are
 * the ones the runner never sees: the attempt budget running out, the run
 * timeout, and an unregistered kind, each of which the hook closes by reporting
 * the same remainder.
 */
export function createSendRunner(deps: SendTaskDeps): TaskRunner<undefined> {
  return async ({ task, report, signal }) => {
    // The scheduler's timeout is the outer bound; this one reserves enough of it
    // to record the outcome. A timeout here is the runner's own verdict, so it
    // cannot leave the row `submitting` for the startup recovery to guess at.
    const smtpDeadline = Date.now() + TASK_RUN_TIMEOUT_MS - SMTP_POST_SEND_RESERVE_MS;
    // The count is the row's remainder, not a delta: `report` adds, so a resumed
    // task must never be able to add the same unit twice. `task` is the claimed
    // row, and this runner is the only writer of these two columns for it.
    const remaining = Math.max(0, 1 - task.updated - task.failed);
    const countUpdated = () => { if (remaining) report({ updated: remaining }); };
    const countFailed = () => { if (remaining) report({ failed: remaining }); };

    const submissionId = task.submission_id;
    if (!submissionId) {
      // The ledger row IS the payload, so a task without this column is exactly
      // as unexecutable as a task without a payload is for the other kinds --
      // and no attempt can supply one.
      countFailed();
      throw new TaskAbortError("failed", `Task "${task.kind}" carries no submission id.`, "no_submission");
    }
    // The ledger read is wrapped, because `submissionForId` is not a row read: it
    // opens the sealed request and details to build the shape a renderer renders,
    // so a row whose ciphertext will not open throws from inside it. That throw
    // used to escape every classification, which sent a send task down the whole
    // eight-attempt ladder for a payload that cannot decrypt on attempt two
    // either -- and left the ledger untouched, with nothing in the session able to
    // move it. Deterministic, so terminal; and not a delivery verdict, because no
    // attempt was claimed and nothing was sent.
    let submission: OutboundSubmission | undefined;
    try {
      submission = submissionForId(deps.db, deps.masterKey, submissionId);
    } catch (error) {
      countFailed();
      throw new TaskAbortError("failed", errorMessage(error), "unreadable_submission");
    }
    if (!submission) {
      // Defensive rather than reachable while the foreign key holds: deleting the
      // ledger row nulls `tasks.submission_id` (ON DELETE SET NULL, `tasks/schema.ts`),
      // which is the branch above. This is the answer for a database where the
      // constraint was off -- retrying would read the same nothing.
      countFailed();
      throw new TaskAbortError("failed", `No outbound submission "${submissionId}".`, "no_submission");
    }
    if (submission.accountId !== task.account_id) {
      // The request's account is the one whose credentials this runner would use,
      // while the scheduler's chain, its write slots and its FIFO order all key on
      // the task's. A mismatch is a recording bug, and sending under it would
      // spend another account's credentials on this account's chain.
      countFailed();
      throw new TaskAbortError("failed", `Submission "${submissionId}" belongs to another account.`, "account_mismatch");
    }

    const status = submission.deliveryStatus;
    if (status === "submitted" || status === "confirmed") {
      // Two shapes arrive here and one count answers both. Either another
      // executor sent the mail (a double dispatch: its count is already on the
      // row, so the remainder is zero), or this task sent it and died before
      // counting it (the remainder is the unit). The residual count is what makes
      // the second shape self-healing instead of leaving a completed send at 0/1.
      countUpdated();
      return;
    }
    if (status === "submitting") {
      // A fresh claim belongs to an attempt that may still be in flight, and
      // taking it over would risk a second SMTP conversation. A stale claim has
      // no live owner left, so waiting is pointless: the truthful terminal is
      // "the mail may have left". Converting here is what keeps the ladder from
      // exhausting into `failed`, which would invite a resend of a mail that was
      // possibly delivered.
      const claimedAt = isoToEpochMs(submission.updatedAt);
      // An unreadable timestamp must not make a claim look fresh forever: no
      // live executor can be proven from it, so it is treated as stale.
      const claimAge = claimedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - claimedAt;
      if (claimAge >= SUBMITTING_CLAIM_STALE_MS) {
        markSubmissionUnknownDelivery(deps.db, deps.masterKey, submissionId, INTERRUPTED_CLAIM_CODE, INTERRUPTED_CLAIM_MESSAGE);
        countFailed();
        throw new TaskAbortError("unknown_delivery", INTERRUPTED_CLAIM_MESSAGE, INTERRUPTED_CLAIM_CODE);
      }
      throw new Error(`Outbound submission "${submissionId}" is already owned by another attempt.`);
    }
    if (status === "unknown_delivery") {
      // Reporting here rather than nowhere: the attempt that produced this state
      // (or the recovery pass, which runs outside any task) never got to count
      // it, and the task is about to end on it.
      countFailed();
      throw new TaskAbortError(
        "unknown_delivery",
        submission.errorMessage ?? "This message may already have been delivered.",
        submission.errorCode ?? "unknown_delivery",
      );
    }

    const account = accountById(deps.db, submission.accountId);
    if (!account) {
      // The account was removed. `outbound_submissions` cascades on that, so this
      // is a race with the delete rather than a state to converge; nothing can be
      // sent on an account that is gone.
      countFailed();
      throw new TaskAbortError("failed", `Account "${submission.accountId}" no longer exists.`, "no_account");
    }
    // Read outside the preparation try because the two failures need different
    // answers: a request that cannot be read is deterministic (the ciphertext
    // will not decrypt on attempt two either), while a request that is merely not
    // there is the same nothing. Both are terminal, and neither is a delivery.
    // A damaged request ciphertext is already answered by the read above, so
    // `!request` is the torn-read defence -- the row went between the two reads.
    let request;
    try {
      request = submissionRequestForId(deps.db, deps.masterKey, submissionId);
    } catch (error) {
      countFailed();
      throw new TaskAbortError("failed", errorMessage(error), "no_request");
    }
    if (!request) {
      countFailed();
      throw new TaskAbortError("failed", `Outbound submission "${submissionId}" has no readable request.`, "no_request");
    }

    // Preparation: nothing in here has reached the network, so a failure is never
    // an ambiguous delivery. Resolve and link BEFORE the claim: an attachment that
    // is definitively gone must fail the task without ever marking the ledger
    // `submitting`, because `submitting` claims an SMTP attempt that never
    // happened. The link is what keeps the upload alive until the send resolves
    // it, so it also has to precede the claim for the legacy reason: a crash after
    // this point leaves both the exact Message-ID and its files intact.
    let attachments: ResolvedOutboundAttachment[];
    let attempt: ReturnType<typeof startSubmission>;
    try {
      attachments = resolveOutboundAttachments(
        deps.db,
        deps.outboundAttachmentDirectory,
        deps.masterKey,
        account.id,
        request.attachmentTokens,
      );
      linkOutboundAttachmentsToSubmission(deps.db, account.id, submissionId, request.attachmentTokens);
      // Claiming is what says "an SMTP attempt owns this row", so it must not
      // happen when the attempt has too little of the scheduler's budget left to
      // finish. Thrown retryable and before `startSubmission`: no claim is made,
      // so the next attempt reads a `pending` row rather than waiting out a
      // `submitting` one this process could never resolve.
      if (smtpDeadline - Date.now() < SMTP_ATTEMPT_MIN_MS) {
        throw new Error(`No time left to finish the SMTP attempt for "${submissionId}"; retrying.`);
      }
      attempt = startSubmission(deps.db, deps.masterKey, submissionId);
    } catch (error) {
      if (!(error instanceof OutboundAttachmentError)) {
        // Unexplained, but still pre-network: a retry cannot duplicate a mail that
        // was never handed to SMTP. Not terminal, because a transient cause (a
        // locked database, a full disk) is worth another attempt, and a permanent
        // one exhausts the ladder and reaches the permanent-failure hook.
        throw error;
      }
      // An attachment that vanished before the send is a definitive, diagnosable
      // failure -- never an ambiguous unknown-delivery state, and never a reason
      // to send without the file.
      markSubmissionFailed(deps.db, deps.masterKey, submissionId, "attachment_unavailable", errorMessage(error));
      countFailed();
      throw new TaskAbortError("failed", errorMessage(error), "attachment_unavailable");
    }
    if (!attempt.shouldAttempt) {
      // The ledger moved between the read above and this claim, i.e. another
      // executor took the row. Its attempt owns the outcome; this one waits, and
      // the next attempt reads whatever that executor decided. Retryable, and
      // deliberately outside the catch above: nothing was sent, so waiting cannot
      // duplicate the mail, while a terminal answer here would end the task on an
      // outcome that was never this attempt's to decide.
      throw new Error(`Outbound submission "${submissionId}" was claimed by another attempt.`);
    }

    // The SMTP conversation, and only that. This boundary is what makes the
    // mapping below trustworthy: from here a failure may mean the mail was
    // accepted just before the connection went away.
    let result: { messageId: string };
    try {
      // The race is bounded here rather than left to the scheduler: when the
      // scheduler's own timeout fires it only stops waiting, so the ledger would
      // stay `submitting` until startup recovery -- and the retry ladder, much
      // shorter than that recovery, could exhaust into `failed` first. Timing out
      // ourselves turns the same uncertainty into the correct terminal verdict,
      // with enough of the run budget left to write it. The scheduler's abort
      // (shutdown) is raced below for the same reason: SMTP cannot be cancelled,
      // so its only honest verdict is the same "unknown".
      const smtp = sendMail(account, deps.masterKey, {
        to: request.to,
        cc: request.cc,
        messageId: attempt.submission.messageId,
        ...threadingHeaders(request),
        subject: request.subject,
        text: request.text,
        html: request.html,
        attachments,
      }, deps.accessTokenProvider);
      // Shutdown aborts the attempt before the deadline does. SMTP has no
      // "cancel this message": once DATA is on the wire the server decides, so the
      // only honest answer is the one this deadline already gives -- unknown, not
      // failed -- and the ledger's recovery reconciles it. Racing the signal here
      // is what keeps the process from exiting while the transport still talks.
      let rejectAborted: (error: Error) => void = () => undefined;
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      const onAbort = () => rejectAborted(new SmtpAttemptTimeoutError());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        result = await withTimeout(
          Promise.race([smtp, aborted]),
          Math.max(1, smtpDeadline - Date.now()),
          SMTP_ATTEMPT_TIMEOUT_MESSAGE,
          new SmtpAttemptTimeoutError(),
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (error instanceof SmtpAttemptTimeoutError) {
        // The transport may still be talking to the server when this fires; the
        // wrapper does not cancel it. That is exactly why the verdict is
        // "unknown" and not "failed": the send may complete after we stop
        // listening, and a retry could deliver it twice.
        markSubmissionUnknownDelivery(deps.db, deps.masterKey, submissionId, SMTP_ATTEMPT_TIMEOUT_CODE, SMTP_ATTEMPT_TIMEOUT_MESSAGE);
        countFailed();
        throw new TaskAbortError("unknown_delivery", SMTP_ATTEMPT_TIMEOUT_MESSAGE, SMTP_ATTEMPT_TIMEOUT_CODE);
      }
      // Both arms below record what the user will read, so both record the SAFE
      // text: `safeMailError` derives `{code, message}` from the code alone, and
      // the ledger's `errorMessage` is rendered by the outbox and by
      // `GET /api/submissions`. Passing the raw `error.message` here -- which is
      // what the legacy scheduled path did -- would put a transport's own text,
      // credentials included, in front of the user. The credential hint is
      // forwarded because dropping it silently downgrades the advice for the
      // credential codes to the generic sentence.
      const failure = safeMailError(error, detectProvider(account.email).credentialHint);
      if (deliveryFailureStatus(error) === "failed") {
        // Recording `failed` is truthful about this attempt, and the retryable
        // throw is what makes the ladder pick it up: the code list is exactly
        // "nothing was transferred", so trying again cannot duplicate the mail.
        markSubmissionFailed(deps.db, deps.masterKey, submissionId, failure.code, failure.message);
        // Not `throw error`: the scheduler reads the thrown object's message into
        // `tasks.error_message`, which is renderable too (`taskProgress`, the
        // batch snapshot), and its `code` into `tasks.error_code`, which would be
        // the transport's own spelling rather than ours. The safe pair survives on
        // the object, which is all `failureOf` reads; the raw error stays
        // reachable as `cause`, in-process.
        throw Object.assign(new Error(failure.message), { code: failure.code, cause: error });
      }
      // Ambiguous: SMTP may have accepted the message just before the connection
      // disappeared. Terminal, with the ledger carrying the user-facing advice.
      markSubmissionUnknownDelivery(deps.db, deps.masterKey, submissionId, failure.code, failure.message);
      countFailed();
      throw new TaskAbortError("unknown_delivery", failure.message, failure.code);
    }

    // The mail is out. Recording that is deliberately NOT classified as a delivery
    // verdict, and a failure to record it must not turn the task into a failure:
    // the scheduler's `failed` hook would retract the optimistic Sent row for a
    // mail that did leave, which is the worst of both answers. So the record write
    // is separated from the send's outcome, and the task still ends `completed`.
    try {
      markSubmissionSubmitted(deps.db, deps.masterKey, submissionId, result.messageId);
    } catch {
      // The ledger still says `submitting`, which is true -- the outcome could not
      // be written -- but it is not what later passes act on: `submitted` and
      // `unknown_delivery` are the confirmable states, so a best-effort
      // `unknown_delivery` at least makes the mail visible to verification. If
      // even that write fails, startup recovery converts the row.
      try {
        markSubmissionUnknownDelivery(deps.db, deps.masterKey, submissionId, SUBMISSION_RECORD_FAILED_CODE, SUBMISSION_RECORD_FAILED_MESSAGE);
      } catch {
        // Nothing else in this process can write the ledger; recovery owns it.
      }
    }
    try {
      // The id is the same either way, so the verification pass runs whether the
      // ledger ended `submitted` or was downgraded above; what it does with the
      // row is its own decision. A failed schedule must not retroactively
      // un-send a message the transport accepted -- sync drives the same pass.
      deps.scheduleSentVerification(submissionId);
    } catch {
      // Best effort: the outcome is already recorded as far as it can be.
    }

    if (request.discardDraftId) {
      try {
        const sourceDraftMessageId = storedDraftMessageId(deps.db, deps.masterKey, account.id, request.discardDraftId);
        await discardDraft(deps.db, deps.masterKey, account, request.discardDraftId, deps.accessTokenProvider, deps.agentEvents);
        if (sourceDraftMessageId) {
          discardDraftOutboundAttachments(deps.db, deps.outboundAttachmentDirectory, account.id, sourceDraftMessageId);
        }
      } catch {
        // SMTP accepted the message. A failed draft cleanup is reported by
        // the next sync and must not change the terminal delivery status.
      }
    }
    try {
      releaseSubmissionOutboundAttachments(deps.db, deps.outboundAttachmentDirectory, account.id, submissionId);
    } catch {
      // The durable link prevents premature stale cleanup, so this can be
      // retried by a later pass without changing the send outcome.
    }
    countUpdated();
  };
}
