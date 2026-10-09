import type { DatabaseHandle } from "./db.js";
import { markSubmissionFailed } from "./outbox.js";
import { toUtcIsoTimestamp } from "./utc-time.js";

const SCHEDULED_TIME_UTC_MIGRATION_ID = "utc-normalize-scheduled-times-v1";

/**
 * R05: one-shot rewrite of legacy scheduled times stored in offset (or
 * otherwise non-Z) form, so the string-compared due queries and the snoozed
 * view see the same ordering every other build sees. NULLs stay NULL.
 *
 * An unparseable send_at can never fire correctly — the task is marked
 * failed now with a diagnosable code instead of pending forever. An
 * unparseable snooze must not hold the message out of the inbox forever —
 * the marker is cleared and the message returns. The migration touches only
 * plaintext columns; the AAD-bound request/details envelopes (AAD-bound to
 * account and task id) are untouched and remain readable, which the
 * utc-time migration test asserts.
 *
 * Mount point: app.ts build, right after migrateOutboundSubmissionStorage
 * (same phase: startup data migrations with the master key available).
 */
export function normalizeScheduledTimesMigration(
  db: DatabaseHandle,
  masterKey: Buffer,
): { sendAts: number; snoozed: number; invalid: number } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(SCHEDULED_TIME_UTC_MIGRATION_ID);
  if (marker) return { sendAts: 0, snoozed: 0, invalid: 0 };
  let sendAts = 0;
  let snoozed = 0;
  let invalid = 0;
  db.transaction(() => {
    const submissions = db.prepare(`
      SELECT id, send_at FROM outbound_submissions
      WHERE send_at IS NOT NULL AND send_at NOT LIKE '%Z'
    `).all() as Array<{ id: string; send_at: string }>;
    for (const row of submissions) {
      const normalized = toUtcIsoTimestamp(row.send_at);
      if (normalized) {
        db.prepare("UPDATE outbound_submissions SET send_at = ? WHERE id = ?").run(normalized, row.id);
        sendAts += 1;
      } else {
        const pending = db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ? AND status = 'pending'").get(row.id);
        if (pending) markSubmissionFailed(db, masterKey, row.id, "invalid_scheduled_time", "定时发送时间无法解析，任务已停止。");
        invalid += 1;
      }
    }
    const snoozedRows = db.prepare(`
      SELECT id, snoozed_until FROM messages
      WHERE snoozed_until IS NOT NULL AND snoozed_until NOT LIKE '%Z'
    `).all() as Array<{ id: string; snoozed_until: string }>;
    for (const row of snoozedRows) {
      const normalized = toUtcIsoTimestamp(row.snoozed_until);
      // An unparseable marker releases the message; a parseable one is
      // rewritten to the same instant in Z form.
      db.prepare("UPDATE messages SET snoozed_until = ? WHERE id = ?").run(normalized, row.id);
      if (normalized) snoozed += 1;
      else invalid += 1;
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(SCHEDULED_TIME_UTC_MIGRATION_ID, new Date().toISOString());
  })();
  return { sendAts, snoozed, invalid };
}
