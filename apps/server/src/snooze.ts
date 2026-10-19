import type { DatabaseHandle } from "./db.js";
import { messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";
import type { NewInboxMessage } from "./sync.js";

export function snoozedUntilValue(db: DatabaseHandle, messageId: string): string | null {
  const row = db.prepare("SELECT snoozed_until FROM messages WHERE id = ?").get(messageId) as
    | { snoozed_until: string | null }
    | undefined;
  return row ? row.snoozed_until : null;
}

/**
 * The writes that set or clear a snooze live in `tasks/kinds/snooze.ts` now.
 * They commit `messages.snoozed_until` and the task that releases it in one
 * transaction, so a caller that wrote the column here could hide a message with
 * nothing left to bring it back. What remains in this module is the read side,
 * plus the reconciliation pass below.
 */

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
 *
 * The scheduler's `snooze` runner is the normal path now, and it clears the
 * column at the instant the acceptance stored. This pass remains the
 * reconciliation half: rows written by a build that had no task behind them (or
 * whose task was lost) would otherwise stay hidden forever. It is deliberately
 * unconditional -- clearing a row the runner already cleared is a no-op -- so the
 * two writers cannot disagree.
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
