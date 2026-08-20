import type { DatabaseHandle } from "./db.js";
import type { NewInboxMessage } from "./sync.js";

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

export type ServerEvent =
  | { type: "mail.received"; payload: MailReceivedEvent }
  | { type: "mail.synced"; payload: MailSyncedEvent }
  | { type: "settings.changed"; payload: SettingsChangedEvent };

export type ServerEventListener = (event: ServerEvent) => void;

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

  emit(event: ServerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
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