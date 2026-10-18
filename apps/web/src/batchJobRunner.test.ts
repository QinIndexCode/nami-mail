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
    reconcile: vi.fn().mockResolvedValue(undefined),
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
      // Armed before the server has named the job, so a second click inside the
      // create round trip cannot start a job the server would accept.
      expect(deps.onSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "", kind: "move", status: "running" }));
      await flush();
      expect(deps.onBusy).toHaveBeenNthCalledWith(2, false);
      expect(deps.onSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "j1", status: "running" }));
      expect(deps.reconcile).toHaveBeenCalledTimes(1);

      // First poll keeps the job visible and schedules the next tick. The id is
      // asserted, not just the ordinal: a tick that reported the placeholder
      // again (an unnamed job) would otherwise pass as the same snapshot.
      await vi.advanceTimersByTimeAsync(600);
      expect(deps.onSnapshot).toHaveBeenNthCalledWith(3, expect.objectContaining({ id: "j1", status: "running" }));
      expect(deps.reload).not.toHaveBeenCalled();

      // Second poll sees the settled job and reconciles.
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "completed", total: 3, done: 3, updated: 3 }) });
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.moved{\"count\":3}", "success", expect.objectContaining({ label: "mail.selection.undo" }));
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle a job the server still calls pending (G11: never settle early)", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j1" });
      // The alias decides the wire vocabulary, but this runner's own branch must
      // be an explicit settled list -- the old `status !== "running"` read would
      // call this a success and offer an undo for work nobody did (K5).
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "pending" }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ id: "j1", status: "pending" }));
      expect(deps.showToast).not.toHaveBeenCalled();
      expect(deps.reload).not.toHaveBeenCalled();
      expect(deps.exitSelectionMode).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles the committed local state the moment the job is accepted", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j1" });
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "running" }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      // Nothing has committed until the create resolves: the acceptance
      // transaction is what applies the selection, so there is nothing to pull
      // in before it, and the user's counters are still describing pre-commit
      // state for exactly as long as the remote push takes — tens of seconds on
      // a large selection.
      expect(deps.reconcile).not.toHaveBeenCalled();

      await flush();
      expect(deps.reconcile, "the commit landed with the acceptance").toHaveBeenCalledTimes(1);

      // Per-tick reconciliation would be pointless work: the counters were made
      // right at acceptance, and the next authoritative read is the settlement
      // reload. The list must also stay untouched while the job runs.
      await vi.advanceTimersByTimeAsync(1200);
      expect(deps.reconcile).toHaveBeenCalledTimes(1);
      expect(deps.reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles nothing when the job is never accepted", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockRejectedValue(new Error("offline"));

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();

      expect(deps.reconcile, "a refused create committed nothing to pull in").not.toHaveBeenCalled();
      expect(deps.onBusy).toHaveBeenLastCalledWith(false);
      // The placeholder the bar was armed with has to go: a job that was never
      // accepted must not leave the actions inert.
      expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
      expect(deps.showToast).toHaveBeenCalledWith(expect.any(String), "error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a batch that committed nothing from its own counts, without polling", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const onSettled = vi.fn();
      const runner = createBatchJobRunner(deps);
      // The selection was already in the requested state, so the acceptance
      // committed no task: the route answers a null id with its own counts.
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: null, updated: 7, failed: 0 });

      runner.start(MOVE_PAYLOAD, { ...RUN_OPTS, onSettled });
      await flush();

      // Polling the null id would 404 and toast a job error for a batch that
      // did exactly what was asked.
      await vi.advanceTimersByTimeAsync(2400);
      expect(apiMocks.batchJobStatus).not.toHaveBeenCalled();
      // Two arguments, not three: no undo action, because the acceptance
      // committed no task to open an undo window on.
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.moved{\"count\":7}", "success");
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
      expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
      expect(deps.onBusy).toHaveBeenLastCalledWith(false);
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
      // "Committed nothing" is still a batch that settled: `onSettled` is what
      // releases the pins into the refresh (see BatchJobRunOptions), so a batch
      // that skipped it would leave them armed with nothing left to clear them.
      expect(onSettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a zero-work batch's refusals as the partial failure they are", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);
      // Every id was blocked by an unconfirmed move: nothing to push, nothing
      // committed, and the user still has to be told the batch did not apply.
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: null, updated: 0, failed: 4 });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();

      expect(apiMocks.batchJobStatus).not.toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.partialFailure{\"done\":0,\"failed\":4}", "error");
      // Nothing applied, so the selection mode stays armed for the user to try
      // again — the same rule the partial-failure path follows.
      expect(deps.exitSelectionMode).not.toHaveBeenCalled();
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the bar before the server names the job", async () => {
    vi.useFakeTimers();
    try {
      let assignJobId!: (value: { jobId: string }) => void;
      apiMocks.batchJobCreate.mockImplementation(() => new Promise((resolve) => { assignJobId = resolve; }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "running" }) });
      const deps = makeDeps();
      const runner = createBatchJobRunner(deps);

      runner.start(MOVE_PAYLOAD, RUN_OPTS);

      // Mid-round-trip: this is the window a double click lands in, and nothing
      // else would have marked a batch as under way. The empty id is what says
      // this is the placeholder rather than a job the server has named.
      expect(deps.onBusy).toHaveBeenLastCalledWith(true);
      expect(deps.onSnapshot).toHaveBeenCalledTimes(1);
      expect(deps.onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ id: "", kind: "move", status: "running" }));

      assignJobId({ jobId: "j1" });
      await flush();

      // The server's id takes over that placeholder rather than adding a job.
      // (Later ticks of the poll loop may report the same job again.)
      expect(deps.onSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "j1", status: "running" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps running the job when the acceptance-time reconcile fails", async () => {
    vi.useFakeTimers();
    try {
      // The reconcile is a convenience read of state the server already holds;
      // the settlement reload is the authority. A platform refresh that fails —
      // or throws before it even returns a promise — must not stop the poll,
      // drop the job, or surface an unhandled rejection.
      const deps = makeDeps({ reconcile: vi.fn().mockRejectedValue(new Error("offline")) });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j1" });
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "completed", total: 2, done: 2, updated: 2 }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.onSnapshot).toHaveBeenLastCalledWith(null);
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.moved{\"count\":2}", "success", expect.objectContaining({ label: "mail.selection.undo" }));
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });

      const throwing = makeDeps({ reconcile: (() => { throw new Error("offline"); }) as BatchJobRunnerDeps["reconcile"] });
      const throwingRunner = createBatchJobRunner(throwing);
      throwingRunner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      expect(throwing.onSnapshot, "a synchronous throw is the same non-event").toHaveBeenLastCalledWith(null);
      expect(throwing.reload).toHaveBeenCalledWith({ silent: true });
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
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j2", status: "completed", total: 2, done: 2, updated: 2 }) });

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

  it("follows the inverse tasks before reloading, so the undo lands in the UI", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reload = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reload });
      const runner = createBatchJobRunner(deps);
      let inverseFinished = false;
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j9" });
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "j9" ? "completed" : inverseFinished ? "completed" : "running", total: 2, updated: 2 }),
      }));
      apiMocks.batchJobUndo.mockImplementation(async () => {
        setTimeout(() => { inverseFinished = true; }, 1500);
        return { ok: true, taskIds: ["undo-9"] };
      });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);
      const undo = showToast.mock.calls.find(([, kind]) => kind === "success")?.[2];
      expect(undo).toBeDefined();
      const beforeUndo = reload.mock.calls.length;

      undo!.run();
      // The POST only ACCEPTS the inverse tasks. Reloading here would snapshot
      // the pre-undo list and the undo would look like it did nothing.
      await vi.advanceTimersByTimeAsync(600);
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-9");
      expect(reload.mock.calls.length, "the undo POST alone must not reconcile").toBe(beforeUndo);

      // The inverse tasks finish 1.5s in; the follow-up poll reconciles then.
      await vi.advanceTimersByTimeAsync(1800);
      expect(reload.mock.calls.length).toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for every inverse task of a cross-account undo before reloading", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reload = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reload });
      const runner = createBatchJobRunner(deps);
      // Two accounts, so the reverse is two tasks and the answer names both
      // (§4.7 A ⑨). The second settles a full poll later than the first: a
      // follow-up that reloaded on the first would show one account reverted.
      const settled = new Set<string>();
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j11" });
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "j11" || settled.has(id) ? "completed" : "running", total: 2, updated: 2 }),
      }));
      apiMocks.batchJobUndo.mockImplementation(async () => {
        setTimeout(() => settled.add("undo-a"), 600);
        setTimeout(() => settled.add("undo-b"), 1200);
        return { ok: true, taskIds: ["undo-a", "undo-b"] };
      });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reload.mock.calls.length;
      showToast.mock.calls.find(([, kind]) => kind === "success")?.[2]!.run();
      await flush();
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-a");
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-b");

      // Past the first task's settlement but not the second's.
      await vi.advanceTimersByTimeAsync(800);
      expect(reload.mock.calls.length, "one of two inverse tasks is still running").toBe(beforeUndo);
      await vi.advanceTimersByTimeAsync(1400);
      expect(reload.mock.calls.length).toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a single failed status read as a blip, not as the inverse task settling", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reload = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reload });
      const runner = createBatchJobRunner(deps);
      let inverseReads = 0;
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j14" });
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => {
        if (id !== "j14") {
          inverseReads += 1;
          // A read can fail transiently -- a blip, a restart in progress. The
          // first one fails and the next one answers.
          if (inverseReads === 1) throw new Error("blip");
        }
        return { job: job({ id, status: id === "j14" || inverseReads > 1 ? "completed" : "running", total: 1, updated: 1 }) };
      });
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-blip"] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reload.mock.calls.length;
      showToast.mock.calls.find(([, kind]) => kind === "success")?.[2]!.run();
      // The first read has failed by now; the follow-up has rescheduled itself.
      await flush();

      // Giving up on the first failure would reload the pre-undo list, which is
      // the "undo looks inert" symptom the tolerance exists to remove: the reverse
      // is still running server-side at that point.
      expect(reload.mock.calls.length, "a single failed read must not count as settled").toBe(beforeUndo);

      // The next read answers, and that one does settle the follow-up.
      await vi.advanceTimersByTimeAsync(1200);
      expect(reload.mock.calls.length).toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops following an inverse task that never reports terminal, instead of following forever", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reload = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reload });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j15" });
      // The batch settles at once; its reverse never does.
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "j15" ? "completed" : "running", total: 1, updated: 1 }),
      }));
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-stuck"] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reload.mock.calls.length;
      showToast.mock.calls.find(([, kind]) => kind === "success")?.[2]!.run();
      await flush();

      // The follow-up has its own budget, and it is the only thing that ends a
      // reverse whose task row is stuck in `running`: without it the view would
      // keep the pre-undo list for as long as the page lives.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1200);
      expect(reload.mock.calls.length, "the stuck reverse must still reconcile, once").toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles immediately when the undo answer carries no task ids", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reload = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reload });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue({ jobId: "j10" });
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j10", status: "completed", total: 1, updated: 1 }) });
      apiMocks.batchJobUndo.mockResolvedValue({ ok: false, reason: "expired" });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reload.mock.calls.length;
      showToast.mock.calls.find(([, kind]) => kind === "success")?.[2]!.run();
      await flush();

      // Nothing to follow, so the only way to show what the server holds is to
      // ask it now.
      expect(reload.mock.calls.length).toBe(beforeUndo + 1);
      expect(apiMocks.batchJobStatus).not.toHaveBeenCalledWith("undo-10");
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
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j3", status: "completed", total: 5, done: 5, updated: 3, failed: 2 }) });

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

    // Both snapshots of a job are stamped by the same clock: the placeholder the
    // bar is armed with and the one the server's id lands in describe one job, so
    // neither may reach for wall-clock time behind the injected clock's back.
    expect(deps.onSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "", createdAt: 0 }));
    expect(deps.onSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "j5", createdAt: 0 }));

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

