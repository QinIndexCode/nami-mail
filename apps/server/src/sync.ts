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
  protectedMessageColumns,
  type MessageStorageRow,
} from "./message-storage.js";
import { autoCollectSender } from "./contacts.js";
import { indexMessageFts } from "./message-search.js";
import { redactUrls } from "./message-links.js";
import {
  confirmSubmissionsInSent,
} from "./outbox.js";
import type { AccountRecord } from "./types.js";
import { getAppSettings } from "./settings.js";
import { getAutoReplyEngine } from "./agent/auto-reply.js";

const running = new Set<string>();
const movingAccounts = new Set<string>();

/** True when the account is mid-sync. Used by move operations to block concurrent intents. */
export function isAccountSyncing(accountId: string): boolean {
  return running.has(accountId);
}

/** True when a move operation is in flight for the account. */
export function isAccountMoving(accountId: string): boolean {
  return movingAccounts.has(accountId);
}

/** Mark an account as mid-move. Call from sync-moves.ts only. */
export function markAccountMoving(accountId: string): void {
  movingAccounts.add(accountId);
}

/** Clear the mid-move flag for an account. Call from sync-moves.ts only. */
export function unmarkAccountMoving(accountId: string): void {
  movingAccounts.delete(accountId);
}

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

export function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
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

const SNIPPET_MAX_LENGTH = 150;

const htmlEntityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(x[0-9a-fA-F]+|\d+)|([a-zA-Z]+));/g, (whole, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const codePoint = numeric.startsWith("x") || numeric.startsWith("X")
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try { return String.fromCodePoint(codePoint); } catch { return whole; }
    }
    return name && htmlEntityMap[name.toLowerCase()] !== undefined ? htmlEntityMap[name.toLowerCase()]! : whole;
  });
}

function htmlToSnippetText(html: string): string {
  let text = html;
  // Strip non-visible blocks first so their content doesn't leak into the snippet.
  text = text.replace(/<(script|style|head|noscript|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  // Strip all remaining HTML tags.
  text = text.replace(/<[^>]+>/g, " ");
  // Decode HTML entities and collapse whitespace.
  text = decodeHtmlEntities(text).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return text;
}

function snippet(value: string): string {
  // Redact URLs up front so raw links never land in the stored snippet; the
  // neutral sentinel is rendered as a localized label by the consumer.
  const compact = redactUrls(value.replace(/\s+/g, " ").trim());
  return compact.length <= SNIPPET_MAX_LENGTH ? compact : `${compact.slice(0, SNIPPET_MAX_LENGTH).trimEnd()}…`;
}

const SNIPPET_REDACT_MIGRATION_ID = "message-snippet-redact-v1";

/**
 * One-time backfill: re-run URL redaction over snippets already stored by older
 * builds (written before + link filtering existed). Redaction is applied to the
 * stored, already-truncated snippet directly -- it needs no decryption (bodies
 * are encrypted, snippets are not) and is strictly an improvement. Guarded by a
 * data-migration marker so it runs at most once per database.
 */
export function backfillRedactMessageSnippets(db: DatabaseHandle): { changed: number } {
  const marker = db
    .prepare("SELECT 1 FROM data_migrations WHERE id = ?")
    .get(SNIPPET_REDACT_MIGRATION_ID);
  if (marker) return { changed: 0 };
  const rows = db
    .prepare("SELECT id, snippet FROM messages WHERE snippet <> ''")
    .all() as Array<{ id: string; snippet: string }>;
  const update = db.prepare("UPDATE messages SET snippet = ? WHERE id = ?");
  const changed = db.transaction(() => {
    let count = 0;
    for (const row of rows) {
      const redacted = redactUrls(row.snippet);
      if (redacted !== row.snippet) {
        update.run(redacted, row.id);
        count += 1;
      }
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(SNIPPET_REDACT_MIGRATION_ID, new Date().toISOString());
    return count;
  })();
  return { changed };
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

// Sent verification is in sync-sent-verify.ts; re-export for backward compatibility.
import { scheduleSentSubmissionVerification } from "./sync-sent-verify.js";
export { scheduleSentSubmissionVerification, verifySubmissionInSentMailbox } from "./sync-sent-verify.js";

export async function syncAccount(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  messageLimit: number,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
  signal?: AbortSignal,
): Promise<{ synced: number; folders: number; failedFolders: number; limitReached: boolean; newInboxMessages: NewInboxMessage[] }> {
  if (running.has(accountId) || movingAccounts.has(accountId)) {
    return { synced: 0, folders: 0, failedFolders: 0, limitReached: false, newInboxMessages: [] };
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
        cc_json = excluded.to_json,
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
    // Any folder whose remote size exceeds the effective per-folder cap skips
    // older mail; the pass stays healthy, but the UI should tell the user.
    let limitReached = false;
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
        // `exists` is the remote size; a positive cap means only the newest
        // `messageLimit` messages were fetched, so older mail was skipped.
        if (messageLimit > 0 && exists > messageLimit) limitReached = true;
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
        // A limit of 0 syncs the whole mailbox; any
        // positive value fetches only the newest `messageLimit` messages.
        const start = messageLimit > 0 ? Math.max(1, exists - messageLimit + 1) : 1;
        // The rolling window must be anchored in UID space: sequence numbers
        // renumber whenever the remote mailbox changes between the SELECT
        // above and this FETCH, which silently shifts a sequence-based window
        // and defeats the messageLimit cap. Probe the newest UID once (one
        // tiny round-trip) and fetch the trailing window by UID like every
        // other fetch site in this file.
        let latestUid = 0;
        for await (const probe of client.fetch("*", { uid: true }, { uid: true })) {
          if (typeof probe.uid === "number" && probe.uid > 0) {
            latestUid = probe.uid;
            break;
          }
        }
        // exists > 0 guarantees at least one message, so the probe normally
        // resolves. Falling back to the sequence-based floor keeps a
        // pathological server from starving this sync entirely.
        const windowFloor = latestUid > 0
          ? `${messageLimit > 0 ? Math.max(1, latestUid - messageLimit + 1) : 1}:*`
          : `${start}:*`;
        const newUids: number[] = [];
        const attachmentMetadataRefreshUids: number[] = [];
        const hydratedMessageIds = new Map<number, string>();

        for await (const message of client.fetch(windowFloor, {
          uid: true,
          flags: true,
          labels: isAllMailFolder(folder) || autoReplyActive,
        }, { uid: true })) {
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
            snippet: snippet(text || htmlToSnippetText(html)),
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
              to: recipients,
              cc: copiedRecipients,
              textBody: text,
              attachments,
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
                  ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
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
    const syncWarningCode = limitReached ? "sync_limit" : null;
    if (failedFolders > 0) {
      // A partial pass has fresh data, but it is not a healthy account state:
      // retain a safe, actionable diagnostic until every folder succeeds.
      db.prepare(`
        UPDATE accounts SET status = 'degraded', last_error = ?, last_error_code = 'partial_sync', last_sync_warning_code = ?, last_synced_at = ? WHERE id = ?
      `).run(partialSyncMessage(failedFolders), syncWarningCode, syncedAt, accountId);
    } else {
      db.prepare(`
        UPDATE accounts SET status = 'connected', last_error = NULL, last_error_code = NULL, last_sync_warning_code = ?, last_synced_at = ? WHERE id = ?
      `).run(syncWarningCode, syncedAt, accountId);
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
    return { synced, folders: folders.length, failedFolders, limitReached, newInboxMessages };
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

// Filter-rule application is in sync-filter-rules.ts; re-export for backward compatibility.
import { applyFilterRulesToNewMessages } from "./sync-filter-rules.js";
export { applyFilterRulesToNewMessages } from "./sync-filter-rules.js";

// Flag operations are in sync-flags.ts; re-export for backward compatibility.
import { updateMessageFlags, updateMessageFlagsBatch, markMessageSeen, type MessageFlagsPatch } from "./sync-flags.js";
export { MessageFlagsPatch, updateMessageFlags, updateMessageFlagsBatch, markMessageSeen } from "./sync-flags.js";

// Move operations are in sync-moves.ts; re-export for backward compatibility.
export {
  type BatchMessageMoveOutcome,
  type MessageMoveResult,
  type MessageMoveTarget,
  batchMoveMessages,
  moveMessage,
  moveMessageToFolder,
  resolveMoveDestination,
} from "./sync-moves.js";
