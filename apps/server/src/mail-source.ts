import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import type { AccountRecord } from "./types.js";
import { moveActionBlockedError, messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";

function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}

export type MessageSourceDownload = {
  /** The provider's original RFC822 source for the message. */
  source: Buffer;
  /** The stored subject, used to build a human-readable export filename. */
  subject: string;
};

/**
 * Downloads the provider's original message source for an EML export. The
 * attachment download path fetches part data on demand, and this works the
 * same way: nothing is cached locally, so a message that is gone from the
 * provider reports the same "no longer available" failure as attachments.
 */
export async function downloadMessageSource(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<MessageSourceDownload> {
  const message = db.prepare(`
    SELECT * FROM messages WHERE id = ?
  `).get(messageId) as MessageStorageRow | undefined;
  if (!message) throw new Error("Message not found.");
  const moveBlockedError = moveActionBlockedError(message);
  if (moveBlockedError) throw new Error(moveBlockedError);

  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");

  const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
  try {
    await client.connect();
    lock = await client.getMailboxLock(message.mailbox);
    const remoteMessage = await client.fetchOne(message.uid, { uid: true, source: true }, { uid: true });
    if (!remoteMessage || remoteMessage.uid !== message.uid || !Buffer.isBuffer(remoteMessage.source)) {
      throw new Error("Message is no longer available in this mailbox. Sync this message again.");
    }
    return { source: remoteMessage.source, subject: messagePayloadForRow(message, masterKey).subject };
  } finally {
    try {
      lock?.release();
    } catch {
      // Preserve the connection or IMAP error that caused the export to fail.
    }
    void client.logout().catch(() => undefined);
  }
}