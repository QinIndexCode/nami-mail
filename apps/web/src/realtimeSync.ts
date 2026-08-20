import { useEffect, useRef } from "react";
import type { ToastKind } from "./mailUi";
import type { Translate } from "./i18n";

// The periodic poll is a fallback, not a co-driver: while the push stream is
// healthy every inbound event already refreshes the mailbox, so a tick inside
// the same window would re-fetch the same data. A tick is only due once a full
// interval has passed without any SSE event — lastSseEventAt doubles as the
// stall detector, so a stream that dies silently falls back to the poll
// cadence instead of leaving the UI stale.
export function shouldPollTick(lastSseEventAtMs: number, nowMs: number, intervalMs: number): boolean {
  return nowMs - lastSseEventAtMs >= intervalMs;
}

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
}: RealtimeSyncOptions): void {
  const sseHandlersRef = useRef<{
    mailReceived: (event: MessageEvent<string>) => void;
    mailSynced: () => void;
    settingsChanged: () => void;
  }>({
    mailReceived: () => undefined,
    mailSynced: () => undefined,
    settingsChanged: () => undefined,
  });
  // Timestamp of the most recent inbound SSE event; the periodic poll skips
  // its tick while this stays fresh (see shouldPollTick) and resumes once a
  // full interval passes without one, so a dead stream never stalls the UI.
  const lastSseEventAtRef = useRef(0);

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
    if (!enabled || !pushEnabled) return undefined;
    let closed = false;
    let source: EventSource | null = null;
    let retryTimer = 0;
    let attempt = 0;
    // After repeated consecutive failures — e.g. the events endpoint returns
    // 404 when the server has no event bus — stop reconnecting and fall back
    // to the periodic poll instead of hammering a dead endpoint forever.
    const maxReconnectAttempts = 10;

    const handleMailReceived = (event: MessageEvent<string>) => sseHandlersRef.current.mailReceived(event);
    const handleMailSynced = () => sseHandlersRef.current.mailSynced();
    const handleSettingsChanged = () => sseHandlersRef.current.settingsChanged();

    const connect = () => {
      source?.close();
      const next = new EventSource("/api/events");
      source = next;
      next.addEventListener("mail.received", handleMailReceived);
      next.addEventListener("mail.synced", handleMailSynced);
      next.addEventListener("settings.changed", handleSettingsChanged);
      next.onopen = () => { attempt = 0; };
      next.onerror = () => {
        if (closed || next !== source) return;
        // EventSource would auto-reconnect and hammer a dead endpoint; close
        // and retry with capped exponential backoff instead.
        next.close();
        if (attempt >= maxReconnectAttempts) return;
        const delay = Math.min(1_000 * 2 ** attempt, 30_000);
        attempt += 1;
        retryTimer = window.setTimeout(() => { if (!closed) connect(); }, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled, pushEnabled]);
}