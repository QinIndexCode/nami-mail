import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { moveActionBlockedError, type MessageStorageRow } from "./message-storage.js";
import type { AccountRecord } from "./types.js";

// Full-mailbox backup: streams every stored message's canonical RFC822
// source into a zip of .eml files. Sources are never cached locally (the
// per-message EML export fetches on demand), so the backup behaves the same
// way: one IMAP connection per (account, mailbox) group, opened once and
// reused for every message in that folder.

export type BackupMessageEntry = {
  /** Archive path inside the zip, e.g. "emails/0001_quarterly-report.eml". */
  path: string;
  /** The provider's original RFC822 source. */
  source: Buffer;
};

export type BackupFailure = {
  messageId: string;
  reason: string;
};

export type MailBackupReport = {
  generatedAt: string;
  accountCount: number;
  messageCount: number;
  exported: number;
  failed: BackupFailure[];
};

/** Mangles a subject into a safe archive entry name (no separators or control chars). */
export function backupEntryName(subject: string, index: number): string {
  const cleaned = subject
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `emails/${String(index).padStart(4, "0")}_${cleaned || "message"}.eml`;
}

/** Groups stored messages by (account, mailbox) so each folder opens one connection. */
function groupByMailbox(db: DatabaseHandle, rows: readonly MessageStorageRow[]): Map<string, { account: AccountRecord; mailbox: string; messages: MessageStorageRow[] }> {
  const groups = new Map<string, { account: AccountRecord; mailbox: string; messages: MessageStorageRow[] }>();
  for (const row of rows) {
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(row.account_id) as AccountRecord | undefined;
    if (!account) continue;
    const key = `${row.account_id}\u0000${row.mailbox}`;
    let group = groups.get(key);
    if (!group) {
      group = { account, mailbox: row.mailbox, messages: [] };
      groups.set(key, group);
    }
    group.messages.push(row);
  }
  return groups;
}

/**
 * Runs the backup and emits one entry per successfully fetched message.
 * Failures are collected in the report instead of aborting the whole run, so
 * a single gone-from-provider message never blocks the rest of the mailbox.
 */
export async function collectMailBackup(
  db: DatabaseHandle,
  masterKey: Buffer,
  options: {
    accessTokenProvider?: AccountAccessTokenProvider;
    emit?: (entry: BackupMessageEntry) => void;
  } = {},
): Promise<MailBackupReport> {
  const rows = db.prepare(`
    SELECT * FROM messages
    ORDER BY account_id, mailbox, COALESCE(sent_at, created_at) ASC
  `).all() as MessageStorageRow[];

  const report: MailBackupReport = {
    generatedAt: new Date().toISOString(),
    accountCount: new Set(rows.map((row) => row.account_id)).size,
    messageCount: rows.length,
    exported: 0,
    failed: [],
  };

  let index = 0;
  for (const group of groupByMailbox(db, rows).values()) {
    const client = await imapClientForAccount(group.account, masterKey, options.accessTokenProvider);
    let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
    let connected = false;
    try {
      await client.connect();
      connected = true;
      lock = await client.getMailboxLock(group.mailbox);
      for (const message of group.messages) {
        index += 1;
        const blocked = moveActionBlockedError(message);
        if (blocked) {
          report.failed.push({ messageId: message.id, reason: blocked });
          continue;
        }
        try {
          const remote = await client.fetchOne(message.uid, { uid: true, source: true }, { uid: true });
          if (!remote || remote.uid !== message.uid || !Buffer.isBuffer(remote.source)) {
            throw new Error("Message is no longer available in this mailbox. Sync this message again.");
          }
          options.emit?.({
            path: backupEntryName(typeof message.subject === "string" ? message.subject : "", index),
            source: remote.source,
          });
          report.exported += 1;
        } catch (error) {
          report.failed.push({ messageId: message.id, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      // A folder that cannot be connected blocks every message in it, but the
      // remaining folders still get their chance.
      for (const message of group.messages) {
        index += 1;
        report.failed.push({ messageId: message.id, reason: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      try {
        lock?.release();
      } catch {
        // Cleanup errors must not replace the transfer outcome.
      }
      if (connected && client.usable) void client.logout().catch(() => undefined);
    }
  }

  return report;
}
