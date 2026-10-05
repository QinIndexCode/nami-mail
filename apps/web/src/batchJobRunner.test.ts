import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchJobCreatePayload } from "./api";
import { createBatchJobRunner, type BatchJobRunnerDeps } from "./batchJobRunner";
import type * as apiModule from "./api";

const apiMocks = vi.hoisted(() => ({
  batchJobCreate: vi.fn(),
  batchJobStatus: vi.fn(),
  batchJobUndo: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      batchJobCreate: apiMocks.batchJobCreate,
      batchJobStatus: apiMocks.batchJobStatus,
      batchJobUndo: apiMocks.batchJobUndo,
    },
  };
});

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}${JSON.stringify(params)}` : key) as BatchJobRunnerDeps["t"];

function makeDeps(overrides: Partial<BatchJobRunnerDeps> = {}) {
  return {
    showToast: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    exitSelectionMode: vi.fn(),
    t,
    onSnapshot: vi.fn(),
    onBusy: vi.fn(),
    ...overrides,
  } satisfies BatchJobRunnerDeps;
}

const MOVE_PAYLOAD: BatchJobCreatePayload = { kind: "move", target: "trash", query: {} };
const RUN_OPTS = { successKey: "mail.selection.moved", exitOnSuccess: true };

function job(overrides: Record<string, unknown>) {
  return { id: "j1", kind: "move", total: 0, done: 0, updated: 0, failed: 0, createdAt: 1, ...overrides };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createBatchJobRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a job, reports the running snapshot, releases the busy flag and polls", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j1" });
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "running" }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);

      expect(deps.onBusy).toHaveBeenNthCalledWith(1, true);
      await flush();
      expect(deps.onBusy).toHaveBeenNthCalledWith(2, false);
      expect(deps.onSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "j1", status: "running" }));

      // First poll keeps the job visible and schedules the next tick.
      await vi.advanceTimersByTimeAsync(600);
      expect(deps.onSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "running" }));
      expect(deps.reload).not.toHaveBeenCalled();

      // Second poll sees the settled job and reconciles.
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "done", total: 3, done: 3, updated: 3 }) });
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.moved{\"count\":3}", "success", expect.objectContaining({ label: "mail.selection.undo" }));
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers undo and calling it triggers the server undo plus a silent reload", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j2" });
      apiMocks.batchJobUndo.mockResolvedValue(undefined);
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j2", status: "done", total: 2, done: 2, updated: 2 }) });

      runner.start(MOVE_PAYLOAD, { ...RUN_OPTS, exitOnSuccess: false });
      await vi.advanceTimersByTimeAsync(600);

      const successCall = showToast.mock.calls.find(([, kind]) => kind === "success");
      const action = successCall?.[2];
      expect(action).toBeDefined();
      action!.run();
      await flush();
      expect(apiMocks.batchJobUndo).toHaveBeenCalledWith("j2");
      expect(deps.reload).toHaveBeenCalledTimes(2);
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.undoStarted", "info");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports partial failure with an undo action and still reloads", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j3" });
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j3", status: "done", total: 5, done: 5, updated: 3, failed: 2 }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.showToast).toHaveBeenCalledWith(
        `mail.selection.partialFailure${JSON.stringify({ done: 3, failed: 2 })}`,
        "error",
        expect.objectContaining({ label: "mail.selection.undo" }),
      );
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps undo working from a progress-only snapshot (no changed ids on the wire)", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j7" });
      apiMocks.batchJobUndo.mockResolvedValue(undefined);
      // Exactly the server's progress contract. `changedIds` is a landmine
      // here: reading it means someone reintroduced the job's undo scope into
      // the payload the 600ms poll loop re-reads for minutes.
      const settled = { ...job({ id: "j7", status: "completed", total: 4, done: 4, updated: 4 }), undoWindowMs: 300_000 } as Record<string, unknown>;
      Object.defineProperty(settled, "changedIds", {
        enumerable: true,
        get() {
          throw new Error("the progress snapshot must not carry changedIds");
        },
      });
      apiMocks.batchJobStatus.mockResolvedValue({ job: settled });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);

      const successCall = showToast.mock.calls.find(([, kind]) => kind === "success");
      expect(successCall?.[2]).toEqual(expect.objectContaining({ label: "mail.selection.undo" }));
      successCall?.[2]?.run();
      await flush();

      // Undo is addressed by job id alone — the server already recorded what
      // the job changed — so it costs no extra round trip and reads no scope.
      expect(apiMocks.batchJobUndo).toHaveBeenCalledWith("j7");
      expect(apiMocks.batchJobStatus).toHaveBeenCalledTimes(1);
      expect(deps.reload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still undoes a partially failed job from the id alone", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j8" });
      apiMocks.batchJobUndo.mockResolvedValue(undefined);
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j8", status: "completed", total: 5, done: 5, updated: 3, failed: 2 }) });

      runner.start(MOVE_PAYLOAD, { ...RUN_OPTS, exitOnSuccess: false });
      await vi.advanceTimersByTimeAsync(600);

      const partialCall = showToast.mock.calls.find(([, kind]) => kind === "error");
      expect(partialCall?.[2]).toEqual(expect.objectContaining({ label: "mail.selection.undo" }));
      partialCall?.[2]?.run();
      await flush();

      // A job that updated some and failed some is still undoable in full: the
      // toast action is the same jobId-only call a clean success makes.
      expect(apiMocks.batchJobUndo).toHaveBeenCalledWith("j8");
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.undoStarted", "info");
      expect(deps.reload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the server-side failure reason and reloads", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j4" });
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j4", status: "failed", error: "boom" }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.showToast).toHaveBeenCalledWith("boom", "error");
      expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the runaway-polling budget instead of polling forever", async () => {
    let clock = 0;
    const deps = makeDeps({ now: () => clock });
    const runner = createBatchJobRunner(deps);
    apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j5" });
    apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j5", status: "running" }) });

    runner.start(MOVE_PAYLOAD, RUN_OPTS);
    await flush();

    // The budget measures elapsed time since the job started, not wall-clock now().
    clock = 11 * 60_000;
    runner.poll("j5", RUN_OPTS);
    await flush();

    expect(deps.showToast).toHaveBeenCalledWith("mail.selection.jobError", "error");
    expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
  });

  it("reports a create failure through the mail error mapping and settles", async () => {
    const showToast = vi.fn();
    const deps = makeDeps({ showToast });
    const runner = createBatchJobRunner(deps);
    apiMocks.batchJobCreate.mockRejectedValue(new Error("offline"));
    const onSettled = vi.fn();

    runner.start(MOVE_PAYLOAD, { ...RUN_OPTS, onSettled });
    await flush();

    expect(deps.onBusy).toHaveBeenNthCalledWith(1, true);
    expect(deps.onBusy).toHaveBeenNthCalledWith(2, false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(deps.showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe("error");
    expect(apiMocks.batchJobStatus).not.toHaveBeenCalled();
  });

  it("reports a poll error and settles", async () => {
    const deps = makeDeps();
    const runner = createBatchJobRunner(deps);
    apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j6" });
    apiMocks.batchJobStatus.mockRejectedValue(new Error("network"));
    const onSettled = vi.fn();

    runner.start(MOVE_PAYLOAD, { ...RUN_OPTS, onSettled });
    await flush();

    expect(deps.showToast).toHaveBeenCalledWith("mail.selection.jobError", "error");
    expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

