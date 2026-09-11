import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db.js";
import { acquireAccountWriteSlots, withHeldWriteSlots, withTimeout } from "./sync.js";
import { serverLog } from "./logging.js";

/**
 * Durable queue for user-initiated message write operations (moves, flag
 * updates). Each operation is recorded in `operation_queue` before it waits
 * for the account write slot, so a process shutdown while an operation is
 * queued or in flight never loses it: `resumePending` re-enqueues every
 * pending/running row on startup. Execution itself is serialized per account
 * by the sync write locks, and replay is idempotent (a re-run of a move or
 * flag update that already reached the provider settles as a no-op).
 */

export type OperationKind = "move" | "batch-move" | "flags" | "flags-push";

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

export type OperationQueueHooks = {
  /** Called when a background operation exhausts its retries and is given up
   * on. The payload is the operation's own JSON payload; handlers clear any
   * per-message markers they set at enqueue time. */
  onBackgroundPermanentFailure?(kind: OperationKind, payload: unknown): void;
};

export type OperationQueue = {
  registerRunner<T>(kind: OperationKind, runner: OperationRunner<T>): void;
  /** Records the operation durably, waits for the account write slot, runs
   * the registered executor and settles the row. Rejects with the executor's
   * error when the operation fails; the row then stays as a failed record. */
  enqueueAndRun<T>(accountIds: readonly string[], kind: OperationKind, payload: unknown): Promise<T>;
  /** Write-behind variant: records the operation durably and processes it in
   * the background (FIFO per account, bounded retries with backoff), so the
   * caller — and the HTTP response — is not blocked on IMAP round-trips.
   * Rows survive a restart through resumePending. */
  enqueueBackground(accountIds: readonly string[], kind: OperationKind, payload: unknown): void;
  /** Re-enqueues every pending/running row after a restart and prunes old
   * terminal rows. Returns how many operations were resumed. */
  resumePending(): Promise<number>;
};

const TERMINAL_ROW_TTL_MS = 24 * 60 * 60 * 1000;

/** Longest a single queued operation may hold the account write slot before
 * it is abandoned and the slot released. A hung provider command (e.g. an
 * IMAP MOVE that never answers, despite the 45s provider socket timeout)
 * must not stall every later flag update and move on the same account
 * forever. Generous by design: a normal move or flag batch finishes in
 * seconds, so this only fires on true hangs. */
const OPERATION_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** Background (write-behind) operations retry with exponential backoff up to
 * this many attempts before being given up on and handed to
 * onBackgroundPermanentFailure. 8 attempts span roughly 4-5 minutes. */
const BACKGROUND_MAX_ATTEMPTS = 8;
const BACKGROUND_RETRY_BASE_MS = 1_000;
const BACKGROUND_RETRY_MAX_MS = 30_000;

export function createOperationQueue(db: DatabaseHandle, hooks: OperationQueueHooks = {}): OperationQueue {
  const runners = new Map<OperationKind, OperationRunner>();
  // Per-account FIFO chains for background (write-behind) operations: rows for
  // the same message must push in commit order, and retry backoff must not let
  // a newer row overtake an older one.
  const backgroundChains = new Map<string, Promise<void>>();

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
    // The slot is acquired and released here instead of through
    // withAccountWriteLocks so a timed-out run still releases the account
    // lock: the abandoned executor keeps running in the background, but later
    // operations on the account are no longer stalled behind it forever.
    const releases = await acquireAccountWriteSlots([row.account_id]);
    try {
      const result = await withTimeout(
        withHeldWriteSlots([row.account_id], async () => {
          // Only mark running once the account slot is held: an operation that
          // is still waiting its turn stays 'pending' (resumable on restart).
          markRunning.run(new Date().toISOString(), row.id);
          return runner(payload);
        }),
        OPERATION_RUN_TIMEOUT_MS,
        `Operation "${row.kind}" timed out after ${OPERATION_RUN_TIMEOUT_MS / 1000}s.`,
      );
      const now = new Date().toISOString();
      markSettled.run("completed", null, null, now, now, row.id);
      return result as T;
    } catch (error) {
      // The operation failed while holding the slot. Record the outcome so the
      // row never resurrects on the next restart (only pending/running rows
      // are resumed) and rethrow for the HTTP layer to map. Timeouts are
      // recorded as failed too, so a hung operation is not resumed after a
      // restart; any half-applied provider effect is reconciled by sync.
      const message = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      markSettled.run("failed", null, message, now, now, row.id);
      throw error;
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  /** Background FIFO driver: bounded retries with exponential backoff. The
   * row is flipped back to 'pending' between attempts so a restart mid-retry
   * still resumes it. After the final attempt the row stays failed and the
   * hook lets the owner clean up per-message markers. */
  async function driveWithRetries(row: OperationQueueRow): Promise<void> {
    for (let attempt = 1; attempt <= BACKGROUND_MAX_ATTEMPTS; attempt += 1) {
      try {
        await runRow(row);
        return;
      } catch {
        if (attempt >= BACKGROUND_MAX_ATTEMPTS) break;
        const delay = Math.min(BACKGROUND_RETRY_MAX_MS, BACKGROUND_RETRY_BASE_MS * 2 ** (attempt - 1));
        try {
          db.prepare("UPDATE operation_queue SET status = 'pending', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), row.id);
        } catch {
          // The database handle is closed (shutdown during a retry wait):
          // stop retrying, the durable row is already recorded on disk.
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const payload = JSON.parse(row.payload_json) as unknown;
    try {
      hooks.onBackgroundPermanentFailure?.(row.kind, payload);
    } catch (hookError) {
      serverLog.warn({ operationId: row.id, kind: row.kind }, "Background failure hook threw", hookError);
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

    enqueueBackground(accountIds: readonly string[], kind: OperationKind, payload: unknown): void {
      if (accountIds.length === 0) return;
      const id = randomUUID();
      const now = new Date().toISOString();
      insertPending.run(id, accountIds[0] ?? "", kind, JSON.stringify(payload), now, now);
      const row = db.prepare("SELECT * FROM operation_queue WHERE id = ?").get(id) as OperationQueueRow;
      // Strict FIFO per account: rows for the same message must push in the
      // order they were committed, or deltas could compose out of order.
      const chain = (backgroundChains.get(row.account_id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => driveWithRetries(row));
      backgroundChains.set(row.account_id, chain);
    },

    async resumePending(): Promise<number> {
      pruneTerminal.run(new Date(Date.now() - TERMINAL_ROW_TTL_MS).toISOString());
      const rows = pendingRows.all() as OperationQueueRow[];
      for (const row of rows) {
        // Resumed rows share the same per-account FIFO chain as fresh
        // background operations so multi-row flag pushes keep their order.
        const chain = (backgroundChains.get(row.account_id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => driveWithRetries(row))
          .catch((error) => {
            serverLog.warn({ operationId: row.id, kind: row.kind }, "Operation failed after restart resume", error);
          });
        backgroundChains.set(row.account_id, chain);
      }
      return rows.length;
    },
  };
}
