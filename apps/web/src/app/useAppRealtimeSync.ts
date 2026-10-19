import { useCallback, useState } from "react";
import {
  useRealtimeSync,
  type RealtimeConnectionState,
  type RealtimeSyncOptions,
  type TaskProgressPayload,
  type TaskSettledPayload,
} from "../realtimeSync";
import type { MailStore } from "./mailStore";
import { useCloudSyncTasks, type CloudSyncTasks } from "./useCloudSyncTasks";

type AppRealtimeSyncOptions = Omit<RealtimeSyncOptions, "onTaskSettled" | "onTaskProgress" | "onMailChanged"> & {
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
 *
 * The cloud-sync list is composed here for the same reason: it reads the two
 * task frames, and this hook already owns the shell's one subscription to them.
 * A page could not mount a second `useRealtimeSync` to get its own — the stream
 * is one connection per shell — so the panel's list is fed from this routing
 * point, after the reconcile each frame also triggers.
 */
export function useAppRealtimeSync(options: AppRealtimeSyncOptions): {
  connectionState: RealtimeConnectionState;
  reconnect: () => void;
  threadRefreshTick: number;
  cloudSync: CloudSyncTasks;
} {
  const { store, ...rest } = options;
  const { onRefresh } = rest;
  const [threadRefreshTick, setThreadRefreshTick] = useState(0);
  const bumpThreadRefresh = useCallback(() => setThreadRefreshTick((value) => value + 1), []);
  const cloudSync = useCloudSyncTasks(rest.enabled);
  const { applyProgress, applySettled } = cloudSync;
  const onTaskProgress = useCallback((progress: TaskProgressPayload) => {
    applyProgress(progress);
  }, [applyProgress]);
  const onTaskSettled = useCallback((settled: TaskSettledPayload) => {
    bumpThreadRefresh();
    void store.reconcile("event").catch(() => undefined);
    applySettled(settled);
  }, [bumpThreadRefresh, store, applySettled]);
  const onMailChanged = useCallback(() => {
    bumpThreadRefresh();
    onRefresh();
  }, [bumpThreadRefresh, onRefresh]);
  const handle = useRealtimeSync({ ...rest, onTaskProgress, onTaskSettled, onMailChanged });
  return { ...handle, threadRefreshTick, cloudSync };
}
