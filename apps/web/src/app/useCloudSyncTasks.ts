import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { DeliveryTask, DeliveryTaskList } from "../batchJobTypes";
import type { TaskProgressPayload, TaskSettledPayload } from "../realtimeSync";

/**
 * How long a burst of frames is allowed to coalesce into one re-read.
 *
 * The frames are hints, the read is the truth: a progress frame for a task this
 * hook has never fetched is a reason to re-read the list, and a burst of them
 * (a batch's first push reporting per chunk, or several tasks settling at once)
 * must not become one read each. Half a second is below the point a person
 * notices the list lagging and far above the frame rate.
 */
const REFETCH_COALESCE_MS = 500;

export type CloudSyncTasks = {
  /** Non-terminal rows, oldest first — what the panel's first section lists. */
  syncing: DeliveryTask[];
  /** Recent terminal rows that did not deliver, newest first. */
  attention: DeliveryTask[];
  /** The first read has not landed yet. */
  loading: boolean;
  /** The last read failed; the rows shown are the previous read's. */
  failed: boolean;
  /** Re-read now (the panel's retry button). */
  refresh: () => void;
  applyProgress: (progress: TaskProgressPayload) => void;
  applySettled: (settled: TaskSettledPayload) => void;
};

const EMPTY: DeliveryTaskList = { syncing: [], attention: [] };

/** The one row a progress frame can update. Everything else it could say is
 * already in the row (the account, the kind) or has no business being guessed
 * at from counters. */
function withProgress(list: DeliveryTaskList, progress: TaskProgressPayload): DeliveryTaskList {
  return {
    syncing: list.syncing.map((task) => task.id === progress.taskId
      ? { ...task, status: "running" as const, total: progress.total, updated: progress.updated, failed: progress.failed }
      : task),
    attention: list.attention,
  };
}

/**
 * Whether a settled task is one the panel lists.
 *
 * `completed` and `cancelled` are the two terminal statuses the server's own
 * projection keeps OUT of `attention` (its `nonProblems` set), so a frame
 * carrying one means the row is done with the panel entirely and can go now
 * instead of after the next read. The other two (`failed`, `unknown_delivery`)
 * belong in `attention`, but the row that lands there carries the error the
 * server recorded — so the read is what puts it there, not this hook guessing.
 */
function leavesThePanel(status: TaskSettledPayload["status"]): boolean {
  return status === "completed" || status === "cancelled";
}

/**
 * The in-flight cloud-sync set, as the rail panel reads it.
 *
 * The list has two sources and one authority. `GET /api/tasks` is the authority:
 * the server projects the durable `tasks` rows into "what is still owing a
 * provider write" plus "what recently ended without delivering", which is a
 * question no client can answer from frames alone — a task's first appearance
 * after an undo or an Agent write has no frame this renderer ever saw.
 *
 * The push frames are the low-latency half. A `task-progress` frame for a row
 * already shown is applied to that row in place (no read, no flicker); a
 * `task-settled` frame drops a delivered row immediately, and a frame for
 * anything else asks for a read. Both are debounced so a batch of frames costs
 * one read.
 *
 * A failed read keeps the rows it has: an emptied panel claims nothing is
 * syncing, which is a stronger and worse claim than "this read failed".
 */
export function useCloudSyncTasks(enabled: boolean): CloudSyncTasks {
  const [list, setList] = useState<DeliveryTaskList>(EMPTY);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  /** Ordering guard: reads can land out of order (a retry next to a scheduled one). */
  const epochRef = useRef(0);
  /** The pending coalesced read, 0 when none is scheduled. */
  const coalesceRef = useRef(0);
  /** The ids the last landed read returned, so a frame can tell news from noise. */
  const knownIdsRef = useRef(new Set<string>());

  const read = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const epoch = ++epochRef.current;
    try {
      const next = await api.taskList();
      if (epoch !== epochRef.current) return;
      knownIdsRef.current = new Set([...next.syncing, ...next.attention].map((task) => task.id));
      setList({ syncing: next.syncing, attention: next.attention });
      setFailed(false);
    } catch {
      if (epoch !== epochRef.current) return;
      setFailed(true);
    } finally {
      if (epoch === epochRef.current) setLoading(false);
    }
  }, [enabled]);

  const scheduleRead = useCallback((): void => {
    if (coalesceRef.current) return;
    coalesceRef.current = window.setTimeout(() => {
      coalesceRef.current = 0;
      void read();
    }, REFETCH_COALESCE_MS);
  }, [read]);

  const refresh = useCallback((): void => {
    // A manual retry does not wait behind a scheduled one: it supersedes it, so
    // the button always answers the click rather than a frame from a second ago.
    if (coalesceRef.current) {
      window.clearTimeout(coalesceRef.current);
      coalesceRef.current = 0;
    }
    void read();
  }, [read]);

  const applyProgress = useCallback((progress: TaskProgressPayload): void => {
    if (!knownIdsRef.current.has(progress.taskId)) {
      scheduleRead();
      return;
    }
    setList((current) => withProgress(current, progress));
  }, [scheduleRead]);

  const applySettled = useCallback((settled: TaskSettledPayload): void => {
    if (!leavesThePanel(settled.status)) {
      // The row stays until a read can put it in `attention` with the error the
      // server recorded. That read must not be overtaken by one that started
      // before the settlement and still reports the task as running: the epoch
      // turns the older read into a snapshot of a question already answered,
      // and the scheduled read replaces it with one taken after the frame.
      epochRef.current += 1;
      scheduleRead();
      return;
    }
    // A read already in flight may have snapshotted this task before it settled;
    // landing after this frame it would put the row back. The epoch turns that
    // read into a snapshot of a question already answered, and the scheduled
    // read replaces it with one taken after the settlement (which also refills
    // any row this frame did not mention).
    epochRef.current += 1;
    knownIdsRef.current.delete(settled.taskId);
    setList((current) => ({
      syncing: current.syncing.filter((task) => task.id !== settled.taskId),
      attention: current.attention.filter((task) => task.id !== settled.taskId),
    }));
    scheduleRead();
  }, [scheduleRead]);

  useEffect(() => {
    if (!enabled) {
      // Demo mode: there is no task layer behind it, and an empty list is the
      // truth rather than a stale one.
      epochRef.current += 1;
      knownIdsRef.current = new Set();
      setList(EMPTY);
      setLoading(false);
      setFailed(false);
      return undefined;
    }
    // Re-enabling starts from an empty list, so the spinner has to come back
    // with it: the list was cleared while disabled and the previous session's
    // failure banner has nothing left to describe.
    setLoading(true);
    setFailed(false);
    void read();
    return () => {
      if (coalesceRef.current) {
        window.clearTimeout(coalesceRef.current);
        coalesceRef.current = 0;
      }
      // A read that was already in flight when this effect tore down must not
      // land: its answer describes the mode/list the hook has just left. Bumping
      // the epoch makes the landing check at the top of `read` reject it.
      epochRef.current += 1;
    };
  }, [enabled, read]);

  return useMemo(
    () => ({ syncing: list.syncing, attention: list.attention, loading, failed, refresh, applyProgress, applySettled }),
    [applyProgress, applySettled, failed, list, loading, refresh],
  );
}
