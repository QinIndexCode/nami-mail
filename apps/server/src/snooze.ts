import type { DatabaseHandle } from "./db.js";
import { messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";
import type { NewInboxMessage } from "./sync.js";

export function snoozedUntilValue(db: DatabaseHandle, messageId: string): string | null {
  const row = db.prepare("SELECT snoozed_until FROM messages WHERE id = ?").get(messageId) as
    | { snoozed_until: string | null }
    | undefined;
  return row ? row.snoozed_until : null;
}

/** Marks a message as snoozed until the given ISO time. */
export function setMessageSnoozed(db: DatabaseHandle, messageId: string, untilIso: string): void {
  const result = db.prepare("UPDATE messages SET snoozed_until = ? WHERE id = ?").run(untilIso, messageId);
  if (result.changes !== 1) throw new Error("邮件不存在。");
}

/** Cancels the snooze so the message is visible again immediately. */
export function clearMessageSnooze(db: DatabaseHandle, messageId: string): void {
  const result = db.prepare("UPDATE messages SET snoozed_until = NULL WHERE id = ?").run(messageId);
  if (result.changes !== 1) throw new Error("邮件不存在。");
}

/** Rows for the "Snoozed" view: messages whose snooze has not fired yet. */
export function listSnoozedMessages(db: DatabaseHandle, nowIso = new Date().toISOString()): MessageStorageRow[] {
  return db.prepare(`
    SELECT m.*, a.email AS account_email, a.provider_name
    FROM messages m
    JOIN accounts a ON a.id = m.account_id
    WHERE m.snoozed_until IS NOT NULL AND m.snoozed_until > ?
    ORDER BY m.snoozed_until ASC
  `).all(nowIso) as MessageStorageRow[];
}

/**
 * Releases snoozed messages whose time has arrived, returning them for the
 * new-mail notification pipeline so the Inbox re-displays them and alerts.
 */
export function releaseDueSnoozedMessages(
  db: DatabaseHandle,
  masterKey: Buffer,
  nowIso = new Date().toISOString(),
): NewInboxMessage[] {
  const due = db.prepare(`
    SELECT * FROM messages
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
  `).all(nowIso) as MessageStorageRow[];
  if (!due.length) return [];
  db.prepare(`
    UPDATE messages SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
  `).run(nowIso);
  return due.map((row) => {
    const payload = messagePayloadForRow(row, masterKey);
    return {
      id: row.id,
      accountId: row.account_id,
      subject: payload.subject,
      fromName: payload.fromName,
      fromAddress: payload.fromAddress,
    };
  });
}
