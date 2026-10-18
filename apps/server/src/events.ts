import type { DatabaseHandle } from "./db.js";
import type { NewInboxMessage } from "./sync.js";
import type { TaskStatus } from "./tasks/types.js";

/**
 * Server-originated events pushed to connected clients over the
 * `GET /api/events` SSE endpoint. The same bus is fed by the background sync
 * and IDLE watcher so both browser and desktop renderers can refresh
 * immediately instead of waiting for the next poll.
 */
export type MailReceivedEvent = {
  accountId: string;
  count: number;
  messages: NewInboxMessage[];
};

export type MailSyncedEvent = {
  accountId: string;
  lastSyncedAt: string;
  /**
   * Non-fatal condition noted on this pass (e.g. 'sync_limit' when the
   * per-folder cap discarded older mail), or null when the pass was clean.
   */
  warningCode: string | null;
};

export type SettingsChangedEvent = {
  /** Always empty of data — the renderer re-fetches its own settings snapshot. */
  at: string;
};

export type SyncProgressEvent = {
  accountId: string;
  folder: string;
  /** Number of newly fetched messages persisted so far in this folder's pass. */
  processed: number;
  /** Best-effort total new-message count for the folder; can change between frames. */
  totalEstimate: number;
};

/** A runner's own progress report for one durable task. */
export type TaskProgressEvent = {
  accountId: string;
  taskId: string;
  total: number;
  updated: number;
  failed: number;
};

/**
 * A task reached a terminal state.
 *
 * The status is the task layer's own vocabulary, `cancelled` and
 * `unknown_delivery` included. The HTTP alias collapses the last two to
 * `failed`, which is the same *settled* claim (contract §8 G11/G12): the two
 * surfaces may spell the outcome differently, but neither may leave a task
 * looking unfinished.
 */
export type TaskSettledEvent = {
  accountId: string;
  taskId: string;
  status: TaskStatus;
};

/**
 * A message's row changed outside the requesting renderer — today that means an
 * Agent write (tool call or Agent-triggered sync).
 *
 * `folders` names the mailboxes the change touched, empty when the writer could
 * not name one; an empty list means "refresh what you show" rather than "nothing
 * changed", because the frame is only emitted for an actual write.
 */
export type MailChangedEvent = {
  accountId: string;
  folders: string[];
};

export type ServerEvent =
  | { type: "mail.received"; payload: MailReceivedEvent }
  | { type: "mail.synced"; payload: MailSyncedEvent }
  | { type: "settings.changed"; payload: SettingsChangedEvent }
  | { type: "sync.progress"; payload: SyncProgressEvent }
  | { type: "task-progress"; payload: TaskProgressEvent }
  | { type: "task-settled"; payload: TaskSettledEvent }
  | { type: "mail-changed"; payload: MailChangedEvent };

/**
 * Every event name the server can emit.
 *
 * Not a second source of truth for the union above -- it is the wire manifest
 * the client's listener registry is checked against (contract §8 G12): a name
 * added to the union but not here would be emitted into a void, and
 * `sse-contract.test.ts` pins the two lists against each other (including a
 * compile-time `Record<ServerEvent["type"], true>` that fails if a union member
 * is missing from the test's copy).
 */
export const SERVER_EVENT_TYPES = [
  "mail.received",
  "mail.synced",
  "settings.changed",
  "sync.progress",
  "task-progress",
  "task-settled",
  "mail-changed",
] as const satisfies readonly ServerEvent["type"][];

export type ServerEventListener = (event: ServerEvent, serialized: string | null) => void;

/**
 * A tiny synchronous fan-out. Producers (sync runtime) emit; the SSE route
 * subscribes per connected client. A subscriber throwing must never break the
 * delivery loop, so each listener is isolated inside its own try/catch.
 */
export class ServerEventBus {
  private listeners = new Set<ServerEventListener>();

  /** Number of connected subscribers; lets callers (and tests) observe when the SSE route is live. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: ServerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The bus hands every listener the *same* event object within one emit — it
   * never copies — so the wire bytes a subscriber derives from an event are
   * identical for all of them. Serializing here, once per emit, rather than in
   * each subscriber turns "N renderers x one JSON.stringify of the whole
   * mail.received frame" into a single stringify plus N cheap string writes.
   *
   * `JSON.stringify` can throw (cycles, BigInt). That is a producer bug, and
   * the safe response is to skip the frame for everyone rather than let one
   * subscriber's failure — or an exception out of the emit call itself — stop
   * delivery for the rest.
   */
  emit(event: ServerEvent): void {
    if (this.listeners.size === 0) return;
    let serialized: string | null;
    try {
      serialized = JSON.stringify(event);
    } catch {
      serialized = null;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event, serialized);
      } catch {
        // Delivery to one client must not interrupt the others.
      }
    }
  }
}

/**
 * Broadcasts that the account finished a sync pass. Every sync completion path
 * (poll loop, IDLE-triggered, add-account initial sync, manual re-sync, move
 * reconciliation) reports here so connected renderers refresh the sidebar
 * freshness immediately instead of waiting for the next poll tick.
 */
export function emitAccountSynced(db: DatabaseHandle, bus: ServerEventBus | undefined, accountId: string): void {
  if (!bus) return;
  const row = db.prepare("SELECT last_synced_at, last_sync_warning_code FROM accounts WHERE id = ?").get(accountId) as
    | { last_synced_at: string | null; last_sync_warning_code: string | null }
    | undefined;
  if (row?.last_synced_at) {
    bus.emit({ type: "mail.synced", payload: { accountId, lastSyncedAt: row.last_synced_at, warningCode: row.last_sync_warning_code } });
  }
}

/** Broadcasts that app settings changed (e.g. via the Agent settings tool) so
 * connected renderers re-fetch and apply them immediately. */
export function emitSettingsChanged(bus: ServerEventBus | undefined): void {
  if (!bus) return;
  bus.emit({ type: "settings.changed", payload: { at: new Date().toISOString() } });
}

/** Broadcasts that a folder's pass-two upsert advanced, so connected renderers can
 * show live "syncing history" progress instead of a blank list while a fresh/full
 * sync downloads a large mailbox. */
export function emitSyncProgress(bus: ServerEventBus | undefined, accountId: string, folder: string, processed: number, totalEstimate: number): void {
  if (!bus) return;
  bus.emit({ type: "sync.progress", payload: { accountId, folder, processed, totalEstimate } });
}

/** Broadcasts a task's own progress report, so a renderer that did not start the
 * task (the Agent did, or a batch is still running after a reload) can follow it
 * without polling. */
export function emitTaskProgress(bus: ServerEventBus | undefined, progress: TaskProgressEvent): void {
  if (!bus) return;
  bus.emit({ type: "task-progress", payload: progress });
}

/** Broadcasts a task's terminal state. Renderers treat this as the signal to
 * reconcile; unlike progress it is emitted exactly once per task. */
export function emitTaskSettled(bus: ServerEventBus | undefined, settled: TaskSettledEvent): void {
  if (!bus) return;
  bus.emit({ type: "task-settled", payload: settled });
}

/** Broadcasts that a writer other than this renderer changed mail rows. */
export function emitMailChanged(bus: ServerEventBus | undefined, changed: MailChangedEvent): void {
  if (!bus) return;
  bus.emit({ type: "mail-changed", payload: changed });
}
