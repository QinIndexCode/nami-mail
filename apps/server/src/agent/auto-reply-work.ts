import type { DatabaseHandle } from "../db.js";
import { serverLog } from "../logging.js";

const enqueueSql = `INSERT OR IGNORE INTO auto_reply_queue(message_id,account_id,created_at)
  SELECT id,account_id,? FROM messages WHERE id=? AND account_id=?
  AND NOT EXISTS(SELECT 1 FROM auto_reply_processed WHERE message_id=messages.id)`;

/** Called inside the sync write transaction, before a crash can lose the new-mail notification. */
export function enqueueAutoReplyMessage(db: DatabaseHandle, accountId: string, messageId: string, now: string): void {
  db.prepare(enqueueSql).run(now, messageId, accountId);
}

/** A bounded turn is a scheduling budget, never a limit on accepted messages. */
export class AutoReplyWorkQueue {
  private readonly active = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly db: DatabaseHandle, private readonly enabled: (accountId: string) => boolean,
    private readonly process: (accountId: string, messageId: string) => Promise<void>, private readonly clock: () => string) {}

  async enqueue(accountId: string, ids: readonly string[]): Promise<void> {
    if (this.closed || !this.enabled(accountId)) return;
    const insert = this.db.prepare(enqueueSql);
    this.db.transaction(() => { for (const id of new Set(ids)) insert.run(this.clock(), id, accountId); })();
    await this.drain(accountId);
  }

  async resume(): Promise<void> {
    if (this.closed) return;
    const rows = this.db.prepare("SELECT DISTINCT account_id FROM auto_reply_queue").all() as Array<{ account_id: string }>;
    await Promise.all(rows.filter((row) => this.enabled(row.account_id)).map((row) => this.drain(row.account_id)));
  }

  close(): void { this.closed = true; }

  private drain(accountId: string): Promise<void> {
    const existing = this.active.get(accountId);
    if (existing) return existing;
    // Enter on the next microtask so the active slot exists before any callback can reenter.
    const run = Promise.resolve().then(async () => {
      while (!this.closed && this.enabled(accountId)) {
        const rows = this.db.prepare("SELECT message_id FROM auto_reply_queue WHERE account_id=? ORDER BY created_at,rowid LIMIT 40").all(accountId) as Array<{ message_id: string }>;
        if (!rows.length) break;
        for (const row of rows) {
          if (this.closed || !this.enabled(accountId)) return;
          if (!this.db.prepare("SELECT 1 FROM auto_reply_processed WHERE message_id=?").get(row.message_id)) await this.process(accountId, row.message_id);
          if (this.closed) return;
          this.db.prepare("DELETE FROM auto_reply_queue WHERE message_id=?").run(row.message_id);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }).catch((error: unknown) => {
      serverLog.warn({ accountId }, "Auto-reply work remains queued after a processing failure", error);
    }).finally(() => this.active.delete(accountId));
    this.active.set(accountId, run);
    return run;
  }
}
