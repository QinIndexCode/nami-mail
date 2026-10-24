/**
 * Account sync/move concurrency state plus the per-account FIFO write lock.
 *
 * This module is a leaf: its only import is `node:async_hooks`, so the sync
 * family (sync.ts, sync-moves.ts, sync-flags.ts), the account routes and
 * `tasks/scheduler.ts` (which holds an account's write slot for the whole of a
 * task runner) can all depend on it without any of them depending on each
 * other. These primitives used to live in sync.ts, which made sync.ts the
 * parent of its own children and produced an import cycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";


const running = new Set<string>();
const movingAccounts = new Set<string>();

/** True when the account is mid-sync. Used by move operations to block concurrent intents. */
export function isAccountSyncing(accountId: string): boolean {
  return running.has(accountId);
}

/** True when a move operation is in flight for the account. */
export function isAccountMoving(accountId: string): boolean {
  return movingAccounts.has(accountId);
}

/** Mark an account as mid-move. Call from sync-moves.ts only. */
export function markAccountMoving(accountId: string): void {
  movingAccounts.add(accountId);
}

/** Clear the mid-move flag for an account. Call from sync-moves.ts only. */
export function unmarkAccountMoving(accountId: string): void {
  movingAccounts.delete(accountId);
}

/** Clears in-flight sync and move tracking when an account is deleted. */
export function clearAccountSyncState(accountId: string): void {
  running.delete(accountId);
  movingAccounts.delete(accountId);
}

/** Marks an account as mid-sync. Call from sync.ts only. */
export function markAccountSyncing(accountId: string): void {
  running.add(accountId);
}

/** Clears the mid-sync flag. Call from sync.ts only. */
export function unmarkAccountSyncing(accountId: string): void {
  running.delete(accountId);
}

// Per-account FIFO write lock chains. A second write operation on the same
// account (another move, a flag update) waits in line instead of failing with
// a busy error, so a burst of deletes or moves is processed in order rather
// than rejected. A full sync pass (`running`) intentionally stays an
// immediate failure: queued writes must never block a sync cycle.
const accountWriteChains = new Map<string, Promise<void>>();

// Tracks which accounts the current async execution context already holds a
// write slot for. Nested acquisitions — a task drain takes the slot before
// invoking a runner that also takes it (`tasks/scheduler.ts`), and batch moves
// fall back to single-message moves that take it again — must be no-ops instead
// of waiting on their own gate forever (a self-deadlock).
const heldWriteSlots = new AsyncLocalStorage<Set<string>>();

/** Longest an operation may wait for the account write slot it is queued
 * behind. A predecessor whose provider command hangs (and whose run is later
 * abandoned at `TASK_RUN_TIMEOUT_MS`) must not block this operation forever; on
 * timeout the operation fails and its place in the chain is released so
 * operations behind it still proceed.
 *
 * Tiered *below* the renderer's 30s request budget (`REQUEST_TIMEOUT_MS` in
 * apps/web/src/api.ts) on purpose. The wait is only the first leg of a request:
 * the slot still has to be followed by the IMAP work and the response. When
 * this equalled the client budget, server and client gave up in the same
 * instant and the real reason ("Timed out waiting for the account X write
 * slot") never reached the UI — every user saw a bare network failure. At 12s
 * the server abandons the wait with ~18s of budget left to get the real error
 * home, and a write that has not been served by then is not going to be served
 * before the client hangs up anyway. Still far shorter than the task run
 * timeout (`TASK_RUN_TIMEOUT_MS`), and well above the seconds a normal
 * operation needs. */
export const ACCOUNT_WRITE_SLOT_TIMEOUT_MS = 12_000;

/** Slack, as a fraction of {@link ACCOUNT_WRITE_SLOT_TIMEOUT_MS}, spread over
 * the waiters of one account. Every waiter used to arm the *same* deadline as
 * everyone already queued, so a burst of writes behind one wedged account
 * rejected in the same millisecond (measured: 60 failures inside a 1ms window).
 * Per-waiter deadlines turn that single spike into a short stagger, so the
 * rejections — and whatever retries the client sends after them — are spread
 * instead of arriving as one burst. Small enough (±1.2s) that no waiter's
 * outcome can hinge on it. */
const ACCOUNT_WRITE_SLOT_SPREAD_RATIO = 0.1;

/** Monotonic index feeding the per-waiter deadline spread below. Module
 * private and never read, so it only has to make consecutive waiters differ. */
let slotWaitIndex = 0;

/**
 * This waiter's own slot-wait budget: the base timeout with a bounded
 * pseudo-random offset.
 *
 * The offset is derived from a counter through a 32-bit avalanche rather than
 * `Math.random()`: the deadlines stay reproducible (a test can assert the exact
 * spread instead of sampling it), allocation-free, and a plain `counter %
 * window` would hand the first waiters of a burst adjacent deadlines — the
 * very clustering the spread exists to remove.
 */
function slotWaitTimeoutMs(): number {
  const slack = Math.round(ACCOUNT_WRITE_SLOT_TIMEOUT_MS * ACCOUNT_WRITE_SLOT_SPREAD_RATIO);
  slotWaitIndex = (slotWaitIndex + 1) >>> 0;
  let mixed = Math.imul(slotWaitIndex, 0x9e3779b1);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b);
  mixed = (mixed ^ (mixed >>> 13)) >>> 0;
  return ACCOUNT_WRITE_SLOT_TIMEOUT_MS - slack + (mixed % (slack * 2 + 1));
}

/** Stable marker so a write-slot timeout stays recognizable after it has
 * crossed a module boundary (the task drain decides on it, `tasks/scheduler.ts`). */
export const ACCOUNT_WRITE_SLOT_TIMEOUT_CODE = "account_write_slot_timeout";

/**
 * Raised when the wait for an account write slot runs out. A distinct type
 * (rather than a bare Error) so callers can tell "this account is saturated"
 * apart from "this operation failed" — the first must not be retried into the
 * same saturation. The message is unchanged, so anything surfacing it to the
 * user is unaffected.
 */
export class AccountWriteSlotTimeoutError extends Error {
  readonly code = ACCOUNT_WRITE_SLOT_TIMEOUT_CODE;

  constructor(readonly accountId: string) {
    super(`Timed out waiting for the account ${accountId} write slot.`);
    this.name = "AccountWriteSlotTimeoutError";
  }
}

/** True for a {@link AccountWriteSlotTimeoutError}, including one that crossed
 * a module-instance boundary (the `code` check). */
export function isAccountWriteSlotTimeoutError(error: unknown): boolean {
  if (error instanceof AccountWriteSlotTimeoutError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ACCOUNT_WRITE_SLOT_TIMEOUT_CODE
  );
}

/** Rejects with `message` after `milliseconds`, without keeping the process
 * alive for a run that may never settle on its own during shutdown.
 *
 * `error` lets a caller reject with a typed error (see
 * {@link AccountWriteSlotTimeoutError}) instead of an anonymous `Error` with
 * the same message, so the rejection keeps its type on the far side. */
export function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  error?: Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error ?? new Error(message)), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (rejection) => { clearTimeout(timer); reject(rejection); },
    );
  });
}

/** Longest a write lets an in-flight sync pass finish before giving up. Kept
 * well below the renderer's 30s request budget so the caller still gets the
 * real outcome instead of a client-side timeout. */
export const ACCOUNT_SYNC_WAIT_MS = 15_000;

/** Polls `predicate` until it holds or `timeoutMs` elapses. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

/**
 * Resolves true once no sync pass is in flight for the account, false when the
 * budget ran out.
 *
 * A write must never *block* a sync cycle (see the write-chain note above), but
 * it must also not be rejected just because a pass happens to be running. The
 * caller claims the account for moving first, which makes `syncAccount` skip
 * it, so no new pass can start here — only the pass already underway has to
 * finish.
 */
export function waitForAccountSyncIdle(accountId: string, timeoutMs = ACCOUNT_SYNC_WAIT_MS): Promise<boolean> {
  return waitUntil(() => !running.has(accountId), timeoutMs);
}

/**
 * Acquires write slots for every account in a deterministic order (sorted, so
 * concurrent multi-account batches can never deadlock). The returned release
 * functions must be called in reverse order.
 */
export async function acquireAccountWriteSlots(accountIds: readonly string[]): Promise<Array<() => void>> {
  const sorted = [...new Set(accountIds)].sort();
  const releases: Array<() => void> = [];
  const held = heldWriteSlots.getStore();
  try {
    for (const accountId of sorted) {
      // A nested acquisition within the same execution context already holds
      // this account's slot: do not wait on our own gate (self-deadlock).
      if (held?.has(accountId)) continue;
      const prev = accountWriteChains.get(accountId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      accountWriteChains.set(accountId, prev.then(() => gate));
      const slotTimeout = new AccountWriteSlotTimeoutError(accountId);
      try {
        await withTimeout(prev, slotWaitTimeoutMs(), slotTimeout.message, slotTimeout);
      } catch (error) {
        // Give up our place instead of leaving an unresolved gate that would
        // block every operation queued behind us.
        release();
        throw error;
      }
      held?.add(accountId);
      releases.push(() => {
        release();
        held?.delete(accountId);
      });
    }
    return releases;
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
}

/** Runs `fn` while holding write slots for every named account. */
export async function withAccountWriteLocks<T>(accountIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  // Copy the parent set: acquire/release inside `fn` must not leak into the
  // outer context, mirroring withHeldWriteSlots (the shared-reference variant
  // let an outer context transiently observe ids it does not hold).
  return heldWriteSlots.run(new Set(heldWriteSlots.getStore() ?? []), async () => {
    const releases = await acquireAccountWriteSlots(accountIds);
    try {
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
}

/**
 * Runs `fn` in a context that considers every named account's write slot as
 * already held, so the runner's own nested `withAccountWriteLocks` calls are
 * reentrant no-ops. Used by the task drain (`tasks/scheduler.ts`), which
 * acquires the slot itself (to release it on timeout) before invoking a runner
 * that would otherwise acquire it again and deadlock.
 */
export function withHeldWriteSlots<T>(accountIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  const parent = heldWriteSlots.getStore();
  const held = new Set(accountIds);
  if (parent) for (const accountId of parent) held.add(accountId);
  return heldWriteSlots.run(held, fn);
}

