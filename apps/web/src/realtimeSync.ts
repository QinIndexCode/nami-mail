import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastKind } from "./mailUi";
import type { Translate } from "./i18n";
import { REALTIME_EVENT_NAMES, type RealtimeEventName } from "./realtimeEventNames";
import { isTaskTerminalStatus, type TaskTerminalStatus } from "./taskStatuses";

// The periodic poll is a fallback, not a co-driver: while the push stream is
// healthy every inbound event already refreshes the mailbox, so a tick inside
// the same window would re-fetch the same data. A tick is only due once a full
// interval has passed without any SSE event — lastSseEventAt doubles as the
// stall detector, so a stream that dies silently falls back to the poll
// cadence instead of leaving the UI stale.
export function shouldPollTick(lastSseEventAtMs: number, nowMs: number, intervalMs: number): boolean {
  return nowMs - lastSseEventAtMs >= intervalMs;
}

export type SyncProgressPayload = {
  accountId: string;
  folder: string;
  processed: number;
  totalEstimate: number;
};

/**
 * A durable task's own progress report. The cloud-sync panel patches the row it
 * already holds with it, and treats one for a task it has never seen as a reason
 * to re-read the list; receiving it also keeps the stream's stall detector fresh.
 */
export type TaskProgressPayload = {
  accountId: string;
  taskId: string;
  total: number;
  updated: number;
  failed: number;
};

/** A task reached a terminal state; the shell reconciles on this frame. */
export type TaskSettledPayload = {
  accountId: string;
  taskId: string;
  status: TaskTerminalStatus;
};

/**
 * A writer other than this renderer changed mail rows (today: an Agent write).
 * `folders` may be empty when the writer could not name one.
 */
export type MailChangedPayload = {
  accountId: string;
  folders: string[];
};

export type RealtimeSyncOptions = {
  /** Master switch (the App shell passes `!isDemo`); when off nothing connects or polls. */
  enabled: boolean;
  /** The settings toggle that turns the push stream on/off at runtime. */
  pushEnabled: boolean;
  /** Poll cadence in seconds when no SSE event keeps the stream fresh. */
  refreshIntervalSeconds: number;
  /** Desktop renderers get their own arrival notice through the IPC bridge, so no in-app toast. */
  isDesktop: boolean;
  t: Translate;
  showToast: (message: string, kind?: ToastKind) => void;
  /** Refresh the mailbox snapshot (and the sidebar freshness lines). */
  onRefresh: () => void;
  /** Re-fetch and apply app settings after the Agent tool changed them. */
  onSettingsChanged: () => void;
  /** Live initial/full sync progress, for a "syncing history" banner. */
  onSyncProgress: (progress: SyncProgressPayload) => void;
  /** Optional: a task's progress report. */
  onTaskProgress?: (progress: TaskProgressPayload) => void;
  /**
   * A task settled. The shell reconciles here instead of polling for it; the
   * status is always terminal (`isTaskTerminalStatus` filtered the frame).
   */
  onTaskSettled?: (settled: TaskSettledPayload) => void;
  /** Mail rows changed outside this renderer (an Agent write). */
  onMailChanged?: (changed: MailChangedPayload) => void;
};

/**
 * Push-stream health. `offline` means the backoff budget is spent and only the
 * periodic poll is left: the shell surfaces it so the user can retry by hand
 * instead of silently losing live updates for the rest of the session.
 */
export type RealtimeConnectionState = "disabled" | "connecting" | "live" | "reconnecting" | "offline";

export type RealtimeSyncHandle = {
  connectionState: RealtimeConnectionState;
  /** Restart the stream immediately, resetting the backoff budget. */
  reconnect: () => void;
};

/**
 * Owns the real-time push stream and its poll fallback as one unit, because
 * both share the last-SSE-event timestamp: the poll skips its tick while the
 * stream is fresh and resumes after a full silent interval, so a dead stream
 * never stalls the UI.
 *
 * The EventSource connection must survive sidebar view/folder switches:
 * binding it to onRefresh would re-create it on every selection change and
 * drop any event in flight (the server log showed reconnect storms during
 * switches). The connection effect therefore only depends on the push toggle;
 * the latest closures are reached through sseHandlersRef, which is re-pointed
 * on every render so a mail.received is never handled with stale view/folder
 * state.
 */
export function useRealtimeSync({
  enabled,
  pushEnabled,
  refreshIntervalSeconds,
  isDesktop,
  t,
  showToast,
  onRefresh,
  onSettingsChanged,
  onSyncProgress,
  onTaskProgress,
  onTaskSettled,
  onMailChanged,
}: RealtimeSyncOptions): RealtimeSyncHandle {
  const sseHandlersRef = useRef<{
    mailReceived: (event: MessageEvent<string>) => void;
    mailSynced: () => void;
    settingsChanged: () => void;
    syncProgress: (event: MessageEvent<string>) => void;
    taskProgress: (event: MessageEvent<string>) => void;
    taskSettled: (event: MessageEvent<string>) => void;
    mailChanged: (event: MessageEvent<string>) => void;
  }>({
    mailReceived: () => undefined,
    mailSynced: () => undefined,
    settingsChanged: () => undefined,
    syncProgress: () => undefined,
    taskProgress: () => undefined,
    taskSettled: () => undefined,
    mailChanged: () => undefined,
  });
  // Timestamp of the most recent inbound SSE event; the periodic poll skips
  // its tick while this stays fresh (see shouldPollTick) and resumes once a
  // full interval passes without one, so a dead stream never stalls the UI.
  const lastSseEventAtRef = useRef(0);
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>("disabled");
  // Bumping this re-runs the stream effect with a fresh attempt budget, which
  // is how the shell's manual retry escapes the exhausted-backoff state.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const reconnect = useCallback(() => setReconnectNonce((value) => value + 1), []);

  useEffect(() => {
    sseHandlersRef.current.mailReceived = (event: MessageEvent<string>) => {
      lastSseEventAtRef.current = Date.now();
      void onRefresh();
      if (isDesktop) return;
      let payload: { count: number; messages: Array<{ subject?: string; fromName?: string; fromAddress?: string }> };
      try {
        const parsed = JSON.parse(event.data) as { type?: unknown; payload?: { count?: unknown; messages?: unknown } };
        if (parsed.type !== "mail.received" || !parsed.payload || typeof parsed.payload.count !== "number") return;
        payload = parsed.payload as typeof payload;
      } catch {
        return;
      }
      if (payload.count < 1) return;
      const first = payload.messages[0];
      showToast(payload.count === 1
        ? t("mail.notification.singleToast", { sender: first?.fromName || first?.fromAddress || t("mail.notification.newContact") })
        : t("mail.notification.multipleToast", { count: payload.count }));
    };
    // A finished sync pass refreshes the sidebar freshness immediately; the
    // account list is re-fetched inside the refresh so "尚未同步" never
    // lingers until the next poll tick.
    sseHandlersRef.current.mailSynced = () => { lastSseEventAtRef.current = Date.now(); void onRefresh(); };
    // The Agent settings tool changed app settings — re-fetch and apply them
    // so the running UI reflects the change immediately.
    sseHandlersRef.current.settingsChanged = () => { lastSseEventAtRef.current = Date.now(); void onSettingsChanged(); };
    // Live initial/full sync progress. This is display-only (a "syncing history"
    // banner) and intentionally does NOT trigger onRefresh — a background bulk
    // download would otherwise hammer the mailbox API once per batch. The
    // finished-pass mail.synced event is what reconciles the list at the end.
    //
    // Only a frame that parses and validates counts as stream liveness. The
    // timestamp suppresses the fallback poll, so recording it before the checks
    // would let a stream of malformed frames postpone recovery indefinitely.
    sseHandlersRef.current.syncProgress = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as { payload?: { accountId?: unknown; folder?: unknown; processed?: unknown; totalEstimate?: unknown } };
        const payload = parsed.payload;
        if (!payload || typeof payload.accountId !== "string" || typeof payload.folder !== "string"
          || typeof payload.processed !== "number" || typeof payload.totalEstimate !== "number") return;
        lastSseEventAtRef.current = Date.now();
        onSyncProgress({
          accountId: payload.accountId,
          folder: payload.folder,
          processed: payload.processed,
          totalEstimate: payload.totalEstimate,
        });
      } catch {
        // Malformed frame — ignore, the next one carries the same state.
      }
    };
    // A runner's own progress: the cloud-sync panel patches the row it already
    // holds, and a frame for a task no read has returned yet is what makes it
    // re-read the list. The frame also proves the stream is alive -- lastSseEventAt
    // is what suppresses a redundant poll tick.
    sseHandlersRef.current.taskProgress = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as { payload?: { accountId?: unknown; taskId?: unknown; total?: unknown; updated?: unknown; failed?: unknown } };
        const payload = parsed.payload;
        if (!payload || typeof payload.accountId !== "string" || typeof payload.taskId !== "string"
          || typeof payload.total !== "number" || typeof payload.updated !== "number" || typeof payload.failed !== "number") return;
        lastSseEventAtRef.current = Date.now();
        onTaskProgress?.({
          accountId: payload.accountId,
          taskId: payload.taskId,
          total: payload.total,
          updated: payload.updated,
          failed: payload.failed,
        });
      } catch {
        // Malformed frame — the eventual task-settled or the poll recovers.
      }
    };
    // A terminal task. The status is filtered against the same vocabulary the
    // server settles with; a frame outside it is a protocol mismatch, and
    // reconciling on it would only hide the mismatch behind a refresh.
    sseHandlersRef.current.taskSettled = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as { payload?: { accountId?: unknown; taskId?: unknown; status?: unknown } };
        const payload = parsed.payload;
        if (!payload || typeof payload.accountId !== "string" || typeof payload.taskId !== "string"
          || !isTaskTerminalStatus(payload.status)) return;
        lastSseEventAtRef.current = Date.now();
        onTaskSettled?.({ accountId: payload.accountId, taskId: payload.taskId, status: payload.status });
      } catch {
        // Malformed frame — ignored like the others; the poll stays the fallback.
      }
    };
    // Mail rows changed where this renderer cannot see them: an Agent tool call
    // or an Agent-triggered sync. Unlike sync.progress this DOES refresh, and
    // unlike mail.synced it names the folders so a future view can narrow the
    // read; today the shell's refresh is view-scoped, so all it needs is the
    // signal.
    sseHandlersRef.current.mailChanged = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as { payload?: { accountId?: unknown; folders?: unknown } };
        const payload = parsed.payload;
        if (!payload || typeof payload.accountId !== "string") return;
        const folders = Array.isArray(payload.folders)
          ? payload.folders.filter((folder): folder is string => typeof folder === "string")
          : [];
        lastSseEventAtRef.current = Date.now();
        onMailChanged?.({ accountId: payload.accountId, folders });
      } catch {
        // Malformed frame — ignored like the others; the poll stays the fallback.
      }
    };
  });

  useEffect(() => {
    if (!enabled) return;
    const intervalMs = refreshIntervalSeconds * 1000;
    const timer = window.setInterval(() => {
      // Skip the tick while the push stream is delivering events — those
      // handlers already refresh the mailbox, so polling again would repeat
      // the same fetches. When no event has arrived for a full interval the
      // tick fires again, which also covers a stream that died silently
      // (lastSseEventAt is the last event's timestamp, not the connect time).
      if (!shouldPollTick(lastSseEventAtRef.current, Date.now(), intervalMs)) return;
      void onRefresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, onRefresh, refreshIntervalSeconds]);

  useEffect(() => {
    if (!enabled || !pushEnabled) {
      setConnectionState("disabled");
      return undefined;
    }
    let closed = false;
    let source: EventSource | null = null;
    let retryTimer = 0;
    let attempt = 0;
    // After repeated consecutive failures — e.g. the events endpoint returns
    // 404 when the server has no event bus — stop reconnecting and fall back
    // to the periodic poll instead of hammering a dead endpoint forever.
    const maxReconnectAttempts = 10;

    // One listener per name in the wire manifest, looked up in this typed map.
    // The map is what makes "a server event with no listener" impossible: a name
    // added to `REALTIME_EVENT_NAMES` without a handler here fails to compile,
    // and `sse-contract.test.ts` pins the manifest against the server's.
    const handlers: Record<RealtimeEventName, (event: MessageEvent<string>) => void> = {
      "mail.received": (event) => sseHandlersRef.current.mailReceived(event),
      "mail.synced": () => sseHandlersRef.current.mailSynced(),
      "settings.changed": () => sseHandlersRef.current.settingsChanged(),
      "sync.progress": (event) => sseHandlersRef.current.syncProgress(event),
      "task-progress": (event) => sseHandlersRef.current.taskProgress(event),
      "task-settled": (event) => sseHandlersRef.current.taskSettled(event),
      "mail-changed": (event) => sseHandlersRef.current.mailChanged(event),
    };

    const connect = (isRetry: boolean) => {
      source?.close();
      if (!closed) setConnectionState(isRetry ? "reconnecting" : "connecting");
      const next = new EventSource("/api/events");
      source = next;
      for (const name of REALTIME_EVENT_NAMES) next.addEventListener(name, handlers[name]);
      next.onopen = () => {
        if (closed || next !== source) return;
        attempt = 0;
        setConnectionState("live");
      };
      next.onerror = () => {
        if (closed || next !== source) return;
        // EventSource would auto-reconnect and hammer a dead endpoint; close
        // and retry with capped exponential backoff instead.
        next.close();
        if (attempt >= maxReconnectAttempts) {
          // Budget spent: the poll keeps the mailbox fresh, but live updates
          // are gone until the user retries or the app restarts.
          setConnectionState("offline");
          return;
        }
        const delay = Math.min(1_000 * 2 ** attempt, 30_000);
        attempt += 1;
        setConnectionState("reconnecting");
        retryTimer = window.setTimeout(() => { if (!closed) connect(true); }, delay);
      };
    };

    connect(false);
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled, pushEnabled, reconnectNonce]);

  return { connectionState, reconnect };
}