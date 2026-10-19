// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../api";
import type { DeliveryTask, DeliveryTaskList } from "../batchJobTypes";
import { useCloudSyncTasks, type CloudSyncTasks } from "./useCloudSyncTasks";

const mocks = vi.hoisted(() => ({ taskList: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: { ...actual.api, taskList: mocks.taskList },
  };
});

function task(overrides: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    id: "t1",
    accountId: "acct-1",
    accountEmail: "me@example.com",
    kind: "move",
    scope: "batch",
    status: "running",
    total: 10,
    updated: 0,
    failed: 0,
    createdAt: 1,
    completedAt: null,
    dueAt: null,
    ...overrides,
  };
}

function list(syncing: DeliveryTask[], attention: DeliveryTask[] = []): DeliveryTaskList {
  return { syncing, attention };
}

/** A promise a test resolves by hand, for the out-of-order-read case. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let current: CloudSyncTasks;
let host: HTMLDivElement;
let root: Root;

function Harness({ enabled }: { enabled: boolean }) {
  current = useCloudSyncTasks(enabled);
  return null;
}

async function mount(enabled = true) {
  await act(async () => root.render(<Harness enabled={enabled} />));
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("useCloudSyncTasks", () => {
  it("asks the server for the in-flight set on mount", async () => {
    mocks.taskList.mockResolvedValue(list([task()], [task({ id: "t2", status: "failed", completedAt: 9 })]));

    await mount();

    // The read is the authority: no client can derive "what is still owing a
    // provider write" from frames alone (the first appearance after an undo or
    // an Agent write has no frame this renderer ever saw).
    expect(mocks.taskList).toHaveBeenCalledTimes(1);
    expect(current.syncing.map((row) => row.id)).toEqual(["t1"]);
    expect(current.attention.map((row) => row.id)).toEqual(["t2"]);
    expect(current.loading).toBe(false);
    expect(current.failed).toBe(false);
  });

  it("says a failed first read failed instead of claiming nothing is syncing", async () => {
    mocks.taskList.mockRejectedValueOnce(new Error("offline"));

    await mount();

    expect(current.failed).toBe(true);
    expect(current.loading).toBe(false);
    expect(current.syncing).toEqual([]);

    // The panel's retry is a plain re-read, and it clears the failure.
    mocks.taskList.mockResolvedValue(list([task()]));
    await act(async () => { current.refresh(); });
    expect(current.failed).toBe(false);
    expect(current.syncing).toHaveLength(1);
  });

  it("keeps the rows it has when a re-read fails", async () => {
    mocks.taskList.mockResolvedValueOnce(list([task()]));
    await mount();
    expect(current.syncing).toHaveLength(1);

    mocks.taskList.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { current.refresh(); });

    // An emptied panel would make a stronger and worse claim than "this read
    // failed": that nothing is left to deliver.
    expect(current.syncing).toHaveLength(1);
    expect(current.failed).toBe(true);
  });

  it("patches a listed row from a progress frame without re-reading", async () => {
    mocks.taskList.mockResolvedValue(list([task({ updated: 0 })]));
    await mount();

    await act(async () => {
      current.applyProgress({ accountId: "acct-1", taskId: "t1", total: 10, updated: 4, failed: 1 });
    });

    expect(current.syncing[0]).toMatchObject({ updated: 4, failed: 1, status: "running" });
    // A frame that names a row the panel already holds is the whole update: the
    // pull is the authority, but it has nothing to add to a counter it just read.
    expect(mocks.taskList).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of frames for unknown rows into one read", async () => {
    vi.useFakeTimers();
    mocks.taskList.mockResolvedValue(list([task()]));
    await mount();
    expect(mocks.taskList).toHaveBeenCalledTimes(1);

    // A frame for a row this renderer never fetched is news (a task started by
    // another writer), and a batch's first push can report per chunk: three
    // frames must not become three reads.
    await act(async () => {
      current.applyProgress({ accountId: "acct-2", taskId: "new-1", total: 5, updated: 1, failed: 0 });
      current.applyProgress({ accountId: "acct-2", taskId: "new-2", total: 5, updated: 1, failed: 0 });
      current.applyProgress({ accountId: "acct-2", taskId: "new-3", total: 5, updated: 1, failed: 0 });
    });
    expect(mocks.taskList).toHaveBeenCalledTimes(1);

    mocks.taskList.mockResolvedValue(list([task(), task({ id: "new-1" })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(mocks.taskList).toHaveBeenCalledTimes(2);
    expect(current.syncing.map((row) => row.id)).toEqual(["t1", "new-1"]);
  });

  it("drops a delivered row on its settle frame without waiting for a read", async () => {
    mocks.taskList.mockResolvedValue(list([task()]));
    await mount();

    await act(async () => {
      current.applySettled({ accountId: "acct-1", taskId: "t1", status: "completed" });
    });

    // `completed` and `cancelled` are exactly the statuses the server's
    // projection keeps out of both halves, so the row is done with the panel.
    expect(current.syncing).toEqual([]);
    expect(mocks.taskList).toHaveBeenCalledTimes(1);
  });

  it("asks the server for a failed row instead of inventing one", async () => {
    vi.useFakeTimers();
    mocks.taskList.mockResolvedValue(list([task()]));
    await mount();

    await act(async () => {
      current.applySettled({ accountId: "acct-1", taskId: "t1", status: "failed" });
    });
    // The row belongs in `attention` with the error the server recorded, so the
    // frame is only a hint -- guessing the row here would show a failure with no
    // diagnosis.
    expect(current.syncing).toHaveLength(1);
    expect(mocks.taskList).toHaveBeenCalledTimes(1);

    mocks.taskList.mockResolvedValue(list([], [task({ status: "failed", completedAt: 9, failed: 2 })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(mocks.taskList).toHaveBeenCalledTimes(2);
    expect(current.syncing).toEqual([]);
    expect(current.attention.map((row) => row.id)).toEqual(["t1"]);
  });

  it("cannot be overwritten by a read that started earlier but landed later", async () => {
    mocks.taskList.mockResolvedValueOnce(list([]));
    await mount();

    const older = deferred<DeliveryTaskList>();
    const newer = deferred<DeliveryTaskList>();
    mocks.taskList.mockReturnValueOnce(older.promise);
    mocks.taskList.mockReturnValueOnce(newer.promise);

    // Two reads in flight — a manual retry next to a scheduled one.
    await act(async () => { current.refresh(); });
    await act(async () => { current.refresh(); });

    await act(async () => { newer.resolve(list([task({ id: "newer" })])); });
    await act(async () => { older.resolve(list([task({ id: "older" })])); });

    // The late landing is a snapshot of a question already answered.
    expect(current.syncing.map((row) => row.id)).toEqual(["newer"]);
  });

  it("reports an empty set and reads nothing while disabled", async () => {
    await mount(false);

    // Demo mode has no task layer behind it, so an empty list is the truth
    // rather than a stale one.
    expect(mocks.taskList).not.toHaveBeenCalled();
    expect(current.syncing).toEqual([]);
    expect(current.loading).toBe(false);

    mocks.taskList.mockResolvedValue(list([task()]));
    await act(async () => root.render(<Harness enabled />));
    expect(mocks.taskList).toHaveBeenCalledTimes(1);
    expect(current.syncing).toHaveLength(1);
  });
});
