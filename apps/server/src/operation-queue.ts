import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db.js";
import { withAccountWriteLocks } from "./sync.js";

/**
 * Durable queue for user-initiated message write operations (moves, flag
 * updates). Each operation is recorded in `operation_queue` before it waits
 * for the account write slot, so a process shutdown while an operation is
 * queued or in flight never loses it: `resumePending` re-enqueues every
 * pending/running row on startup. Execution itself is serialized per account
 * by the sync write locks, and replay is idempotent (a re-run of a move or
 * flag update that already reached the provider settles as a no-op).
 */

export type OperationKind = "move" | "batch-move" | "flags";

export type OperationQueueRow = {
  id: string;
  account_id: string;
  kind: OperationKind;
  payload_json: string;
  status: "pending" | "running" | "completed" | "failed";
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type OperationRunner<T = unknown> = (payload: unknown) => Promise<T>;

export type OperationQueue = {
  registerRunner<T>(kind: OperationKind, runner: OperationRunner<T>): void;
  /** Records the operation durably, waits for the account write slot, runs
   * the registered executor and settles the row. Rejects with the executor's
   * error when the operation fails; the row then stays as a failed record. */
  enqueueAndRun<T>(accountIds: readonly string[], kind: OperationKind, payload: unknown): Promise<T>;
  /** Re-enqueues every pending/running row after a restart and prunes old
   * terminal rows. Returns how many operations were resumed. */
  resumePending(): Promise<number>;
};

const TERMINAL_ROW_TTL_MS = 24 * 60 * 60 * 1000;

export function createOperationQueue(db: DatabaseHandle): OperationQueue {
  const runners = new Map<OperationKind, OperationRunner>();

  const insertPending = db.prepare(`
    INSERT INTO operation_queue (id, account_id, kind, payload_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `);
  const markRunning = db.prepare(`
    UPDATE operation_queue SET status = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?
  `);
  const markSettled = db.prepare(`
    UPDATE operation_queue SET status = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?
  `);
  const pruneTerminal = db.prepare(`
    DELETE FROM operation_queue WHERE status IN ('completed', 'failed') AND completed_at < ?
  `);
  const pendingRows = db.prepare(`
    SELECT * FROM operation_queue WHERE status IN ('pending', 'running') ORDER BY created_at
  `);

  async function runRow<T>(row: OperationQueueRow): Promise<T> {
    const runner = runners.get(row.kind);
    if (!runner) {
      // An operation recorded by a build that has no executor for it (or an
      // unknown kind) must settle instead of staying pending forever.
      const now = new Date().toISOString();
      markSettled.run("failed", "no_runner", `No executor registered for operation kind "${row.kind}".`, now, now, row.id);
      throw new Error(`Operation kind "${row.kind}" has no registered executor.`);
    }
    const payload = JSON.parse(row.payload_json) as unknown;
    try {
      const result = await withAccountWriteLocks([row.account_id], async () => {
        // Only mark running once the account slot is held: an operation that
        // is still waiting its turn stays 'pending' (resumable on restart).
        markRunning.run(new Date().toISOString(), row.id);
        return runner(payload);
      });
      const now = new Date().toISOString();
      markSettled.run("completed", null, null, now, now, row.id);
      return result as T;
    } catch (error) {
      // The operation failed while holding the slot. Record the outcome so
      // the row never resurrects on the next restart (only pending/running
      // rows are resumed) and rethrow for the HTTP layer to map.
      const message = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      markSettled.run("failed", null, message, now, now, row.id);
      throw error;
    }
  }

  return {
    registerRunner<T>(kind: OperationKind, runner: OperationRunner<T>): void {
      runners.set(kind, runner as OperationRunner);
    },

    async enqueueAndRun<T>(accountIds: readonly string[], kind: OperationKind, payload: unknown): Promise<T> {
      if (accountIds.length === 0) {
        // No account to serialize or persist against (e.g. the target
        // message does not exist). Run the executor directly so callers keep
        // their exact error semantics without creating a pointless row that
        // would violate the account foreign key.
        const runner = runners.get(kind);
        if (!runner) throw new Error(`Operation kind "${kind}" has no registered executor.`);
        return runner(payload) as Promise<T>;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      // The row is durable before the operation waits for the slot: a
      // shutdown during the wait is recovered by resumePending on startup.
      insertPending.run(id, accountIds[0] ?? "", kind, JSON.stringify(payload), now, now);
      const row = db.prepare("SELECT * FROM operation_queue WHERE id = ?").get(id) as OperationQueueRow;
      return runRow<T>(row);
    },

    async resumePending(): Promise<number> {
      pruneTerminal.run(new Date(Date.now() - TERMINAL_ROW_TTL_MS).toISOString());
      const rows = pendingRows.all() as OperationQueueRow[];
      for (const row of rows) {
        void runRow(row).catch((error) => {
          console.warn(`Operation ${row.id} (${row.kind}) failed after restart resume:`, error);
        });
      }
      return rows.length;
    },
  };
}
