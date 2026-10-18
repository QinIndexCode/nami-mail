import { useCallback, useState } from "react";
import {
  useRealtimeSync,
  type RealtimeConnectionState,
  type RealtimeSyncOptions,
} from "../realtimeSync";
import type { MailStore } from "./mailStore";

type AppRealtimeSyncOptions = Omit<RealtimeSyncOptions, "onTaskSettled" | "onMailChanged"> & {
  store: Pick<MailStore, "reconcile">;
};

/**
 * The shell's binding of the push stream to its own consequences.
 *
 * A settled task means the target state the server committed at acceptance is
 * now the provider's too, so the store reconciles instead of waiting for the
 * poll; a mail-changed frame is a write from outside this renderer (the Agent)
 * that has no optimistic state here, so a refresh is the only way it becomes
 * visible before the fallback poll. Both re-read the open conversation in case
 * a member was one of the rows that changed, which is why the tick lives here
 * rather than beside the thread panel.
 */
export function useAppRealtimeSync(options: AppRealtimeSyncOptions): {
  connectionState: RealtimeConnectionState;
  reconnect: () => void;
  threadRefreshTick: number;
} {
  const { store, ...rest } = options;
  const { onRefresh } = rest;
  const [threadRefreshTick, setThreadRefreshTick] = useState(0);
  const bumpThreadRefresh = useCallback(() => setThreadRefreshTick((value) => value + 1), []);
  const onTaskSettled = useCallback(() => {
    bumpThreadRefresh();
    void store.reconcile("event").catch(() => undefined);
  }, [bumpThreadRefresh, store]);
  const onMailChanged = useCallback(() => {
    bumpThreadRefresh();
    onRefresh();
  }, [bumpThreadRefresh, onRefresh]);
  const handle = useRealtimeSync({ ...rest, onTaskSettled, onMailChanged });
  return { ...handle, threadRefreshTick };
}
