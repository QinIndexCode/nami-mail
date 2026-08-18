import { createHash, createHmac } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { attachmentMetadataFromParsedMail } from "./attachments.js";
import { attachmentKindsJson } from "./attachment-kind.js";
import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { deriveEncryptionKey } from "./crypto.js";
import { friendlyMailError, imapClientForAccount, mailErrorCode, type AccountAccessTokenProvider } from "./mail.js";
import {
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
  messagePayloadById,
  moveActionBlockedError,
  protectedMessageColumns,
  type MessageStorageRow,
} from "./message-storage.js";
import { listEnabledFilterRules, matchesFilterRuleConditions } from "./filter-rules.js";
import { autoCollectSender } from "./contacts.js";
import { indexMessageFts } from "./message-search.js";
import {
  confirmSubmissionsInSent,
  markSubmissionConfirmed,
  submissionForId,
} from "./outbox.js";
import type { AccountRecord } from "./types.js";
import { getAppSettings } from "./settings.js";
import { getAutoReplyEngine } from "./agent/auto-reply.js";

const running = new Set<string>();
const movingAccounts = new Set<string>();

// Raised when a sync pass is aborted by its caller (client disconnect or the
// route-level runtime cap). Distinguished from provider failures so the
// account status is left untouched instead of being marked error/reauth.
class SyncAbortedError extends Error {
  constructor() {
    super("Sync aborted.");
    this.name = "SyncAbortedError";
  }
}
// Per-account FIFO write lock chains. A second write operation on the same
// account (another move, a flag update) waits in line instead of failing with
// a busy error, so a burst of deletes or moves is processed in order rather
// than rejected. A full sync pass (`running`) intentionally stays an
// immediate failure: queued writes must never block a sync cycle.
const accountWriteChains = new Map<string, Promise<void>>();

// Tracks which accounts the current async execution context already holds a
// write slot for. Nested acquisitions — the operation queue takes the slot
// before invoking an executor that also takes it, and batch moves fall back to
// single-message moves that take it again — must be no-ops instead of waiting
// on their own gate forever (a self-deadlock).
const heldWriteSlots = new AsyncLocalStorage<Set<string>>();

/** Longest an operation may wait for the account write slot it is queued
 * behind. A predecessor whose provider command hangs (and whose executor is
 * later abandoned) must not block this operation forever; on timeout the
 * operation fails and its place in the chain is released so operations behind
 * it still proceed. Generous relative to a normal operation (seconds) but far
 * shorter than the queue's executor run timeout. */
const ACCOUNT_WRITE_SLOT_TIMEOUT_MS = 30_000;

/** Rejects with `message` after `milliseconds`, without keeping the process
 * alive for a run that may never settle on its own during shutdown. */
export function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Acquires write slots for every account in a deterministic order (sorted, so
 * concurrent multi-account batches can never deadlock). The returned release
 * functions must be called in reverse order.
 */
export async function acquireAccountWriteSlots(accountIds: readonly string[]): Promise<Array<() => void>> {
  const sorted = [...new Set(accountIds)].sort();
  const releases: Array<() => void> = [];
  const held = heldWriteSlots.getStore();
  try {
    for (const accountId of sorted) {
      // A nested acquisition within the same execution context already holds
      // this account's slot: do not wait on our own gate (self-deadlock).
      if (held?.has(accountId)) continue;
      const prev = accountWriteChains.get(accountId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      accountWriteChains.set(accountId, prev.then(() => gate));
      try {
        await withTimeout(prev, ACCOUNT_WRITE_SLOT_TIMEOUT_MS, `Timed out waiting for the account ${accountId} write slot.`);
      } catch (error) {
        // Give up our place instead of leaving an unresolved gate that would
        // block every operation queued behind us.
        release();
        throw error;
      }
      held?.add(accountId);
      releases.push(() => {
        release();
        held?.delete(accountId);
      });
    }
    return releases;
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
}

/** Runs `fn` while holding write slots for every named account. */
export async function withAccountWriteLocks<T>(accountIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  return heldWriteSlots.run(heldWriteSlots.getStore() ?? new Set<string>(), async () => {
    const releases = await acquireAccountWriteSlots(accountIds);
    try {
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
}

/**
 * Runs `fn` in a context that considers every named account's write slot as
 * already held, so the executor's own nested `withAccountWriteLocks` calls are
 * reentrant no-ops. Used by the operation queue, which acquires the slot
 * itself (to release it on timeout) before invoking an executor that would
 * otherwise acquire it again and deadlock.
 */
export function withHeldWriteSlots<T>(accountIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  const parent = heldWriteSlots.getStore();
  const held = new Set(accountIds);
  if (parent) for (const accountId of parent) held.add(accountId);
  return heldWriteSlots.run(held, fn);
}
const scheduledSentVerifications = new Map<string, Promise<void>>();
const sentVerificationRetryDelaysMs = [0, 2_000, 10_000] as const;
// Probe old cached UIDs in small, rotating batches. This only verifies remote
// absence after a folder has stayed in the same UIDVALIDITY epoch.
const remoteDeletionProbeBatchSize = 64;
const remoteDeletionProbeCursorLimit = 1_024;
const remoteDeletionProbeCursors = new Map<string, number>();

export type NewInboxMessage = {
  id: string;
  accountId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
};

function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}

function autoReplyActiveForAccount(db: DatabaseHandle, accountId: string): boolean {
  const autoReply = getAppSettings(db).autoReply;
  return autoReply.enabled && autoReply.accountIds.includes(accountId);
}

function addressValues(address: AddressObject | AddressObject[] | undefined): Array<{ name: string; address: string }> {
  if (!address) return [];
  return (Array.isArray(address) ? address : [address]).flatMap((item) =>
    item.value.map((entry) => ({ name: entry.name ?? "", address: entry.address ?? "" })),
  );
}

const messageIdPattern = /<[^<>\r\n]{1,998}>/g;

function messageIdValues(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const ids = values.flatMap((item) => item.match(messageIdPattern) ?? []);
  return [...new Set(ids)].slice(-50);
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function headerValue(headers: { get(key: string): unknown } | undefined, key: string): string {
  if (!headers) return "";
  const value = headers.get(key);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => typeof entry === "string" ? entry : String(entry)).join(", ");
  return "";
}

function messageKey(accountId: string, mailbox: string, uid: number): string {
  return createHash("sha256").update(`${accountId}\0${mailbox}\0${uid}`).digest("hex").slice(0, 32);
}

function remoteDeletionProbeCursorKey(accountId: string, mailbox: string, uidValidity: string): string {
  return `${accountId}\0${mailbox}\0${uidValidity}`;
}

function advanceRemoteDeletionProbeCursor(key: string, uid: number): void {
  remoteDeletionProbeCursors.delete(key);
  remoteDeletionProbeCursors.set(key, uid);
  while (remoteDeletionProbeCursors.size > remoteDeletionProbeCursorLimit) {
    const oldestKey = remoteDeletionProbeCursors.keys().next().value;
    if (typeof oldestKey !== "string") return;
    remoteDeletionProbeCursors.delete(oldestKey);
  }
}

const remoteIdLookupKeyPurpose = "message-remote-id-lookup-v1";

function remoteIdLookup(masterKey: Buffer, accountId: string, remoteId: string | undefined): string | null {
  if (!remoteId) return null;
  const key = deriveEncryptionKey(masterKey, remoteIdLookupKeyPurpose);
  try {
    return `h1.${createHmac("sha256", key).update(accountId, "utf8").update("\0").update(remoteId, "utf8").digest("base64url")}`;
  } finally {
    key.fill(0);
  }
}

function isSelectableFolder(folder: ListResponse): boolean {
  return folder.listed && !folder.flags.has("\\Noselect");
}

function isAllMailFolder(folder: ListResponse): boolean {
  return folder.specialUse === "\\All";
}

const allMailNonArchiveLabels = ["\\Inbox", "\\Sent", "\\Draft", "\\Drafts", "\\Trash", "\\Spam", "\\Junk"];

function allMailArchivedValue(folder: ListResponse, labels: Set<string> | undefined): number | null {
  if (!isAllMailFolder(folder) || !labels) return null;
  return allMailNonArchiveLabels.some((label) => labels.has(label)) ? 0 : 1;
}

function folderPriority(folder: ListResponse): number {
  const priorities: Record<string, number> = {
    "\\Inbox": 0,
    "\\Sent": 1,
    "\\Drafts": 2,
    "\\Flagged": 3,
    "\\Important": 4,
    "\\All": 5,
    "\\Archive": 6,
    "\\Junk": 7,
    "\\Spam": 7,
    "\\Trash": 8,
  };
  return priorities[folder.specialUse ?? ""] ?? 20;
}

function partialSyncMessage(failedFolders: number): string {
  return `${failedFolders} 个文件夹未完成同步，其他文件夹的邮件仍可使用。`;
}

function uidValidityValue(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  // ImapFlow exposes a bigint in production. Accepting an integer here keeps
  // the cache boundary easy to exercise with small test doubles.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function isSentFolder(folder: ListResponse): boolean {
  return isSelectableFolder(folder) && folder.specialUse === "\\Sent";
}

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
    const sentFolders = (await client.list()).filter(isSentFolder);
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

export async function syncAccount(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  messageLimit: number,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  signal?: AbortSignal,
): Promise<{ synced: number; folders: number; failedFolders: number; newInboxMessages: NewInboxMessage[] }> {
  if (running.has(accountId) || movingAccounts.has(accountId)) {
    return { synced: 0, folders: 0, failedFolders: 0, newInboxMessages: [] };
  }
  const account = accountById(db, accountId);
  if (!account) throw new Error("Account not found.");
  const agentLease = agentEvents?.acquireLease(accountId);
  running.add(accountId);
let client: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;
  // New inbox messages from a successful pass are handed to the filter-rule
  // automation only after the sync guard below is released.
  let pendingRuleTargets: Array<{ id: string }> = [];
  let pendingAutoReplyTargets: string[] = [];
  // Gmail category labels are fetched for every folder only while this
  // account is actively participating in the auto-reply feature.
  const autoReplyActive = autoReplyActiveForAccount(db, accountId);

  try {
    client = await imapClientForAccount(account, masterKey, accessTokenProvider);
    await client.connect();
    const connectedClient = client;
    const folders = (await client.list())
      .filter(isSelectableFolder)
      .sort((a, b) => folderPriority(a) - folderPriority(b) || a.name.localeCompare(b.name));
    const previousFolderState = new Map(
      (db.prepare("SELECT path, uid_validity, total, unseen FROM folders WHERE account_id = ?").all(accountId) as Array<{
        path: string;
        uid_validity: string | null;
        total: number;
        unseen: number;
      }>).map((folder) => [folder.path, folder]),
    );
    const upsertFolder = db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
      VALUES (@accountId, @path, @name, @specialUse, @total, @unseen, @uidValidity)
      ON CONFLICT(account_id, path) DO UPDATE SET
        name = excluded.name,
        special_use = excluded.special_use,
        total = excluded.total,
        unseen = excluded.unseen,
        uid_validity = excluded.uid_validity
    `);

    const folderRows: Array<{
      path: string;
      name: string;
      specialUse: string | null;
      total: number;
      unseen: number;
      uidValidity: string | null;
    }> = [];
    for (const folder of folders) {
      let status: { messages?: number; unseen?: number } = {};
      try {
        status = await client.status(folder.path, { messages: true, unseen: true });
      } catch {
        // Some providers do not permit STATUS for every virtual folder.
      }
      const previous = previousFolderState.get(folder.path);
      folderRows.push({
        path: folder.path,
        name: folder.name || folder.path,
        specialUse: folder.specialUse ?? null,
        // STATUS can be denied for virtual folders; falling back to zero would
        // clobber the last known counts (and trip unread badges) until the
        // next successful STATUS. Keep the previous observation instead.
        total: status.messages ?? previous?.total ?? 0,
        unseen: status.unseen ?? previous?.unseen ?? 0,
        // Do not accept a status-only UIDVALIDITY observation. It must be
        // confirmed by the successful mailbox SELECT below before old cache
        // rows can be considered part of the same UID epoch.
        uidValidity: previous?.uid_validity ?? null,
      });
    }

    type RemovedMessage = {
      id: string;
      mailbox: string;
      uid: number;
      remote_id_lookup: string | null;
      flags_json: string;
      all_mail_archived: number | null;
    };
    const activeFolderPaths = folderRows.map((folder) => folder.path);
    if (activeFolderPaths.length === 0) {
      // An empty LIST is a provider/connection artifact, not proof that every
      // folder vanished. Treating it as removal would delete the whole local
      // cache. Keep the previous folder set untouched and let the next pass
      // recover, like every other transient provider failure.
      console.warn(`IMAP LIST returned no folders for account ${accountId}; skipping folder-removal pass`);
    } else {
      const inactiveFolderClause = ` AND mailbox NOT IN (${activeFolderPaths.map(() => "?").join(", ")})`;
      const listMessagesInRemovedFolders = db.prepare(`
        SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
        FROM messages
        WHERE account_id = ?${inactiveFolderClause}
          AND COALESCE(pending_move_destination, '') = ''
      `);
      const deleteMessagesInRemovedFolders = db.prepare(`
        DELETE FROM messages
        WHERE account_id = ?${inactiveFolderClause}
          AND COALESCE(pending_move_destination, '') = ''
      `);

      db.transaction(() => {
        const removedMessages = listMessagesInRemovedFolders.all(
          accountId,
          ...activeFolderPaths,
        ) as RemovedMessage[];
        deleteMessagesInRemovedFolders.run(accountId, ...activeFolderPaths);
        if (agentEvents && agentLease) {
          for (const removed of removedMessages) {
            agentEvents.messageDeletedWithinTransaction(agentLease, removed.id, {
              reason: "folder-removed",
              mailbox: removed.mailbox,
              uid: removed.uid,
              remoteIdLookup: removed.remote_id_lookup,
              flagsJson: removed.flags_json,
              allMailArchived: removed.all_mail_archived,
            });
          }
        }
        db.prepare("DELETE FROM folders WHERE account_id = ?").run(accountId);
        for (const folder of folderRows) upsertFolder.run({ accountId, ...folder });
      })();
    }

    const upsert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, all_mail_archived, message_id, subject, from_name, from_address,
        to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body, html_body, flags_json,
        has_attachments, attachments_json, attachment_kinds_json, payload_metadata_ready, encrypted_payload, payload_version, size, created_at
      ) VALUES (
        @id, @accountId, @mailbox, @uid, @remoteIdLookup, @allMailArchived, @messageId, @subject, @fromName, @fromAddress,
        @toJson, @ccJson, @inReplyTo, @referencesJson, @sentAt, @snippet, @textBody, @htmlBody, @flagsJson,
        @hasAttachments, @attachmentsJson, @attachmentKindsJson, @payloadMetadataReady, @encryptedPayload, @payloadVersion, @size, @createdAt
      )
      ON CONFLICT(account_id, mailbox, uid) DO UPDATE SET
        remote_id_lookup = COALESCE(excluded.remote_id_lookup, messages.remote_id_lookup),
        all_mail_archived = COALESCE(excluded.all_mail_archived, messages.all_mail_archived),
        message_id = excluded.message_id,
        subject = excluded.subject,
        from_name = excluded.from_name,
        from_address = excluded.from_address,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        in_reply_to = excluded.in_reply_to,
        references_json = excluded.references_json,
        sent_at = excluded.sent_at,
        snippet = excluded.snippet,
        text_body = excluded.text_body,
        html_body = excluded.html_body,
        flags_json = excluded.flags_json,
        has_attachments = excluded.has_attachments,
        attachments_json = excluded.attachments_json,
        attachment_kinds_json = excluded.attachment_kinds_json,
        payload_metadata_ready = excluded.payload_metadata_ready,
        encrypted_payload = excluded.encrypted_payload,
        payload_version = excluded.payload_version,
        size = excluded.size
    `);
    const findMessage = db.prepare(`
      SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?
    `);
    const updateCachedMessage = db.prepare(`
      UPDATE messages
      SET flags_json = ?,
          remote_id_lookup = COALESCE(?, remote_id_lookup),
          all_mail_archived = COALESCE(?, all_mail_archived)
      WHERE account_id = ? AND mailbox = ? AND uid = ?
    `);
    const findPendingMoves = db.prepare(`
      SELECT * FROM messages
      WHERE account_id = ? AND pending_move_destination = ? AND remote_id_lookup = ?
      ORDER BY id
      LIMIT 2
    `);
    const deleteDestinationCopies = db.prepare(`
      DELETE FROM messages
      WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
    `);
    const listDestinationCopies = db.prepare(`
      SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
      FROM messages
      WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
    `);
    const reconcilePendingMove = db.prepare(`
      UPDATE messages
      SET mailbox = ?,
          uid = ?,
          flags_json = ?,
          remote_id_lookup = ?,
          all_mail_archived = ?,
          pending_move_destination = NULL,
          pending_move_state = NULL,
          pending_move_candidate_uid = NULL,
          pending_move_special_use = NULL
      WHERE id = ? AND account_id = ? AND pending_move_destination = ? AND remote_id_lookup = ?
    `);
    const pendingMoveCandidates = db.prepare(`
      SELECT * FROM messages
      WHERE account_id = ? AND pending_move_destination = ? AND pending_move_candidate_uid IS NOT NULL
    `);
    const pendingMoveIntents = db.prepare(`
      SELECT id, uid, remote_id_lookup FROM messages
      WHERE account_id = ? AND mailbox = ? AND pending_move_state = 'intent' AND uid > 0
    `);
    const clearPendingMoveIntent = db.prepare(`
      UPDATE messages
      SET pending_move_destination = NULL,
          pending_move_state = NULL,
          pending_move_candidate_uid = NULL,
          pending_move_special_use = NULL
      WHERE account_id = ? AND mailbox = ? AND uid = ? AND pending_move_state = 'intent'
    `);
    const clearPendingCandidateUid = db.prepare(`
      UPDATE messages
      SET pending_move_candidate_uid = NULL
      WHERE account_id = ? AND pending_move_destination = ? AND pending_move_candidate_uid = ?
    `);
    const deleteFolderMessages = db.prepare(`
      DELETE FROM messages
      WHERE account_id = ? AND mailbox = ? AND COALESCE(pending_move_destination, '') = ''
    `);
    const updateFolderUidValidity = db.prepare("UPDATE folders SET uid_validity = ? WHERE account_id = ? AND path = ?");
    type RemoteDeletionCandidate = {
      id: string;
      mailbox: string;
      uid: number;
      remote_id_lookup: string | null;
      flags_json: string;
      all_mail_archived: number | null;
    };
    const listRemoteDeletionCandidatesAfterCursor = db.prepare(`
      SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
      FROM messages
      WHERE account_id = ?
        AND mailbox = ?
        AND uid > ?
        AND COALESCE(pending_move_destination, '') = ''
        AND pending_move_state IS NULL
      ORDER BY uid ASC
      LIMIT ?
    `);
    const listRemoteDeletionCandidatesFromStart = db.prepare(`
      SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
      FROM messages
      WHERE account_id = ?
        AND mailbox = ?
        AND uid > 0
        AND COALESCE(pending_move_destination, '') = ''
        AND pending_move_state IS NULL
      ORDER BY uid ASC
      LIMIT ?
    `);
    const deleteRemoteDeletionCandidate = db.prepare(`
      DELETE FROM messages
      WHERE id = ?
        AND account_id = ?
        AND mailbox = ?
        AND uid = ?
        AND COALESCE(pending_move_destination, '') = ''
        AND pending_move_state IS NULL
    `);
    const folderHasPendingMove = db.prepare(`
      SELECT 1
      FROM messages
      WHERE account_id = ?
        AND COALESCE(pending_move_destination, '') <> ''
        AND (mailbox = ? OR pending_move_destination = ?)
      LIMIT 1
    `);
    const reconcileRemoteDeletionBatch = async (folder: ListResponse, uidValidity: string): Promise<void> => {
      const cursorKey = remoteDeletionProbeCursorKey(accountId, folder.path, uidValidity);
      const cursor = remoteDeletionProbeCursors.get(cursorKey);
      let candidates = listRemoteDeletionCandidatesAfterCursor.all(
        accountId,
        folder.path,
        cursor ?? 0,
        remoteDeletionProbeBatchSize,
      ) as RemoteDeletionCandidate[];
      if (!candidates.length && cursor !== undefined) {
        candidates = listRemoteDeletionCandidatesFromStart.all(
          accountId,
          folder.path,
          remoteDeletionProbeBatchSize,
        ) as RemoteDeletionCandidate[];
      }
      if (!candidates.length) {
        remoteDeletionProbeCursors.delete(cursorKey);
        return;
      }

      const candidateUids = candidates.map((candidate) => candidate.uid);
      const candidateUidSet = new Set(candidateUids);
      const observedUids = new Set<number>();
      // Deletion happens only after this entire FETCH iterator completes. A
      // partial iterator or mailbox error therefore cannot turn a timeout into
      // a local deletion decision.
      for await (const message of connectedClient.fetch(candidateUids, { uid: true }, { uid: true })) {
        if (message.uid && candidateUidSet.has(message.uid)) observedUids.add(message.uid);
      }

      db.transaction(() => {
        for (const candidate of candidates) {
          if (observedUids.has(candidate.uid)) continue;
          const deleted = deleteRemoteDeletionCandidate.run(
            candidate.id,
            accountId,
            candidate.mailbox,
            candidate.uid,
          );
          if (deleted.changes !== 1 || !agentEvents || !agentLease) continue;
          agentEvents.messageDeletedWithinTransaction(agentLease, candidate.id, {
            reason: "remote-deletion-reconciled",
            mailbox: candidate.mailbox,
            uid: candidate.uid,
            remoteIdLookup: candidate.remote_id_lookup,
            flagsJson: candidate.flags_json,
            allMailArchived: candidate.all_mail_archived,
          });
        }
      })();
      advanceRemoteDeletionProbeCursor(cursorKey, candidates[candidates.length - 1]!.uid);
    };
    let synced = 0;
    let failedFolders = 0;
    let firstFolderError: unknown;
    const newInboxMessages: NewInboxMessage[] = [];

    const sourceMembershipAbsentIntentIds = new Set<string>();
    type PendingRemoteMessage = {
      uid: number;
      emailId?: string;
      flags?: Set<string>;
      labels?: Set<string>;
    };
    type PendingReconciliation = "none" | "waiting" | "reconciled";
    const deferredPendingRemoteMessages: Array<{ folder: ListResponse; message: PendingRemoteMessage }> = [];
    const deferredPendingRemoteMessageKeys = new Set<string>();
    const deferPendingRemoteMessage = (folder: ListResponse, message: PendingRemoteMessage): void => {
      const key = `${folder.path}\0${message.uid}`;
      if (deferredPendingRemoteMessageKeys.has(key)) return;
      deferredPendingRemoteMessageKeys.add(key);
      // Preserve only the identity and state that reconciliation needs. An
      // IMAP iterator is allowed to reuse message objects after it advances.
      deferredPendingRemoteMessages.push({
        folder,
        message: {
          uid: message.uid,
          emailId: message.emailId,
          flags: message.flags ? new Set(message.flags) : undefined,
          labels: message.labels ? new Set(message.labels) : undefined,
        },
      });
    };
    const reconcilePendingRemoteMessage = (
      folder: ListResponse,
      message: PendingRemoteMessage,
    ): PendingReconciliation => {
      const remoteLookup = remoteIdLookup(masterKey, accountId, message.emailId);
      if (!remoteLookup) return "none";
      const pendingRows = findPendingMoves.all(accountId, folder.path, remoteLookup) as MessageStorageRow[];
      const pending = pendingRows.length === 1 ? pendingRows[0] : undefined;
      if (!pending) return "none";

      // Before a MOVE response is durably recorded, an existing destination
      // copy is not enough evidence: Gmail All Mail can contain that copy
      // while the source still has its Inbox label. Require a same-epoch
      // source absence observation before reconciling an uncertain intent.
      const pendingWasIntent = pending.pending_move_state === "intent";
      if (pendingWasIntent && !sourceMembershipAbsentIntentIds.has(pending.id)) return "waiting";

      const allMailArchived = allMailArchivedValue(folder, message.labels);
      // An explicit Inbox label means Gmail has not yet applied the completed
      // archive move. Missing labels are merely unobservable state and must
      // not block an already confirmed MOVE forever.
      if (folder.specialUse === "\\All" && allMailArchived === 0) {
        db.transaction(() => {
          const duplicateDestinationRows = listDestinationCopies.all(
            accountId,
            folder.path,
            remoteLookup,
            pending.id,
          ) as RemoteDeletionCandidate[];
          deleteDestinationCopies.run(accountId, folder.path, remoteLookup, pending.id);
          if (agentEvents && agentLease) {
            for (const duplicate of duplicateDestinationRows) {
              agentEvents.messageDeletedWithinTransaction(agentLease, duplicate.id, {
                reason: "pending-move-destination-duplicate",
                mailbox: duplicate.mailbox,
                uid: duplicate.uid,
                remoteIdLookup: duplicate.remote_id_lookup,
                flagsJson: duplicate.flags_json,
                allMailArchived: duplicate.all_mail_archived,
              });
            }
          }
        })();
        return "waiting";
      }
      const preservedAllMailState = pending.all_mail_archived === 1 ? 1 : null;
      const reconciledAllMailState = allMailArchived
        ?? preservedAllMailState
        // A verified absence from the source plus an exact target identity is
        // sufficient to classify an All Mail intent as archived when labels
        // are not observable from this provider.
        ?? (pendingWasIntent ? 1 : null);
      const flagsJson = JSON.stringify([...(message.flags ?? [])]);
      db.transaction(() => {
        const duplicateDestinationRows = listDestinationCopies.all(
          accountId,
          folder.path,
          remoteLookup,
          pending.id,
        ) as RemoteDeletionCandidate[];
        deleteDestinationCopies.run(accountId, folder.path, remoteLookup, pending.id);
        const reconciled = reconcilePendingMove.run(
          folder.path,
          message.uid,
          flagsJson,
          remoteLookup,
          reconciledAllMailState,
          pending.id,
          accountId,
          folder.path,
          remoteLookup,
        );
        if (reconciled.changes !== 1) throw new Error("Pending message move could not be reconciled.");
        if (agentEvents && agentLease) {
          for (const duplicate of duplicateDestinationRows) {
            agentEvents.messageDeletedWithinTransaction(agentLease, duplicate.id, {
              reason: "pending-move-destination-duplicate",
              mailbox: duplicate.mailbox,
              uid: duplicate.uid,
              remoteIdLookup: duplicate.remote_id_lookup,
              flagsJson: duplicate.flags_json,
              allMailArchived: duplicate.all_mail_archived,
            });
          }
          agentEvents.messageUpsertedWithinTransaction(agentLease, pending.id, {
            transition: "pending-move-reconciled",
            mailbox: folder.path,
            uid: message.uid,
            remoteIdLookup: remoteLookup,
            flagsJson,
            allMailArchived: reconciledAllMailState,
          });
        }
      })();
      return "reconciled";
    };

    for (const folder of folders) {
      if (signal?.aborted) throw new SyncAbortedError();
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
      try {
        lock = await client.getMailboxLock(folder.path);
        const mailbox = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox : undefined;
        const currentUidValidity = uidValidityValue(mailbox?.uidValidity);
        const previousUidValidity = previousFolderState.get(folder.path)?.uid_validity ?? undefined;
        const pendingMoveTouchesFolder = Boolean(folderHasPendingMove.get(accountId, folder.path, folder.path));
        const intentRows = pendingMoveIntents.all(accountId, folder.path) as Array<{
          id: string;
          uid: number;
          remote_id_lookup?: string | null;
        }>;
        const intentByUid = new Map(intentRows.map((row) => [row.uid, row]));
        const sameUidValidity = currentUidValidity !== undefined
          && typeof previousUidValidity === "string"
          && previousUidValidity === currentUidValidity;
        const sourceUidMembershipProven = sameUidValidity;
        const intentUids = [...new Set(intentRows.flatMap((row) =>
          Number.isSafeInteger(row.uid) && row.uid > 0 ? [row.uid] : []
        ))];
        if (intentUids.length) {
          const inspectedSourceUids = new Set<number>();
          for await (const source of client.fetch(intentUids, { uid: true }, { uid: true })) {
            if (signal?.aborted) throw new SyncAbortedError();
            if (!source.uid) continue;
            inspectedSourceUids.add(source.uid);
            const intent = intentByUid.get(source.uid);
            if (!intent) continue;
            const sourceLookup = remoteIdLookup(masterKey, accountId, source.emailId);
            const sourceIdentityProven = Boolean(
              intent.remote_id_lookup && sourceLookup && intent.remote_id_lookup === sourceLookup,
            );
            if (sourceUidMembershipProven || sourceIdentityProven) {
              clearPendingMoveIntent.run(accountId, folder.path, source.uid);
            }
          }
          if (sourceUidMembershipProven) {
            for (const intent of intentRows) {
              if (!inspectedSourceUids.has(intent.uid)) sourceMembershipAbsentIntentIds.add(intent.id);
            }
          }
        }
        if (currentUidValidity !== undefined) {
          if (previousUidValidity !== undefined && previousUidValidity !== currentUidValidity) {
            // UID reuse after a server rebuild can otherwise leave a different
            // message paired with an old cached body or attachment list.
            db.transaction(() => {
              // A reset destroys the UID epoch the intent was verified
              // against. Under a local negative placeholder the intent can no
              // longer re-enter the sync lifecycle (every recovery path
              // requires uid > 0), leaving a ghost row that also permanently
              // blocks the user's next move attempt on that message. The reset
              // already deletes every other cache row of this folder, so drop
              // uncertain intents with it; firmly confirmed moves reconcile by
              // identity against the new epoch and survive.
              const resetIntentRows = db.prepare(`
                SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
                FROM messages
                WHERE account_id = ? AND mailbox = ? AND pending_move_state = 'intent'
              `).all(accountId, folder.path) as Array<{
                id: string;
                mailbox: string;
                uid: number;
                remote_id_lookup: string | null;
                flags_json: string;
                all_mail_archived: number | null;
              }>;
              if (resetIntentRows.length) {
                db.prepare(`
                  DELETE FROM messages
                  WHERE account_id = ? AND mailbox = ? AND pending_move_state = 'intent'
                `).run(accountId, folder.path);
              }
              const resetRows = db.prepare(`
                SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
                FROM messages
                WHERE account_id = ? AND mailbox = ? AND COALESCE(pending_move_destination, '') = ''
              `).all(accountId, folder.path) as Array<{
                id: string;
                mailbox: string;
                uid: number;
                remote_id_lookup: string | null;
                flags_json: string;
                all_mail_archived: number | null;
              }>;
              deleteFolderMessages.run(accountId, folder.path);
              updateFolderUidValidity.run(currentUidValidity, accountId, folder.path);
              if (agentEvents && agentLease) {
                for (const removed of [...resetRows, ...resetIntentRows]) {
                  agentEvents.messageDeletedWithinTransaction(agentLease, removed.id, {
                    reason: "folder-uid-validity-reset",
                    mailbox: folder.path,
                    uid: removed.uid,
                    remoteIdLookup: removed.remote_id_lookup,
                    flagsJson: removed.flags_json,
                    allMailArchived: removed.all_mail_archived,
                  });
                }
              }
            })();
          } else {
            updateFolderUidValidity.run(currentUidValidity, accountId, folder.path);
          }
        }
        const exists = mailbox?.exists ?? 0;
        // A no-UIDPLUS move may already have an exact cached destination
        // outside the rolling sync window. Probe that UID first rather than
        // waiting for it to become one of the newest messages.
        const candidateRows = pendingMoveCandidates.all(accountId, folder.path) as MessageStorageRow[];
        const candidateUids = [...new Set(candidateRows.flatMap((row) => {
          const uid = row.pending_move_candidate_uid;
          return typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0 ? [uid] : [];
        }))];
        if (candidateUids.length) {
          const inspectedCandidates = new Set<number>();
          for await (const candidate of client.fetch(candidateUids, {
            uid: true,
            flags: true,
            labels: isAllMailFolder(folder),
          }, { uid: true })) {
            if (signal?.aborted) throw new SyncAbortedError();
            if (!candidate.uid) continue;
            inspectedCandidates.add(candidate.uid);
            const reconciliation = reconcilePendingRemoteMessage(folder, candidate);
            if (reconciliation === "waiting") deferPendingRemoteMessage(folder, candidate);
            if (reconciliation === "none") {
              // This UID no longer identifies the exact cached destination.
              // Do not keep issuing a stale direct FETCH on every sync.
              clearPendingCandidateUid.run(accountId, folder.path, candidate.uid);
            }
          }
          for (const candidateUid of candidateUids) {
            if (!inspectedCandidates.has(candidateUid)) {
              clearPendingCandidateUid.run(accountId, folder.path, candidateUid);
            }
          }
        }
        if (exists <= 0) {
          if (sameUidValidity && !pendingMoveTouchesFolder) await reconcileRemoteDeletionBatch(folder, currentUidValidity);
          continue;
        }
        // A limit of 0 syncs the whole mailbox (Gmail-style, no cap); any
        // positive value fetches only the newest `messageLimit` messages.
        const start = messageLimit > 0 ? Math.max(1, exists - messageLimit + 1) : 1;
        const newUids: number[] = [];
        const attachmentMetadataRefreshUids: number[] = [];
        const hydratedMessageIds = new Map<number, string>();

        for await (const message of client.fetch(`${start}:*`, {
          uid: true,
          flags: true,
          labels: isAllMailFolder(folder) || autoReplyActive,
        })) {
          if (signal?.aborted) throw new SyncAbortedError();
          if (!message.uid) continue;
          const flagsJson = JSON.stringify([...(message.flags ?? [])]);
          const remoteLookup = remoteIdLookup(masterKey, accountId, message.emailId);
          const allMailArchived = allMailArchivedValue(folder, message.labels);
          let existing = findMessage.get(accountId, folder.path, message.uid) as MessageStorageRow | undefined;
          const reconciliation = reconcilePendingRemoteMessage(folder, message);
          if (reconciliation === "waiting") {
            deferPendingRemoteMessage(folder, message);
            continue;
          }
          if (reconciliation === "reconciled") {
            existing = findMessage.get(accountId, folder.path, message.uid) as MessageStorageRow | undefined;
          }
          if (existing) {
            db.transaction(() => {
              updateCachedMessage.run(
                flagsJson,
                remoteLookup,
                allMailArchived,
                accountId,
                folder.path,
                message.uid,
              );
              if (agentEvents && agentLease) {
                agentEvents.messageUpsertedWithinTransaction(agentLease, existing.id, {
                  transition: "sync-metadata-refresh",
                  mailbox: folder.path,
                  uid: message.uid,
                  remoteIdLookup: remoteLookup ?? (typeof existing.remote_id_lookup === "string" ? existing.remote_id_lookup : null),
                  allMailArchived: allMailArchived ?? (typeof existing.all_mail_archived === "number" ? existing.all_mail_archived : null),
                  flagsJson,
                });
              }
            })();
            // Rows cached before attachment metadata was introduced (and
            // appended drafts, which cannot know MIME part ids yet) are
            // hydrated once when they reappear in the normal sync window. The
            // column is set by every metadata-complete write, so this check
            // never needs to decrypt the row's full payload.
            if (existing.payload_metadata_ready !== 1) {
              attachmentMetadataRefreshUids.push(message.uid);
              // A moved cache row retains its original id, which is part of
              // the encrypted payload AAD. Re-encrypt with that stable id.
              hydratedMessageIds.set(message.uid, existing.id);
            }
          } else {
            newUids.push(message.uid);
          }
        }

        const uidsToFetch = [...new Set([...newUids, ...attachmentMetadataRefreshUids])];
        if (!uidsToFetch.length) {
          if (sameUidValidity && !pendingMoveTouchesFolder) await reconcileRemoteDeletionBatch(folder, currentUidValidity);
          continue;
        }
        const newUidSet = new Set(newUids);
        for await (const message of client.fetch(
          uidsToFetch,
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            size: true,
            source: true,
            labels: isAllMailFolder(folder) || autoReplyActive,
          },
          { uid: true },
        )) {
          if (signal?.aborted) throw new SyncAbortedError();
          if (!message.uid) continue;
          const parsed = message.source ? await simpleParser(message.source) : null;
          const from = addressValues(parsed?.from)[0] ?? {
            name: message.envelope?.from?.[0]?.name ?? "",
            address: message.envelope?.from?.[0]?.address ?? "",
          };
          const recipients = addressValues(parsed?.to);
          const copiedRecipients = addressValues(parsed?.cc);
          const messageId = messageIdValues(parsed?.messageId ?? message.envelope?.messageId)[0] ?? null;
          const inReplyTo = messageIdValues(parsed?.inReplyTo)[0] ?? null;
          const references = messageIdValues(parsed?.references);
          const text = parsed?.text ?? "";
          const html = typeof parsed?.html === "string" ? parsed.html : "";
          const sentAtValue = parsed?.date ?? message.envelope?.date ?? message.internalDate ?? new Date();
          const sentAt = sentAtValue instanceof Date ? sentAtValue : new Date(sentAtValue);
          const id = hydratedMessageIds.get(message.uid) ?? messageKey(accountId, folder.path, message.uid);
          const subject = parsed?.subject ?? message.envelope?.subject ?? "（无主题）";
          const flags = [...(message.flags ?? [])];
          const attachments = attachmentMetadataFromParsedMail(parsed?.attachments ?? []);
          const protectedColumns = protectedMessageColumns(masterKey, id, accountId, {
            messageId,
            subject,
            fromName: from.name,
            fromAddress: from.address,
            to: recipients,
            cc: copiedRecipients,
            inReplyTo,
            references,
            snippet: snippet(text || html.replace(/<[^>]+>/g, " ")),
            textBody: text,
            htmlBody: html,
            attachments,
            headers: {
              autoSubmitted: headerValue(parsed?.headers, "auto-submitted"),
              listUnsubscribe: headerValue(parsed?.headers, "list-unsubscribe"),
              precedence: headerValue(parsed?.headers, "precedence"),
              returnPath: headerValue(parsed?.headers, "return-path"),
              labels: message.labels ? [...message.labels].sort() : [],
            },
          });
          const remoteLookup = remoteIdLookup(masterKey, accountId, message.emailId);
          const allMailArchived = allMailArchivedValue(folder, message.labels);
          const flagsJson = JSON.stringify(flags);
          const sentAtIso = sentAt.toISOString();
          const hasAttachments = parsed?.attachments?.length ? 1 : 0;
          const size = message.size ?? message.source?.length ?? 0;
          db.transaction(() => {
            upsert.run({
              id,
              accountId,
              mailbox: folder.path,
              uid: message.uid,
              remoteIdLookup: remoteLookup,
              allMailArchived,
              ...protectedColumns,
              sentAt: sentAtIso,
              flagsJson,
              hasAttachments,
              attachmentKindsJson: attachmentKindsJson(attachments),
              size,
              payloadMetadataReady: 1,
              createdAt: new Date().toISOString(),
            });
            // The search index mirrors the decrypted payload text so a later
            // FTS query never needs to decrypt the whole candidate set.
            indexMessageFts(db, id, {
              subject,
              fromName: from.name,
              fromAddress: from.address,
              textBody: text,
            });
            if (agentEvents && agentLease) {
              agentEvents.messageUpsertedWithinTransaction(agentLease, id, {
                transition: "sync-message-upsert",
                mailbox: folder.path,
                uid: message.uid,
                remoteIdLookup: remoteLookup,
                allMailArchived,
                messageId,
                subject,
                from,
                to: recipients,
                cc: copiedRecipients,
                inReplyTo,
                references,
                sentAt: sentAtIso,
                text,
                html,
                flags,
                attachments: attachments.map((attachment) => ({
                  partId: attachment.partId,
                  filename: attachment.filename,
                  contentType: attachment.contentType,
                  size: attachment.size,
                  related: attachment.related,
                  disposition: attachment.disposition,
                })),
              });
            }
          })();
          synced += 1;
          if (newUidSet.has(message.uid)) {
            // Senders of freshly arrived mail are seeded into the local
            // address book. This must never break a sync pass: failures are
            // logged and the message itself stays untouched.
            if (from.address) {
              try {
                autoCollectSender(db, masterKey, from.address, from.name, [account.email]);
              } catch (error) {
                console.warn(`Sender auto-collect skipped for account ${accountId}:`, error);
              }
            }
            if ((folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX") && !flags.includes("\\Seen")) {
              newInboxMessages.push({ id, accountId, subject, fromName: from.name, fromAddress: from.address });
            }
          }
        }
        if (sameUidValidity && !pendingMoveTouchesFolder) await reconcileRemoteDeletionBatch(folder, currentUidValidity);
      } catch (error) {
        if (error instanceof SyncAbortedError) throw error;
        failedFolders += 1;
        firstFolderError ??= error;
      } finally {
        lock?.release();
      }
    }

    // Folder priority intentionally visits special-use folders before custom
    // source folders. A target message can therefore be observed before a
    // same-epoch source-UID absence is proven later in this pass. Replay only
    // those exact observations locally so a completed remote MOVE does not
    // remain pending until the next account sync.
    if (sourceMembershipAbsentIntentIds.size > 0) {
      try {
        for (const deferred of deferredPendingRemoteMessages) {
          const remoteLookup = remoteIdLookup(masterKey, accountId, deferred.message.emailId);
          if (!remoteLookup) continue;
          const pendingRows = findPendingMoves.all(accountId, deferred.folder.path, remoteLookup) as MessageStorageRow[];
          const pending = pendingRows.length === 1 ? pendingRows[0] : undefined;
          // A deferred item is already an exact HMAC match from its first
          // observation. Re-check its still-pending intent here so absence from
          // one source folder can never reconcile another pending move.
          if (!pending || pending.pending_move_state !== "intent" || !sourceMembershipAbsentIntentIds.has(pending.id)) continue;
          reconcilePendingRemoteMessage(deferred.folder, deferred.message);
        }
      } catch (error) {
        // Replay is a local-only refinement after the folder passes already
        // succeeded; a failure here must not fail the whole sync pass.
        console.warn(`Pending move replay failed for account ${accountId}:`, error);
      }
    }

    if (folders.length > 0 && failedFolders === folders.length) throw firstFolderError;

    const syncedAt = new Date().toISOString();
    if (failedFolders > 0) {
      // A partial pass has fresh data, but it is not a healthy account state:
      // retain a safe, actionable diagnostic until every folder succeeds.
      db.prepare(`
        UPDATE accounts SET status = 'degraded', last_error = ?, last_error_code = 'partial_sync', last_synced_at = ? WHERE id = ?
      `).run(partialSyncMessage(failedFolders), syncedAt, accountId);
    } else {
      db.prepare(`
        UPDATE accounts SET status = 'connected', last_error = NULL, last_error_code = NULL, last_synced_at = ? WHERE id = ?
      `).run(syncedAt, accountId);
    }
    // The provider's Sent folder is the strongest confirmation available to
    // IMAP/SMTP accounts after an interrupted or merely SMTP-accepted send.
    try {
      confirmSubmissionsInSent(db, masterKey, accountId);
    } catch (error) {
      // The pass itself already succeeded; a Sent verification failure must
      // not surface as a failed sync (it would mask the healthy update above).
      console.warn(`Sent-folder submission verification failed for account ${accountId}:`, error);
    }
    pendingRuleTargets = newInboxMessages;
    pendingAutoReplyTargets = newInboxMessages.map((message) => message.id);
    return { synced, folders: folders.length, failedFolders, newInboxMessages };
  } catch (error) {
    if (error instanceof SyncAbortedError) throw error;
    // Do not retain raw provider/socket errors. They can include opaque server
    // replies and must not become account data exposed by the local API.
    const code = mailErrorCode(error);
    const message = friendlyMailError(error);
    const status = code === "reauth_required" ? "reauth_required" : "error";
    db.prepare("UPDATE accounts SET status = ?, last_error = ?, last_error_code = ? WHERE id = ?").run(status, message, code, accountId);
    throw error;
  } finally {
    running.delete(accountId);
    if (client?.usable) await client.logout().catch(() => undefined);
    if (pendingRuleTargets.length > 0) {
      const targets = pendingRuleTargets;
      pendingRuleTargets = [];
      // Filter-rule automation must never break the sync result. Failures are
      // logged and the affected messages remain visible for manual handling.
      void applyFilterRulesToNewMessages(db, masterKey, accountId, targets, accessTokenProvider, agentEvents)
        .catch((error) => {
          console.warn(`Filter rule application failed for account ${accountId}:`, error);
        });
    }
    if (pendingAutoReplyTargets.length > 0) {
      const targets = pendingAutoReplyTargets;
      pendingAutoReplyTargets = [];
      // Auto-reply processing is equally non-blocking: confirmation prompts
      // live in the engine and their expiry is guarded by its own timers.
      getAutoReplyEngine()?.notifyInboxMessages(accountId, targets)
        .catch((error) => {
          console.warn(`Auto-reply pipeline failed for account ${accountId}:`, error);
        });
    }
  }
}

/**
 * Applies enabled filter rules to newly arrived inbox messages after a sync
 * pass has finished. Runs after the per-account sync guard is released so the
 * reused flag/move operations can open their own IMAP session. Each message is
 * handled by at most the first matching rule (in rule position order); a failed
 * action stops that rule's remaining actions but never fails the sync itself.
 */
export async function applyFilterRulesToNewMessages(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  newMessages: Array<{ id: string }>,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<{ matched: number; failed: number }> {
  const rules = listEnabledFilterRules(db, accountId);
  if (rules.length === 0 || newMessages.length === 0) return { matched: 0, failed: 0 };
  let matched = 0;
  let failed = 0;
  for (const message of newMessages) {
    const entry = messagePayloadById(db, masterKey, message.id);
    if (!entry) continue;
    const rule = rules.find((candidate) => matchesFilterRuleConditions(candidate.conditions, entry.payload));
    if (!rule) continue;
    try {
      for (const action of rule.actions) {
        switch (action.kind) {
          case "mark_seen":
            await updateMessageFlags(db, masterKey, message.id, { seen: true }, accessTokenProvider, agentEvents);
            break;
          case "add_flag":
            await updateMessageFlags(db, masterKey, message.id, { flagged: true }, accessTokenProvider, agentEvents);
            break;
          case "archive":
            await moveMessage(db, masterKey, message.id, "archive", accessTokenProvider, agentEvents);
            break;
          case "move_to_folder":
            await moveMessageToFolder(db, masterKey, message.id, action.folderPath, accessTokenProvider, agentEvents);
            break;
        }
      }
      matched += 1;
    } catch {
      failed += 1;
    }
  }
  return { matched, failed };
}

export type MessageFlagsPatch = {
  seen?: boolean;
  flagged?: boolean;
};

const messageFlagNames = {
  seen: "\\Seen",
  flagged: "\\Flagged",
} as const;

export async function updateMessageFlags(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  patch: MessageFlagsPatch,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<void> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(messageId) as {
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
    } | undefined;
  if (!message) throw new Error("Message not found.");
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError) throw new Error(moveBlockedError);
  // The account-level write slot queues a flag update behind any move in
  // flight on the same account. Without it, starring a message while its
  // delete is still dispatching fails with a "pending move" error instead of
  // simply waiting its turn. This also serializes filter-rule and agent flag
  // writes against user moves.
  await withAccountWriteLocks([message.account_id], async () => {
    const currentFlags = new Set<string>(JSON.parse(message.flags_json));
    const nextFlags = new Set(currentFlags);
    const add: string[] = [];
    const remove: string[] = [];
    for (const [field, flag] of Object.entries(messageFlagNames) as Array<[keyof MessageFlagsPatch, string]>) {
      const value = patch[field];
      if (value === undefined || currentFlags.has(flag) === value) continue;
      if (value) {
        nextFlags.add(flag);
        add.push(flag);
      } else {
        nextFlags.delete(flag);
        remove.push(flag);
      }
    }
    // The requested state is already reflected in the last server-confirmed
    // cache. Avoid a redundant STORE command and, importantly, a second count
    // adjustment for an idempotent read/open action.
    if (!add.length && !remove.length) return;
    const account = accountById(db, message.account_id);
    if (!account) throw new Error("Account not found.");
    const agentLease = agentEvents?.acquireLease(message.account_id);
    const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(message.mailbox);
      try {
        if (add.length) {
          const added = await client.messageFlagsAdd(message.uid, add, { uid: true });
          if (added === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
        }
        if (remove.length) {
          const removed = await client.messageFlagsRemove(message.uid, remove, { uid: true });
          if (removed === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
        }
      } finally {
        lock.release();
      }
      const seenChanged = currentFlags.has("\\Seen") !== nextFlags.has("\\Seen");
      db.transaction(() => {
        db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify([...nextFlags]), messageId);
        if (seenChanged) {
          // Keep the cached sidebar badge aligned with the successful remote
          // STORE. The folder refresh remains authoritative, but it must not
          // briefly restore an already-read message to the unread total.
          db.prepare(`
            UPDATE folders
            SET unseen = CASE
              WHEN ? = 1 THEN CASE WHEN unseen > 0 THEN unseen - 1 ELSE 0 END
              ELSE unseen + 1
            END
            WHERE account_id = ? AND path = ?
          `).run(nextFlags.has("\\Seen") ? 1 : 0, message.account_id, message.mailbox);
        }
        if (agentEvents && agentLease) {
          agentEvents.messageUpsertedWithinTransaction(agentLease, messageId, {
            mailbox: message.mailbox,
            uid: message.uid,
            remoteIdLookup: message.remote_id_lookup,
            flags: [...nextFlags].sort(),
            pendingMoveDestination: message.pending_move_destination,
            pendingMoveState: message.pending_move_state,
          });
        }
      })();
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  });
}

/**
 * Applies the same flag patch to many messages using one IMAP connection per
 * account and one STORE command per mailbox, instead of one connection and one
 * command per message. Failures are per-message: the caller receives how many
 * messages were updated and how many failed, mirroring the per-id behavior of
 * the previous loop.
 */
export async function updateMessageFlagsBatch(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageIds: readonly string[],
  patch: MessageFlagsPatch,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentMailEvents?: AgentMailEventSink,
): Promise<{ updated: number; failed: number; changedIds: string[] }> {
  if (!messageIds.length) return { updated: 0, failed: 0, changedIds: [] };
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id IN (${placeholders})`)
    .all(...messageIds) as Array<{
      id: string;
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
    }>;

  // Prepare per-message next flags; skip messages that no longer exist or
  // would not change. These are counted as "updated" to keep the overall
  // operation idempotent (they were already in the requested state).
  type PreparedMessage = {
    message: typeof rows[number];
    nextFlags: string[];
    add: string[];
    remove: string[];
    seenChanged: boolean;
  };
  const prepared: PreparedMessage[] = [];
  const blocked: string[] = [];
  for (const message of rows) {
    if (moveActionBlockedError(message)) {
      blocked.push(message.id);
      continue;
    }
    const currentFlags = new Set<string>(JSON.parse(message.flags_json));
    const nextFlags = new Set(currentFlags);
    const add: string[] = [];
    const remove: string[] = [];
    for (const [field, flag] of Object.entries(messageFlagNames) as Array<[keyof MessageFlagsPatch, string]>) {
      const value = patch[field];
      if (value === undefined || currentFlags.has(flag) === value) continue;
      if (value) {
        nextFlags.add(flag);
        add.push(flag);
      } else {
        nextFlags.delete(flag);
        remove.push(flag);
      }
    }
    prepared.push({ message, nextFlags: [...nextFlags], add, remove, seenChanged: currentFlags.has("\\Seen") !== nextFlags.has("\\Seen") });
  }

  // Group by account: one connection per account, one STORE per mailbox.
  const byAccount = new Map<string, PreparedMessage[]>();
  for (const item of prepared) {
    const group = byAccount.get(item.message.account_id) ?? [];
    group.push(item);
    byAccount.set(item.message.account_id, group);
  }

  let updated = 0;
  let failed = blocked.length + (messageIds.length - rows.length);
  const changedIds: string[] = [];
  for (const [accountId, messages] of byAccount) {
    // The account write slot serializes the read-modify-write against any move
    // or flag update in flight on the same account, mirroring the single-message
    // `updateMessageFlags` path. Without it, a batch STORE racing a move (or
    // sync) can overwrite the freshly reconciled flags_json.
    await withAccountWriteLocks([accountId], async () => {
      const account = accountById(db, accountId);
      if (!account) {
        failed += messages.length;
        return;
      }
      const agentLease = agentMailEvents?.acquireLease(accountId);
      const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
      let remoteSucceeded = false;
      try {
        await client.connect();
        const byMailbox = new Map<string, PreparedMessage[]>();
        for (const item of messages) {
          const group = byMailbox.get(item.message.mailbox) ?? [];
          group.push(item);
          byMailbox.set(item.message.mailbox, group);
        }
        for (const [mailbox, mailboxMessages] of byMailbox) {
          const lock = await client.getMailboxLock(mailbox);
          try {
            // Messages in the same mailbox may need different flag changes
            // (some add \\Seen, others already have it). Group by the exact
            // flag set so each STORE command covers a uniform batch.
            const byFlagGroup = new Map<string, { add: string[]; remove: string[]; uids: number[] }>();
            for (const item of mailboxMessages) {
              const key = `${item.add.join(",")}\u0000${item.remove.join(",")}`;
              let group = byFlagGroup.get(key);
              if (!group) {
                group = { add: item.add, remove: item.remove, uids: [] };
                byFlagGroup.set(key, group);
              }
              group.uids.push(item.message.uid);
            }
            for (const group of byFlagGroup.values()) {
              if (group.add.length && group.uids.length) {
                const added = await client.messageFlagsAdd(group.uids, group.add, { uid: true });
                if (added === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
              }
              if (group.remove.length && group.uids.length) {
                const removed = await client.messageFlagsRemove(group.uids, group.remove, { uid: true });
                if (removed === false) throw new Error("邮件服务器未确认状态更新，请稍后重试。");
              }
            }
          } finally {
            lock.release();
          }
        }
        remoteSucceeded = true;
      } catch {
        remoteSucceeded = false;
      } finally {
        if (client?.usable) await client.logout().catch(() => undefined);
      }
      if (!remoteSucceeded) {
        failed += messages.length;
        return;
      }

      // Persist locally only after the remote STORE succeeded for every message
      // in the account.
      db.transaction(() => {
        for (const item of messages) {
          const { message } = item;
          db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify(item.nextFlags), message.id);
          // Only messages that actually changed state are undo candidates;
          // idempotent no-ops (already in the requested state) stay in `updated`.
          if (item.add.length || item.remove.length) changedIds.push(message.id);
          if (item.seenChanged) {
            db.prepare(`
              UPDATE folders
              SET unseen = CASE
                WHEN ? = 1 THEN CASE WHEN unseen > 0 THEN unseen - 1 ELSE 0 END
                ELSE unseen + 1
              END
              WHERE account_id = ? AND path = ?
            `).run(item.nextFlags.includes("\\Seen") ? 1 : 0, message.account_id, message.mailbox);
          }
          if (agentMailEvents && agentLease) {
            agentMailEvents.messageUpsertedWithinTransaction(agentLease, message.id, {
              mailbox: message.mailbox,
              uid: message.uid,
              remoteIdLookup: message.remote_id_lookup,
              flags: [...item.nextFlags].sort(),
              pendingMoveDestination: message.pending_move_destination,
              pendingMoveState: message.pending_move_state,
            });
          }
        }
      })();
      updated += messages.length;
    });
  }
  const changedSet = new Set(changedIds);
  return { updated, failed, changedIds: messageIds.filter((id) => changedSet.has(id)) };
}

export async function markMessageSeen(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  seen: boolean,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<void> {
  await updateMessageFlags(db, masterKey, messageId, { seen }, accessTokenProvider, agentEvents);
}

export type MessageMoveTarget = "archive" | "trash" | "junk" | "inbox";

const moveTargets: Record<MessageMoveTarget, { specialUses: string[]; unavailableMessage: string }> = {
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

function messageIsUnseen(flagsJson: string): boolean {
  try {
    const flags = JSON.parse(flagsJson);
    return Array.isArray(flags) && !flags.includes("\\Seen");
  } catch {
    // A malformed legacy cache row must not make an already-confirmed server
    // MOVE look like a failure. A later sync will repair the folder count.
    return false;
  }
}

function updateFolderCountsForMove(
  db: DatabaseHandle,
  message: { account_id: string; mailbox: string; flags_json: string },
  destination: { path: string; special_use: string | null },
  destinationAlreadyCached = false,
): void {
  const unseen = messageIsUnseen(message.flags_json) ? 1 : 0;
  db.prepare(`
    UPDATE folders
    SET
      total = CASE WHEN total > 0 THEN total - 1 ELSE 0 END,
      unseen = CASE WHEN ? = 1 AND unseen > 0 THEN unseen - 1 ELSE unseen END
    WHERE account_id = ? AND path = ?
  `).run(unseen, message.account_id, message.mailbox);

  // Gmail's \All already contains the message before archive removes its
  // Inbox label. Physical archive, trash, junk, and inbox folders gain a new
  // membership (the last one when a misclassified Junk message is recovered).
  if (!destinationAlreadyCached && (destination.special_use === "\\Archive" || destination.special_use === "\\Trash" || destination.special_use === "\\Junk" || destination.special_use === "\\Inbox")) {
    db.prepare(`
      UPDATE folders
      SET total = total + 1, unseen = unseen + ?
      WHERE account_id = ? AND path = ?
    `).run(unseen, message.account_id, destination.path);
  }
}

function pendingMoveUid(
  db: DatabaseHandle,
  accountId: string,
  mailbox: string,
  sourceUid: number,
): number {
  const preferredUid = -sourceUid;
  const preferredInUse = db.prepare(`
    SELECT 1 FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?
  `).get(accountId, mailbox, preferredUid);
  if (!preferredInUse) return preferredUid;

  // UIDVALIDITY resets can make a new live UID collide with the negative
  // placeholder left by an older pending move. Allocate below the current
  // local negative range; this UID is never sent back to the server.
  const lowestPendingUid = db.prepare(`
    SELECT MIN(uid) AS uid FROM messages
    WHERE account_id = ? AND mailbox = ? AND uid < 0
  `).get(accountId, mailbox) as { uid: number | null };
  const nextUid = (lowestPendingUid.uid ?? 0) - 1;
  if (!Number.isSafeInteger(nextUid)) throw new Error("Too many pending message moves to allocate a local identifier.");
  return nextUid;
}

function cachedDestinationCandidateUid(
  db: DatabaseHandle,
  accountId: string,
  destinationMailbox: string,
  remoteIdLookupValue: string | null,
  sourceMessageId: string,
): number | null {
  if (!remoteIdLookupValue) return null;
  const candidates = db.prepare(`
    SELECT uid FROM messages
    WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
    ORDER BY uid
    LIMIT 2
  `).all(accountId, destinationMailbox, remoteIdLookupValue, sourceMessageId) as Array<{ uid: number }>;
  if (candidates.length !== 1) return null;
  const candidateUid = candidates[0]?.uid;
  return typeof candidateUid === "number" && Number.isSafeInteger(candidateUid) && candidateUid > 0
    ? candidateUid
    : null;
}

type MoveDestination = { path: string; special_use: string | null };

export type MessageMoveResult = {
  accountId: string;
  destination: string;
  refreshPending: boolean;
  uid?: number;
  uncertain?: boolean;
  locationUnverified?: boolean;
};

/**
 * Moves a message to an explicit folder path of its own account. Used by
 * filter rules so "move to folder" can address any known folder, not only
 * the archive/trash shortcuts.
 */
export async function moveMessageToFolder(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  folderPath: string,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<MessageMoveResult> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(messageId) as {
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
    } | undefined;
  if (!message) throw new Error("Message not found.");
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError && !isRecoverableStaleMove(message)) throw new Error(moveBlockedError);
  if (message.mailbox === folderPath) throw new Error("邮件已经在该文件夹中。");
  const folder = db.prepare(`
    SELECT path, special_use FROM folders WHERE account_id = ? AND path = ?
  `).get(message.account_id, folderPath) as MoveDestination | undefined;
  if (!folder) throw new Error("目标文件夹不存在或不可用。");
  return moveMessageCore(db, masterKey, messageId, folder, accessTokenProvider, agentEvents);
}

type MoveMessageOptions = {
  /** A connected IMAP client to reuse (batch moves share one per account). */
  client?: Awaited<ReturnType<typeof imapClientForAccount>>;
};

/**
 * Only an 'intent' left behind by an interrupted transfer can be re-probed
 * against the source mailbox and retried. A 'confirmed' move and an
 * unverified location stay blocked until a sync reconciles the target.
 */
function isRecoverableStaleMove(message: { pending_move_state: string | null; uid: number }): boolean {
  return message.pending_move_state === "intent" && message.uid > 0;
}

/**
 * Proves whether the source UID of a stale 'intent' is still live. Present:
 * the interrupted MOVE never executed, so the intent is discarded for a fresh
 * attempt (true). Absent: the MOVE did happen and reconciliation owns the
 * outcome (false).
 */
async function recoverStaleMoveIntent(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  message: { account_id: string; mailbox: string; uid: number },
  accessTokenProvider?: AccountAccessTokenProvider,
  sharedClient?: Awaited<ReturnType<typeof imapClientForAccount>>,
): Promise<boolean> {
  const account = accountById(db, message.account_id);
  if (!account) return false;
  const client = sharedClient ?? (await imapClientForAccount(account, masterKey, accessTokenProvider));
  const ownsClient = !sharedClient;
  try {
    if (ownsClient) await client.connect();
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      for await (const item of client.fetch([message.uid], { uid: true }, { uid: true })) {
        if (item.uid === message.uid) {
          db.prepare(`
            UPDATE messages
            SET pending_move_destination = NULL,
                pending_move_state = NULL,
                pending_move_candidate_uid = NULL,
                pending_move_special_use = NULL
            WHERE id = ? AND pending_move_state = 'intent'
          `).run(messageId);
          return true;
        }
      }
    } finally {
      lock.release();
    }
    return false;
  } finally {
    if (ownsClient && client.usable) await client.logout().catch(() => undefined);
  }
}

export async function moveMessage(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  target: MessageMoveTarget,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  options?: MoveMessageOptions,
): Promise<MessageMoveResult> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(messageId) as {
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
    } | undefined;
  if (!message) throw new Error("Message not found.");
  // A move already being reconciled must block before the target folder is
  // resolved: the provider folder may not exist (e.g. no Trash on the account)
  // and must not shadow the reconciliation error. A stale 'intent' may be
  // retried after core proves the source UID is still live.
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError && !isRecoverableStaleMove(message)) throw new Error(moveBlockedError);
  const targetDefinition = moveTargets[target];
  const destination = resolveMoveDestination(db, message.account_id, target);
  if (!destination) throw new Error(targetDefinition.unavailableMessage);
  if (destination.path === message.mailbox) {
    // The message already lives in the target folder (e.g. a second delete
    // from the Trash view, or an archive action inside All Mail). Moving it
    // again is an idempotent no-op: report success so the renderer clears
    // the message from the current view instead of failing the action.
    return { accountId: message.account_id, destination: destination.path, refreshPending: false };
  }
  // The account-level write slot serializes concurrent user operations: a
  // move issued while another move is in flight waits its turn instead of
  // failing with a busy error. Reentrant callers (batch fallbacks, undo)
  // acquire the slot once at their own level, so this nesting never recurses.
  return withAccountWriteLocks([message.account_id], () =>
    moveMessageCore(db, masterKey, messageId, destination, accessTokenProvider, agentEvents, options),
  );
}

type MoveMessageFields = {
  account_id: string;
  mailbox: string;
  uid: number;
  flags_json: string;
  remote_id_lookup: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

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
  const targetDefinition = moveTargets[target];
  const placeholders = targetDefinition.specialUses.map(() => "?").join(", ");
  const destination = db.prepare(`
    SELECT path, special_use FROM folders
    WHERE account_id = ? AND special_use IN (${placeholders})
    ORDER BY CASE special_use
      WHEN '\\Archive' THEN 0
      WHEN '\\Trash' THEN 0
      ELSE 1
    END
    LIMIT 1
  `).get(accountId, ...targetDefinition.specialUses) as MoveDestination | undefined;
  return destination ?? null;
}

/**
 * Persists the UIDPLUS-confirmed outcome of a provider MOVE: the row is
 * rebound to the exact destination UID, duplicate destination rows from a
 * cached \All copy are dropped, and folder counts are adjusted. Shared by
 * single-message moves and aggregated batch moves so both keep identical
 * intent/UIDPLUS semantics.
 */
/**
 * Gmail's IMAP virtual folders exclude messages in Trash, but the local cache
 * keeps one row per folder view. After a confirmed move to \Trash those mirror
 * rows are stale and would keep deleted mail visible in the All Mail /
 * Important views until the slow remote-deletion probe sweep happens to reach
 * them. Removes them and adjusts the affected folder counts. Custom-label
 * folder rows are kept: Gmail preserves those labels on trashed messages.
 *
 * Gmail reports \All / \Flagged / \Inbox via LIST special-use but not
 * \Important (the 重要 folder arrives with special_use NULL), so system views
 * are additionally matched by the provider's reserved "[Gmail]/" namespace
 * prefix — the prefix is locale-independent while the folder suffix is not.
 * User labels live at the top level and never match. Shared by the UIDPLUS and
 * pending-reconciliation move paths.
 */
function removeTrashSystemViewMirrors(
  db: DatabaseHandle,
  message: { account_id: string; remote_id_lookup: string | null },
  messageId: string,
  agentEvents?: AgentMailEventSink,
  agentLease?: ReturnType<NonNullable<AgentMailEventSink["acquireLease"]>>,
): void {
  if (!message.remote_id_lookup) return;
  const mirrorRows = db.prepare(`
    SELECT id, mailbox, uid, flags_json, all_mail_archived
    FROM messages
    WHERE account_id = ?
      AND remote_id_lookup = ?
      AND id <> ?
      AND COALESCE(pending_move_destination, '') = ''
      AND pending_move_state IS NULL
      AND mailbox IN (
        SELECT path FROM folders
        WHERE account_id = ?
          AND (
            special_use IN ('\\All', '\\Important', '\\Flagged', '\\Inbox')
            OR path LIKE '[Gmail]/%'
          )
      )
  `).all(message.account_id, message.remote_id_lookup, messageId, message.account_id) as Array<{
    id: string;
    mailbox: string;
    uid: number;
    flags_json: string;
    all_mail_archived: number | null;
  }>;
  if (!mirrorRows.length) return;
  const decreaseFolderCount = db.prepare(`
    UPDATE folders
    SET
      total = CASE WHEN total > 0 THEN total - 1 ELSE 0 END,
      unseen = CASE WHEN ? = 1 AND unseen > 0 THEN unseen - 1 ELSE unseen END
    WHERE account_id = ? AND path = ?
  `);
  const deleteMirror = db.prepare(`
    DELETE FROM messages
    WHERE id = ? AND account_id = ? AND mailbox = ?
      AND COALESCE(pending_move_destination, '') = ''
      AND pending_move_state IS NULL
  `);
  for (const mirror of mirrorRows) {
    decreaseFolderCount.run(messageIsUnseen(mirror.flags_json) ? 1 : 0, message.account_id, mirror.mailbox);
    deleteMirror.run(mirror.id, message.account_id, mirror.mailbox);
    if (agentEvents && agentLease) {
      agentEvents.messageDeletedWithinTransaction(agentLease, mirror.id, {
        reason: "move-mirror-removed",
        mailbox: mirror.mailbox,
        uid: mirror.uid,
        remoteIdLookup: message.remote_id_lookup,
        flagsJson: mirror.flags_json,
        allMailArchived: mirror.all_mail_archived,
      });
    }
  }
}

function applyMoveConfirmedUidPlus(
  db: DatabaseHandle,
  messageId: string,
  message: MoveMessageFields,
  destination: MoveDestination,
  destinationUid: number,
  agentEvents?: AgentMailEventSink,
  agentLease?: ReturnType<NonNullable<AgentMailEventSink["acquireLease"]>>,
): void {
  db.transaction(() => {
    // Gmail can already have a cached \All copy. UIDPLUS proves this is
    // the same server message, so preserve the current UI-facing id.
    const duplicateDestinationRows = db.prepare(`
      SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
      FROM messages
      WHERE account_id = ? AND mailbox = ? AND uid = ? AND id <> ?
    `).all(message.account_id, destination.path, destinationUid, messageId) as Array<{
      id: string;
      mailbox: string;
      uid: number;
      remote_id_lookup: string | null;
      flags_json: string;
      all_mail_archived: number | null;
    }>;
    const removedDestinationRow = db.prepare(`
      DELETE FROM messages
      WHERE account_id = ? AND mailbox = ? AND uid = ? AND id <> ?
    `).run(message.account_id, destination.path, destinationUid, messageId);
    const updated = db.prepare(`
      UPDATE messages
      SET mailbox = ?,
          uid = ?,
          all_mail_archived = ?,
          pending_move_destination = NULL,
          pending_move_state = NULL,
          pending_move_candidate_uid = NULL,
          pending_move_special_use = NULL
      WHERE id = ? AND pending_move_state = 'intent'
    `).run(destination.path, destinationUid, destination.special_use === "\\All" ? 1 : null, messageId);
    if (updated.changes !== 1) throw new Error("Move intent was not available for UIDPLUS reconciliation.");
    updateFolderCountsForMove(db, message, destination, removedDestinationRow.changes > 0);
    if (destination.special_use === "\\Trash") {
      removeTrashSystemViewMirrors(db, message, messageId, agentEvents, agentLease);
    }
    if (agentEvents && agentLease) {
      for (const duplicate of duplicateDestinationRows) {
        agentEvents.messageDeletedWithinTransaction(agentLease, duplicate.id, {
          reason: "move-destination-duplicate",
          mailbox: duplicate.mailbox,
          uid: duplicate.uid,
          remoteIdLookup: duplicate.remote_id_lookup,
          flagsJson: duplicate.flags_json,
          allMailArchived: duplicate.all_mail_archived,
        });
      }
      agentEvents.messageUpsertedWithinTransaction(agentLease, messageId, {
        transition: "move-confirmed",
        mailbox: destination.path,
        uid: destinationUid,
        remoteIdLookup: message.remote_id_lookup,
        flagsJson: message.flags_json,
        allMailArchived: destination.special_use === "\\All" ? 1 : null,
      });
    }
  })();
}

/**
 * Persists a provider MOVE on a server without UIDPLUS: the encrypted source
 * row is kept durable at the destination and marked 'confirmed' so a later
 * sync can reconcile the exact opaque remote identifier.
 */
function applyMovePendingReconciliation(
  db: DatabaseHandle,
  messageId: string,
  message: MoveMessageFields,
  destination: MoveDestination,
  agentEvents?: AgentMailEventSink,
  agentLease?: ReturnType<NonNullable<AgentMailEventSink["acquireLease"]>>,
): { refreshPending: boolean; locationUnverified: boolean } {
  db.transaction(() => {
    const candidateUid = cachedDestinationCandidateUid(
      db,
      message.account_id,
      destination.path,
      message.remote_id_lookup,
      messageId,
    );
    const duplicateDestinationRows = message.remote_id_lookup
      ? db.prepare(`
        SELECT id, mailbox, uid, remote_id_lookup, flags_json, all_mail_archived
        FROM messages
        WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
      `).all(message.account_id, destination.path, message.remote_id_lookup, messageId) as Array<{
          id: string;
          mailbox: string;
          uid: number;
          remote_id_lookup: string | null;
          flags_json: string;
          all_mail_archived: number | null;
        }>
      : [];
    const removedDestinationRows = message.remote_id_lookup
      ? db.prepare(`
        DELETE FROM messages
        WHERE account_id = ? AND mailbox = ? AND remote_id_lookup = ? AND id <> ?
      `).run(message.account_id, destination.path, message.remote_id_lookup, messageId)
      : { changes: 0 };
    const localPendingUid = pendingMoveUid(db, message.account_id, message.mailbox, message.uid);
    const confirmed = db.prepare(`
      UPDATE messages
      SET uid = ?,
          pending_move_destination = ?,
          pending_move_state = 'confirmed',
          pending_move_candidate_uid = ?,
          pending_move_special_use = ?,
          all_mail_archived = ?
      WHERE id = ? AND pending_move_state = 'intent'
    `).run(
      localPendingUid,
      destination.path,
      candidateUid,
      destination.special_use,
      destination.special_use === "\\All" ? 1 : null,
      messageId,
    );
    if (confirmed.changes !== 1) throw new Error("Move intent was not available for pending reconciliation.");
    updateFolderCountsForMove(db, message, destination, removedDestinationRows.changes > 0);
    if (destination.special_use === "\\Trash") {
      removeTrashSystemViewMirrors(db, message, messageId, agentEvents, agentLease);
    }
    if (agentEvents && agentLease) {
      for (const duplicate of duplicateDestinationRows) {
        agentEvents.messageDeletedWithinTransaction(agentLease, duplicate.id, {
          reason: "move-destination-duplicate",
          mailbox: duplicate.mailbox,
          uid: duplicate.uid,
          remoteIdLookup: duplicate.remote_id_lookup,
          flagsJson: duplicate.flags_json,
          allMailArchived: duplicate.all_mail_archived,
        });
      }
      agentEvents.messageUpsertedWithinTransaction(agentLease, messageId, {
        transition: "move-confirmed-pending-reconciliation",
        mailbox: message.mailbox,
        uid: localPendingUid,
        destination: destination.path,
        destinationSpecialUse: destination.special_use,
        remoteIdLookup: message.remote_id_lookup,
        flagsJson: message.flags_json,
        candidateUid,
        allMailArchived: destination.special_use === "\\All" ? 1 : null,
      });
    }
  })();
  return {
    refreshPending: message.remote_id_lookup !== null,
    locationUnverified: message.remote_id_lookup === null,
  };
}

async function moveMessageCore(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  destination: MoveDestination,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  options?: MoveMessageOptions,
): Promise<MessageMoveResult> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(messageId) as {
      account_id: string;
      mailbox: string;
      uid: number;
      flags_json: string;
      remote_id_lookup: string | null;
      pending_move_destination: string | null;
      pending_move_state: string | null;
  } | undefined;
  if (!message) throw new Error("Message not found.");
  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");
  const agentLease = agentEvents?.acquireLease(message.account_id);
  if (running.has(message.account_id) || movingAccounts.has(message.account_id)) {
    throw new Error(PENDING_MOVE_RECONCILIATION_ERROR);
  }

  const clearMoveIntent = db.prepare(`
    UPDATE messages
    SET pending_move_destination = NULL,
        pending_move_state = NULL,
        pending_move_candidate_uid = NULL,
        pending_move_special_use = NULL
    WHERE id = ? AND pending_move_state = 'intent'
  `);
  let client: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;
  let ownedClient: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;
  let moveAttempted = false;
  let moveSettled = false;
  let commandRefused = false;
  let intentClaimed = false;
  movingAccounts.add(message.account_id);
  try {
    // A stale 'intent' (an earlier MOVE whose response was lost) may never
    // have reached the provider. Prove whether the source UID is still live
    // before either retrying the move or leaving reconciliation in charge;
    // the probe reuses the connection the retry will move on.
    let moveBlockedError = moveActionBlockedError(message);
    if (moveBlockedError === PENDING_MOVE_RECONCILIATION_ERROR && isRecoverableStaleMove(message)) {
      if (!options?.client) {
        ownedClient = await imapClientForAccount(account, masterKey, accessTokenProvider);
        await ownedClient.connect();
      }
      const recovered = await recoverStaleMoveIntent(db, masterKey, messageId, message, accessTokenProvider, options?.client ?? ownedClient);
      if (recovered) moveBlockedError = null;
    }
    if (moveBlockedError) throw new Error(moveBlockedError);

    const intentCandidateUid = cachedDestinationCandidateUid(
      db,
      message.account_id,
      destination.path,
      message.remote_id_lookup,
      messageId,
    );

    // The intent is durable before any provider command. If the process exits
    // after the command is accepted but before the response is persisted, sync
    // can either prove the source still exists or reconcile the exact target.
    const beganIntent = db.prepare(`
      UPDATE messages
      SET pending_move_destination = ?,
          pending_move_state = 'intent',
          pending_move_candidate_uid = ?,
          pending_move_special_use = ?
      WHERE id = ? AND COALESCE(pending_move_destination, '') = ''
    `).run(destination.path, intentCandidateUid, destination.special_use, messageId);
    if (beganIntent.changes !== 1) throw new Error(PENDING_MOVE_RECONCILIATION_ERROR);
    intentClaimed = true;

    if (options?.client) {
      client = options.client;
    } else {
      if (!ownedClient) {
        ownedClient = await imapClientForAccount(account, masterKey, accessTokenProvider);
        await ownedClient.connect();
      }
      client = ownedClient;
    }
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      moveAttempted = true;
      const moved = await client.messageMove(message.uid, destination.path, { uid: true });
      if (!moved) {
        commandRefused = true;
        clearMoveIntent.run(messageId);
        throw new Error("邮件服务器未确认移动操作，请稍后重试。");
      }
      const destinationUid = moved.uidMap?.get(message.uid);
      if (typeof destinationUid === "number" && Number.isSafeInteger(destinationUid) && destinationUid > 0) {
        applyMoveConfirmedUidPlus(db, messageId, message, destination, destinationUid, agentEvents, agentLease);
        moveSettled = true;
        return { accountId: message.account_id, destination: destination.path, refreshPending: false, uid: destinationUid };
      }
    } finally {
      lock.release();
    }
    // Servers without UIDPLUS do not identify the destination UID. Keep the
    // encrypted source row durable and expose its effective destination until
    // a later sync can reconcile the exact opaque remote identifier.
    const reconciled = applyMovePendingReconciliation(db, messageId, message, destination, agentEvents, agentLease);
    moveSettled = true;
    // Without a stable server identifier, the confirmed move is still real,
    // but the local cache cannot safely bind its preserved payload to a target
    // UID. Keep it readable at the confirmed destination and block operations
    // that would otherwise address the old, local-only UID.
    return {
      accountId: message.account_id,
      destination: destination.path,
      refreshPending: reconciled.refreshPending,
      ...(reconciled.locationUnverified ? { locationUnverified: true } : {}),
    };
  } catch (error) {
    if (moveSettled) throw error;
    if (!moveAttempted || commandRefused) {
      // An unclaimed intent (recovery probe, failed claim or failed connect)
      // must be left untouched: reconciliation owns it.
      if (intentClaimed) clearMoveIntent.run(messageId);
      throw error;
    }
    // A transport failure after MOVE was issued is ambiguous. Preserve the
    // intent and start reconciliation instead of claiming either outcome.
    return { accountId: message.account_id, destination: destination.path, refreshPending: true, uncertain: true };
  } finally {
    movingAccounts.delete(message.account_id);
    if (ownedClient?.usable) await ownedClient.logout().catch(() => undefined);
  }
}

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
]);

function moveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return knownLocalMoveErrors.has(message) ? message : friendlyMailError(error);
}

/**
 * Moves every entry of one (account, source mailbox) group with a single
 * provider MOVE command (RFC 6851 message sets). The provider round-trip —
 * the dominant cost of a serial batch — drops from N commands to 1; intent
 * claiming and UIDPLUS reconciliation still run per message, sharing the
 * exact same persistence helpers as single-message moves.
 *
 * Per-message outcomes: moved (UIDPLUS-confirmed or pending reconciliation),
 * blocked (existing intent or a running sync), refused (the provider rejected
 * the whole message set — claimed intents are cleared), or ambiguous
 * (transport failure after the command was issued — intents are preserved for
 * sync's self-healing reconciliation, mirroring the single-move uncertain
 * path).
 */
async function moveMessagesInOneCommand(
  db: DatabaseHandle,
  masterKey: Buffer,
  entries: Array<MoveMessageFields & { id: string }>,
  destination: MoveDestination,
  accessTokenProvider: AccountAccessTokenProvider | undefined,
  agentEvents: AgentMailEventSink | undefined,
  client: Awaited<ReturnType<typeof imapClientForAccount>>,
): Promise<{ updated: number; failures: Array<{ id: string; message: string }>; pendingAccounts: Set<string> }> {
  const outcome = { updated: 0, failures: [] as Array<{ id: string; message: string }>, pendingAccounts: new Set<string>() };
  const accountId = entries[0]?.account_id;
  if (!accountId || entries.length === 0) return outcome;
  const agentLease = agentEvents?.acquireLease(accountId);
  if (running.has(accountId) || movingAccounts.has(accountId)) {
    for (const entry of entries) outcome.failures.push({ id: entry.id, message: PENDING_MOVE_RECONCILIATION_ERROR });
    return outcome;
  }
  movingAccounts.add(accountId);
  const clearMoveIntent = db.prepare(`
    UPDATE messages
    SET pending_move_destination = NULL,
        pending_move_state = NULL,
        pending_move_candidate_uid = NULL,
        pending_move_special_use = NULL
    WHERE id = ? AND pending_move_state = 'intent'
  `);
  const claimed: Array<MoveMessageFields & { id: string }> = [];
  let commandAttempted = false;
  try {
    for (const entry of entries) {
      // A stale 'intent' (an earlier MOVE whose response was lost) may never
      // have reached the provider; probe the source UID on the shared
      // connection before either retrying or leaving reconciliation in charge.
      let moveBlockedError = moveActionBlockedError(entry);
      if (moveBlockedError === PENDING_MOVE_RECONCILIATION_ERROR && isRecoverableStaleMove(entry)) {
        const recovered = await recoverStaleMoveIntent(db, masterKey, entry.id, entry, accessTokenProvider, client);
        if (recovered) moveBlockedError = null;
      }
      if (moveBlockedError) {
        outcome.failures.push({ id: entry.id, message: moveBlockedError });
        continue;
      }
      const intentCandidateUid = cachedDestinationCandidateUid(
        db,
        accountId,
        destination.path,
        entry.remote_id_lookup,
        entry.id,
      );
      // The intent is durable before the provider command; if the process
      // exits after the command is accepted but before the response is
      // persisted, sync can either prove the source still exists or reconcile
      // the exact target.
      const beganIntent = db.prepare(`
        UPDATE messages
        SET pending_move_destination = ?,
            pending_move_state = 'intent',
            pending_move_candidate_uid = ?,
            pending_move_special_use = ?
        WHERE id = ? AND COALESCE(pending_move_destination, '') = ''
      `).run(destination.path, intentCandidateUid, destination.special_use, entry.id);
      if (beganIntent.changes !== 1) {
        outcome.failures.push({ id: entry.id, message: PENDING_MOVE_RECONCILIATION_ERROR });
        continue;
      }
      claimed.push(entry);
    }
    if (claimed.length === 0) return outcome;

    const lock = await client.getMailboxLock(claimed[0]!.mailbox);
    try {
      commandAttempted = true;
      const moved = await client.messageMove(claimed.map((entry) => entry.uid), destination.path, { uid: true });
      if (!moved) {
        // The provider refused the whole message set. Every claimed intent was
        // recorded before the command and never executed, so clear them all.
        for (const entry of claimed) clearMoveIntent.run(entry.id);
        for (const entry of claimed) outcome.failures.push({ id: entry.id, message: "邮件服务器未确认移动操作，请稍后重试。" });
        return outcome;
      }
      for (const entry of claimed) {
        try {
          const destinationUid = moved.uidMap?.get(entry.uid);
          if (typeof destinationUid === "number" && Number.isSafeInteger(destinationUid) && destinationUid > 0) {
            applyMoveConfirmedUidPlus(db, entry.id, entry, destination, destinationUid, agentEvents, agentLease);
          } else {
            const reconciled = applyMovePendingReconciliation(db, entry.id, entry, destination, agentEvents, agentLease);
            if (reconciled.refreshPending) outcome.pendingAccounts.add(accountId);
          }
          outcome.updated += 1;
        } catch (error) {
          outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
        }
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    const claimedIds = new Set(claimed.map((entry) => entry.id));
    if (!commandAttempted) {
      // The command never reached the provider (e.g. the mailbox lock could
      // not be acquired). Mirror the single-move path: clear every claimed
      // intent and report the failure.
      for (const entry of claimed) clearMoveIntent.run(entry.id);
      for (const entry of entries) {
        outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
      }
    } else {
      // A transport failure after the MOVE was issued is ambiguous for every
      // claimed intent: preserve them and let sync's self-healing
      // reconciliation decide. Entries that never claimed an intent failed
      // before the command.
      for (const entry of entries) {
        if (claimedIds.has(entry.id)) {
          outcome.updated += 1;
          outcome.pendingAccounts.add(accountId);
        } else {
          outcome.failures.push({ id: entry.id, message: moveErrorMessage(error) });
        }
      }
    }
  } finally {
    movingAccounts.delete(accountId);
  }
  return outcome;
}

/**
 * Moves many messages with one IMAP connection per account and one MOVE
 * command per (account, source mailbox). Connection setup (not the MOVE
 * command itself) dominated the old serial batch: an 8-message delete needed
 * ~8 connects, and the message set still sent 8 commands. Sharing the client
 * and aggregating UIDs turns that into 1 connect + 1 command. Per-message
 * intent/UIDPLUS semantics are unchanged; failures are reported individually
 * instead of being swallowed.
 */
export async function batchMoveMessages(
  db: DatabaseHandle,
  masterKey: Buffer,
  ids: string[],
  target: MessageMoveTarget,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<BatchMessageMoveOutcome> {
  const outcome: BatchMessageMoveOutcome = {
    updated: 0,
    failed: 0,
    failures: [],
    pendingAccounts: new Set(),
  };
  if (ids.length === 0) return outcome;
  // Resolve every row up front so each group shares one destination lookup
  // and one provider MOVE command.
  const rows = db.prepare(`
    SELECT id, account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state
    FROM messages
    WHERE id IN (${ids.map(() => "?").join(", ")})
  `).all(...ids) as Array<MoveMessageFields & { id: string }>;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, Array<MoveMessageFields & { id: string }>>();
  for (const id of ids) {
    const row = rowsById.get(id);
    if (!row) {
      outcome.failed += 1;
      outcome.failures.push({ id, message: "Message not found." });
      continue;
    }
    const key = `${row.account_id}\u0000${row.mailbox}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const clientsByAccount = new Map<string, Awaited<ReturnType<typeof imapClientForAccount>>>();
  try {
    for (const group of groups.values()) {
      const accountId = group[0]!.account_id;
      try {
        const account = accountById(db, accountId);
        if (!account) {
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: "Account not found." });
          }
          continue;
        }
        const destination = resolveMoveDestination(db, accountId, target);
        if (!destination) {
          const unavailable = moveTargets[target].unavailableMessage;
          for (const entry of group) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: unavailable });
          }
          continue;
        }
        if (destination.path === group[0]!.mailbox) {
          // Idempotent no-op: the whole group already lives in the target
          // folder (e.g. a second delete from the Trash view). Count every
          // entry as moved so the renderer clears them from the view.
          outcome.updated += group.length;
          continue;
        }
        let client = clientsByAccount.get(accountId);
        if (!client || !client.usable) {
          if (client) await client.logout().catch(() => undefined);
          client = await imapClientForAccount(account, masterKey, accessTokenProvider);
          await client.connect();
          clientsByAccount.set(accountId, client);
        }
        // The account-level write slot serializes this group behind any move
        // already in flight on the same account instead of failing the whole
        // group with a busy error.
        const groupOutcome = await withAccountWriteLocks([accountId], () =>
          moveMessagesInOneCommand(db, masterKey, group, destination, accessTokenProvider, agentEvents, client),
        );
        outcome.updated += groupOutcome.updated;
        outcome.failed += groupOutcome.failures.length;
        outcome.failures.push(...groupOutcome.failures);
        for (const pending of groupOutcome.pendingAccounts) outcome.pendingAccounts.add(pending);
      } catch (error) {
        // Fall back to per-message moves so a group-level failure (e.g. a
        // guard error) keeps the previous per-message granularity.
        for (const entry of group) {
          try {
            const result = await moveMessage(db, masterKey, entry.id, target, accessTokenProvider, agentEvents, { client: clientsByAccount.get(accountId) });
            outcome.updated += 1;
            if (result.refreshPending) outcome.pendingAccounts.add(accountId);
          } catch (entryError) {
            outcome.failed += 1;
            outcome.failures.push({ id: entry.id, message: moveErrorMessage(entryError) });
          }
        }
      }
    }
  } finally {
    for (const client of clientsByAccount.values()) {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }
  return outcome;
}
