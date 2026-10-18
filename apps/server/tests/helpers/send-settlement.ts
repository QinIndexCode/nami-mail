import { expect, vi } from "vitest";
import type { DatabaseHandle } from "../../src/db.js";
import { isTerminalTaskStatus, isTaskStatus } from "../../src/tasks/types.js";

/**
 * Waiting for the send task an acceptance committed to reach its terminal state.
 *
 * The acceptance a route answers with is only half of a send now: the route
 * commits the ledger row, the optimistic Sent row and the dispatch task without
 * awaiting the provider, and the app's own scheduler owns the SMTP conversation
 * from there -- it claims the task the moment `commitTask` starts it, often
 * before the response has even been written. So a route test cannot await the
 * response and then assert on the mail; it has to wait for the *task*.
 *
 * Waiting rather than driving the task is deliberate. The scheduler that runs
 * these tasks is the one `buildApp` created, so this is the real wiring end to
 * end -- acceptance, dispatch, runner, ledger -- and a test that built its own
 * second scheduler would race this one for the same claim and would leave the
 * production chain (the one that decides who dials the socket) unexercised.
 *
 * Shared rather than copied because the obvious wait is the wrong one:
 * `sendMail` is called while the ledger still says `submitting`, so waiting on
 * the socket returns before the attempt has decided anything. Only the task row
 * marks the attempt as over.
 */

export interface SendTaskSettlement {
  status: string;
  errorCode: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The task row's terminal state, or `undefined` while it can still run again. */
export function sendTaskSettlement(db: DatabaseHandle, taskId: string): SendTaskSettlement | undefined {
  const row = db.prepare("SELECT status, error_code FROM tasks WHERE id = ?").get(taskId) as
    | { status: string; error_code: string | null }
    | undefined;
  if (!row) return undefined;
  // A row carrying a status this build does not know is not something this
  // helper may call finished, so it stays `undefined` and the wait times out
  // loudly rather than returning a value no test asked about.
  if (!isTaskStatus(row.status) || !isTerminalTaskStatus(row.status)) return undefined;
  return { status: row.status, errorCode: row.error_code };
}

export async function waitForSendTask(db: DatabaseHandle, taskId: string, timeout = DEFAULT_TIMEOUT_MS): Promise<SendTaskSettlement> {
  let settled = sendTaskSettlement(db, taskId);
  await vi.waitFor(() => {
    settled = sendTaskSettlement(db, taskId);
    // The reason is attached rather than read out of `settled`: the three worlds
    // below collapse into the same `undefined`, and "expected undefined to be
    // defined" is the same line whether the row was never committed, carries a
    // status this build does not know, or is simply still running. A test that
    // times out has to say which one it is.
    expect(settled, describeUnsettledTask(db, taskId)).toBeDefined();
  }, { timeout });
  return settled!;
}

/**
 * Why {@link sendTaskSettlement} has nothing to return yet -- for the failure
 * message of a timed-out wait, and for nothing else.
 */
function describeUnsettledTask(db: DatabaseHandle, taskId: string): string {
  const row = db.prepare("SELECT status, attempt_count, max_attempts, error_code FROM tasks WHERE id = ?").get(taskId) as
    | { status: string; attempt_count: number; max_attempts: number; error_code: string | null }
    | undefined;
  if (!row) return `no task row for "${taskId}"`;
  if (!isTaskStatus(row.status)) return `task "${taskId}" carries the unknown status "${row.status}"`;
  return `task "${taskId}" is still "${row.status}" after ${row.attempt_count}/${row.max_attempts} attempts, last error "${row.error_code ?? "none"}"`;
}
