import { createHash } from "node:crypto";
import type { ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { attachmentMetadataFromParsedMail } from "./attachments.js";
import type { DatabaseHandle } from "./db.js";
import { friendlyMailError, imapClientForAccount, mailErrorCode, type AccountAccessTokenProvider } from "./mail.js";
import {
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

function isSelectableFolder(folder: ListResponse): boolean {
  return folder.listed && !folder.flags.has("\\Noselect");
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
  if (running.has(accountId)) return { synced: 0, folders: 0, failedFolders: 0, newInboxMessages: [] };
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
        id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
        to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body, html_body, flags_json,
        has_attachments, attachments_json, encrypted_payload, payload_version, size, created_at
      ) VALUES (
        @id, @accountId, @mailbox, @uid, @messageId, @subject, @fromName, @fromAddress,
        @toJson, @ccJson, @inReplyTo, @referencesJson, @sentAt, @snippet, @textBody, @htmlBody, @flagsJson,
        @hasAttachments, @attachmentsJson, @encryptedPayload, @payloadVersion, @size, @createdAt
      )
      ON CONFLICT(account_id, mailbox, uid) DO UPDATE SET
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
    const updateFlags = db.prepare("UPDATE messages SET flags_json = ? WHERE account_id = ? AND mailbox = ? AND uid = ?");
    const deleteFolderMessages = db.prepare("DELETE FROM messages WHERE account_id = ? AND mailbox = ?");
    const updateFolderUidValidity = db.prepare("UPDATE folders SET uid_validity = ? WHERE account_id = ? AND path = ?");
    let synced = 0;
    let failedFolders = 0;
    let firstFolderError: unknown;
    const newInboxMessages: NewInboxMessage[] = [];

    for (const folder of folders) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
      try {
        lock = await client.getMailboxLock(folder.path);
        const mailbox = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox : undefined;
        const currentUidValidity = uidValidityValue(mailbox?.uidValidity);
        const previousUidValidity = previousFolderUidValidities.get(folder.path);
        if (currentUidValidity !== undefined) {
          if (previousUidValidity !== undefined && previousUidValidity !== currentUidValidity) {
            // UID reuse after a server rebuild can otherwise leave a different
            // message paired with an old cached body or attachment list.
            db.transaction(() => {
              deleteFolderMessages.run(accountId, folder.path);
              updateFolderUidValidity.run(currentUidValidity, accountId, folder.path);
            })();
          } else {
            updateFolderUidValidity.run(currentUidValidity, accountId, folder.path);
          }
        }
        const exists = mailbox?.exists ?? 0;
        if (exists <= 0) continue;
        const start = Math.max(1, exists - messageLimit + 1);
        const newUids: number[] = [];
        const attachmentMetadataRefreshUids: number[] = [];

        for await (const message of client.fetch(`${start}:*`, { uid: true, flags: true })) {
          if (!message.uid) continue;
          const flagsJson = JSON.stringify([...(message.flags ?? [])]);
          const existing = findMessage.get(accountId, folder.path, message.uid) as MessageStorageRow | undefined;
          if (existing) {
            updateFlags.run(flagsJson, accountId, folder.path, message.uid);
            // Rows cached before attachment metadata was introduced are hydrated
            // once when they reappear in the normal sync window.
            const payload = messagePayloadForRow(existing, masterKey);
            if (payload.attachments === null || payload.cc === null || payload.references === null) {
              attachmentMetadataRefreshUids.push(message.uid);
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
          { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: true },
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
          const id = messageKey(accountId, folder.path, message.uid);
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
    .prepare("SELECT account_id, mailbox, uid, flags_json FROM messages WHERE id = ?")
    .get(messageId) as { account_id: string; mailbox: string; uid: number; flags_json: string } | undefined;
  if (!message) throw new Error("Message not found.");
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

export async function moveMessage(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  target: MessageMoveTarget,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<{ destination: string }> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid FROM messages WHERE id = ?")
    .get(messageId) as { account_id: string; mailbox: string; uid: number } | undefined;
  if (!message) throw new Error("Message not found.");
  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");

  const targetDefinition = moveTargets[target];
  const placeholders = targetDefinition.specialUses.map(() => "?").join(", ");
  const destination = db.prepare(`
    SELECT path FROM folders
    WHERE account_id = ? AND special_use IN (${placeholders})
    ORDER BY CASE special_use
      WHEN '\\Archive' THEN 0
      WHEN '\\Trash' THEN 0
      ELSE 1
    END
    LIMIT 1
  `).get(message.account_id, ...targetDefinition.specialUses) as { path: string } | undefined;
  if (!destination || destination.path === message.mailbox) throw new Error(targetDefinition.unavailableMessage);

  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      const moved = await client.messageMove(message.uid, destination.path, { uid: true });
      if (!moved) throw new Error("邮件服务器未确认移动操作，请稍后重试。");
    } finally {
      lock.release();
    }
    // UID values can change after a MOVE. Drop the stale cache row and let the
    // next sync import the message from its destination mailbox with its new UID.
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    return { destination: destination.path };
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}
