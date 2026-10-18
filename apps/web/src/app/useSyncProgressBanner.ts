import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncProgressPayload } from "../realtimeSync";

/**
 * Live initial/full sync progress, fed by "sync.progress" SSE frames. It drives
 * a lightweight "syncing history" banner; the banner auto-dismisses a short
 * beat after the last frame so a busy multi-folder download stays visible but a
 * finished one does not linger.
 */
export function useSyncProgressBanner(): {
  syncProgress: SyncProgressPayload | null;
  handleSyncProgress: (next: SyncProgressPayload) => void;
} {
  const [syncProgress, setSyncProgress] = useState<SyncProgressPayload | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const handleSyncProgress = useCallback((next: SyncProgressPayload) => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setSyncProgress(next);
    clearTimerRef.current = window.setTimeout(() => setSyncProgress(null), 1_500);
  }, []);
  useEffect(() => () => {
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
  }, []);
  return { syncProgress, handleSyncProgress };
}
