import { createHash, createHmac } from "node:crypto";
import type { ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { attachmentMetadataFromParsedMail } from "./attachments.js";
import type { DatabaseHandle } from "./db.js";
import { deriveEncryptionKey } from "./crypto.js";
import { friendlyMailError, imapClientForAccount, mailErrorCode, type AccountAccessTokenProvider } from "./mail.js";
import {
  PENDING_MOVE_RECONCILIATION_ERROR,
  moveActionBlockedError,
  messagePayloadForRow,
  protectedMessageColumns,
  type MessageStorageRow,
} from "./message-storage.js";
import {
  confirmSubmissionsInSent,
  markSubmissionConfirmed,
  submissionForId,
} from "./outbox.js";
import type { AccountRecord } from "./types.js";

const running = new Set<string>();
const movingAccounts = new Set<string>();
const scheduledSentVerifications = new Map<string, Promise<void>>();
const sentVerificationRetryDelaysMs = [0, 2_000, 10_000] as const;

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

function messageKey(accountId: string, mailbox: string, uid: number): string {
  return createHash("sha256").update(`${accountId}\0${mailbox}\0${uid}`).digest("hex").slice(0, 32);
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
): Promise<{ synced: number; folders: number; failedFolders: number; newInboxMessages: NewInboxMessage[] }> {
  if (running.has(accountId) || movingAccounts.has(accountId)) {
    return { synced: 0, folders: 0, failedFolders: 0, newInboxMessages: [] };
  }
  const account = accountById(db, accountId);
  if (!account) throw new Error("Account not found.");
  running.add(accountId);
  let client: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;

  try {
    client = await imapClientForAccount(account, masterKey, accessTokenProvider);
    await client.connect();
    const folders = (await client.list())
      .filter(isSelectableFolder)
      .sort((a, b) => folderPriority(a) - folderPriority(b) || a.name.localeCompare(b.name));
    const previousFolderUidValidities = new Map(
      (db.prepare("SELECT path, uid_validity FROM folders WHERE account_id = ?").all(accountId) as Array<{
        path: string;
        uid_validity: string | null;
      }>).map((folder) => [folder.path, folder.uid_validity]),
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
      folderRows.push({
        path: folder.path,
        name: folder.name || folder.path,
        specialUse: folder.specialUse ?? null,
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
        // Do not accept a status-only UIDVALIDITY observation. It must be
        // confirmed by the successful mailbox SELECT below before old cache
        // rows can be considered part of the same UID epoch.
        uidValidity: previousFolderUidValidities.get(folder.path) ?? null,
      });
    }

    db.transaction(() => {
      db.prepare("DELETE FROM folders WHERE account_id = ?").run(accountId);
      for (const folder of folderRows) upsertFolder.run({ accountId, ...folder });
    })();

    const upsert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, all_mail_archived, message_id, subject, from_name, from_address,
        to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body, html_body, flags_json,
        has_attachments, attachments_json, encrypted_payload, payload_version, size, created_at
      ) VALUES (
        @id, @accountId, @mailbox, @uid, @remoteIdLookup, @allMailArchived, @messageId, @subject, @fromName, @fromAddress,
        @toJson, @ccJson, @inReplyTo, @referencesJson, @sentAt, @snippet, @textBody, @htmlBody, @flagsJson,
        @hasAttachments, @attachmentsJson, @encryptedPayload, @payloadVersion, @size, @createdAt
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
    const detachPendingMoveIntentFromResetMailbox = db.prepare(`
      UPDATE messages SET uid = ?
      WHERE id = ? AND pending_move_state = 'intent'
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
        deleteDestinationCopies.run(accountId, folder.path, remoteLookup, pending.id);
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
      })();
      return "reconciled";
    };

    for (const folder of folders) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
      try {
        lock = await client.getMailboxLock(folder.path);
        const mailbox = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox : undefined;
        const currentUidValidity = uidValidityValue(mailbox?.uidValidity);
        const previousUidValidity = previousFolderUidValidities.get(folder.path);
        const intentRows = pendingMoveIntents.all(accountId, folder.path) as Array<{
          id: string;
          uid: number;
          remote_id_lookup?: string | null;
        }>;
        const intentByUid = new Map(intentRows.map((row) => [row.uid, row]));
        const sourceUidMembershipProven = currentUidValidity !== undefined
          && typeof previousUidValidity === "string"
          && previousUidValidity === currentUidValidity;
        const intentUids = [...new Set(intentRows.flatMap((row) =>
          Number.isSafeInteger(row.uid) && row.uid > 0 ? [row.uid] : []
        ))];
        if (intentUids.length) {
          const inspectedSourceUids = new Set<number>();
          for await (const source of client.fetch(intentUids, { uid: true }, { uid: true })) {
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
              const pendingIntents = pendingMoveIntents.all(accountId, folder.path) as Array<{ id: string; uid: number }>;
              for (const pendingIntent of pendingIntents) {
                // The old UID epoch no longer proves source membership. Retain
                // the intent under a local placeholder so a new server UID
                // cannot overwrite its encrypted cache row.
                const localPendingUid = pendingMoveUid(db, accountId, folder.path, pendingIntent.uid);
                detachPendingMoveIntentFromResetMailbox.run(localPendingUid, pendingIntent.id);
              }
              deleteFolderMessages.run(accountId, folder.path);
              updateFolderUidValidity.run(currentUidValidity, accountId, folder.path);
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
        if (exists <= 0) continue;
        const start = Math.max(1, exists - messageLimit + 1);
        const newUids: number[] = [];
        const attachmentMetadataRefreshUids: number[] = [];
        const hydratedMessageIds = new Map<number, string>();

        for await (const message of client.fetch(`${start}:*`, {
          uid: true,
          flags: true,
          labels: isAllMailFolder(folder),
        })) {
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
            updateCachedMessage.run(
              flagsJson,
              remoteLookup,
              allMailArchived,
              accountId,
              folder.path,
              message.uid,
            );
            // Rows cached before attachment metadata was introduced are hydrated
            // once when they reappear in the normal sync window.
            const payload = messagePayloadForRow(existing, masterKey);
            if (payload.attachments === null || payload.cc === null || payload.references === null) {
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
        if (!uidsToFetch.length) continue;
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
            labels: isAllMailFolder(folder),
          },
          { uid: true },
        )) {
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
          });
          upsert.run({
            id,
            accountId,
            mailbox: folder.path,
            uid: message.uid,
            remoteIdLookup: remoteIdLookup(masterKey, accountId, message.emailId),
            allMailArchived: allMailArchivedValue(folder, message.labels),
            ...protectedColumns,
            sentAt: sentAt.toISOString(),
            flagsJson: JSON.stringify(flags),
            hasAttachments: parsed?.attachments?.length ? 1 : 0,
            size: message.size ?? message.source?.length ?? 0,
            createdAt: new Date().toISOString(),
          });
          synced += 1;
          if (newUidSet.has(message.uid) && (folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX") && !flags.includes("\\Seen")) {
            newInboxMessages.push({ id, accountId, subject, fromName: from.name, fromAddress: from.address });
          }
        }
      } catch (error) {
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
    confirmSubmissionsInSent(db, masterKey, accountId);
    return { synced, folders: folders.length, failedFolders, newInboxMessages };
  } catch (error) {
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
  }
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
    })();
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

export async function markMessageSeen(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  seen: boolean,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<void> {
  await updateMessageFlags(db, masterKey, messageId, { seen }, accessTokenProvider);
}

export type MessageMoveTarget = "archive" | "trash";

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
  // Inbox label. Physical archive and trash folders gain a new membership.
  if (!destinationAlreadyCached && (destination.special_use === "\\Archive" || destination.special_use === "\\Trash")) {
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

export async function moveMessage(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  target: MessageMoveTarget,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<{ accountId: string; destination: string; refreshPending: boolean; uid?: number; uncertain?: boolean; locationUnverified?: boolean }> {
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
  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");
  if (running.has(message.account_id) || movingAccounts.has(message.account_id)) {
    throw new Error(PENDING_MOVE_RECONCILIATION_ERROR);
  }

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
  `).get(message.account_id, ...targetDefinition.specialUses) as { path: string; special_use: string | null } | undefined;
  if (!destination || destination.path === message.mailbox) throw new Error(targetDefinition.unavailableMessage);

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

  const clearMoveIntent = db.prepare(`
    UPDATE messages
    SET pending_move_destination = NULL,
        pending_move_state = NULL,
        pending_move_candidate_uid = NULL,
        pending_move_special_use = NULL
    WHERE id = ? AND pending_move_state = 'intent'
  `);
  let client: Awaited<ReturnType<typeof imapClientForAccount>> | undefined;
  let moveAttempted = false;
  let moveSettled = false;
  let commandRefused = false;
  movingAccounts.add(message.account_id);
  try {
    client = await imapClientForAccount(account, masterKey, accessTokenProvider);
    await client.connect();
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
        db.transaction(() => {
          // Gmail can already have a cached \All copy. UIDPLUS proves this is
          // the same server message, so preserve the current UI-facing id.
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
        })();
        moveSettled = true;
        return { accountId: message.account_id, destination: destination.path, refreshPending: false, uid: destinationUid };
      }
    } finally {
      lock.release();
    }
    // Servers without UIDPLUS do not identify the destination UID. Keep the
    // encrypted source row durable and expose its effective destination until
    // a later sync can reconcile the exact opaque remote identifier.
    db.transaction(() => {
      const candidateUid = cachedDestinationCandidateUid(
        db,
        message.account_id,
        destination.path,
        message.remote_id_lookup,
        messageId,
      );
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
    })();
    moveSettled = true;
    // Without a stable server identifier, the confirmed move is still real,
    // but the local cache cannot safely bind its preserved payload to a target
    // UID. Keep it readable at the confirmed destination and block operations
    // that would otherwise address the old, local-only UID.
    return {
      accountId: message.account_id,
      destination: destination.path,
      refreshPending: message.remote_id_lookup !== null,
      ...(message.remote_id_lookup === null ? { locationUnverified: true } : {}),
    };
  } catch (error) {
    if (moveSettled) throw error;
    if (!moveAttempted || commandRefused) {
      clearMoveIntent.run(messageId);
      throw error;
    }
    // A transport failure after MOVE was issued is ambiguous. Preserve the
    // intent and start reconciliation instead of claiming either outcome.
    return { accountId: message.account_id, destination: destination.path, refreshPending: true, uncertain: true };
  } finally {
    movingAccounts.delete(message.account_id);
    if (client?.usable) await client.logout().catch(() => undefined);
  }
}
