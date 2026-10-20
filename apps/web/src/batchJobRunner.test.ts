import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type BatchJobCreatePayload } from "./api";
import { createBatchJobRunner, type BatchJobRunOptions, type BatchJobRunnerDeps } from "./batchJobRunner";
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
    onBusy: vi.fn(),
    ...overrides,
  } satisfies BatchJobRunnerDeps;
}

const MOVE_PAYLOAD: BatchJobCreatePayload = { kind: "move", target: "trash", query: {} };
const RUN_OPTS = { successKey: "mail.selection.moved", exitOnSuccess: true };

/** Run options with a release spy of their own: the release belongs to the
 *  batch, and each batch in a test must be observable on its own. */
function runOpts(overrides: Partial<BatchJobRunOptions> = {}) {
  return { ...RUN_OPTS, onDeliverySettled: vi.fn(), ...overrides };
}

function job(overrides: Record<string, unknown>) {
  return { id: "j1", kind: "move", total: 0, done: 0, updated: 0, failed: 0, createdAt: 1, ...overrides };
}

/** An accepted batch: the create's counts are the acceptance's own arithmetic. */
function accepted(overrides: Record<string, unknown> = {}) {
  return { ok: true, jobId: "j1", updated: 3, failed: 0, ...overrides };
}

/**
 * Lets every already-resolved promise chain run without advancing the clock: the
 * acceptance path (create → report → start watching → first status read) is all
 * microtasks, and a test that asserted after only two of them would be reading a
 * half-run chain.
 */
async function flush() {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

/** The toast the acceptance put on screen, with the action it offered. */
function successToast(showToast: ReturnType<typeof vi.fn>) {
  const call = showToast.mock.calls.find(([, kind]) => kind === "success");
  return { call, action: call?.[2] as { label: string; run: () => void } | undefined };
}

describe("createBatchJobRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the committed half the moment the server accepts, and only then watches the push", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j1", updated: 3 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "running" }) });

      runner.start(MOVE_PAYLOAD, opts);
      expect(deps.onBusy).toHaveBeenNthCalledWith(1, true);

      // Everything the user can see is settled by the create's own counts: the
      // push has not been followed yet and nothing may wait for it.
      await flush();
      expect(deps.onBusy).toHaveBeenNthCalledWith(2, false);
      expect(deps.showToast).toHaveBeenCalledWith(
        "mail.selection.moved{\"count\":3}",
        "success",
        expect.objectContaining({ label: "mail.selection.undo" }),
      );
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
      expect(deps.reconcile, "the acceptance committed the state on screen").toHaveBeenCalledTimes(1);
      expect(deps.reload, "the list is reconciled at settlement, not at acceptance").not.toHaveBeenCalled();
      expect(opts.onDeliverySettled).not.toHaveBeenCalled();

      // The push is being followed — that is the only thing left running.
      await vi.advanceTimersByTimeAsync(600);
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("j1");
      expect(deps.reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report an accepted batch a second time when its delivery lands", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j1", updated: 3 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "completed", total: 3, updated: 3 }) });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      await vi.advanceTimersByTimeAsync(600);

      // A delivery that lands says nothing: the toast the user saw WAS the
      // outcome, and the refresh is only there to make the destination side of a
      // move's counters agree with the server.
      expect(deps.showToast).toHaveBeenCalledTimes(1);
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the delivery's terminal state instead of treating an unknown status as finished", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j1" }));
      // The alias decides the wire vocabulary, but this runner's own branch must
      // be an explicit settled list -- the old `status !== "running"` read would
      // call this finished and reload over a push that is still going (K5).
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j1", status: "pending" }) });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      await vi.advanceTimersByTimeAsync(1800);

      expect(deps.reload).not.toHaveBeenCalled();
      expect(opts.onDeliverySettled).not.toHaveBeenCalled();
      expect(apiMocks.batchJobStatus.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a batch that committed nothing from its own counts, without watching anything", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      // The selection was already in the requested state, so the acceptance
      // committed no task: the route answers a null id with its own counts.
      apiMocks.batchJobCreate.mockResolvedValue({ ok: true, jobId: null, updated: 7, failed: 0 });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      await vi.advanceTimersByTimeAsync(2400);

      // Polling the null id would 404 and toast a delivery failure for a batch
      // that did exactly what was asked.
      expect(apiMocks.batchJobStatus).not.toHaveBeenCalled();
      // No third argument: no undo, because the acceptance committed no task to
      // open an undo window on.
      expect(deps.showToast).toHaveBeenCalledWith("mail.selection.moved{\"count\":7}", "success", undefined);
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
      expect(deps.onBusy).toHaveBeenLastCalledWith(false);
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
      // "Committed nothing" is still a batch that settled: the release is what
      // hands the pins to the refresh (see BatchJobRunOptions), so a batch that
      // skipped it would leave them armed with nothing left to clear them.
      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);
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
      apiMocks.batchJobCreate.mockResolvedValue({ ok: true, jobId: null, updated: 0, failed: 4 });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();

      expect(apiMocks.batchJobStatus).not.toHaveBeenCalled();
      expect(deps.showToast).toHaveBeenCalledWith(
        "mail.selection.partialFailure{\"done\":0,\"failed\":4}",
        "error",
        undefined,
      );
      // Nothing applied, so selection mode stays armed for the user to try again.
      expect(deps.exitSelectionMode).not.toHaveBeenCalled();
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a partial failure at acceptance with an undo for the rows that did land", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j3", updated: 3, failed: 2 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j3", status: "running" }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();

      expect(showToast).toHaveBeenCalledWith(
        `mail.selection.partialFailure${JSON.stringify({ done: 3, failed: 2 })}`,
        "error",
        expect.objectContaining({ label: "mail.selection.undo" }),
      );
      expect(successToast(showToast).call, "a partial failure is not also a success").toBeUndefined();
      // Something did land, so the action is over as far as the selection goes.
      expect(deps.exitSelectionMode).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a refused create and releases the pins it optimistically set", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const opts = runOpts();
      const reload = vi.fn(async () => {
        // A pin still armed here would re-apply the optimistic value over the
        // rollback the read is about to show.
        expect(opts.onDeliverySettled, "the pins come off before the read").toHaveBeenCalledTimes(1);
      });
      const deps = makeDeps({ showToast, reload });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockRejectedValue(new Error("offline"));

      runner.start(MOVE_PAYLOAD, opts);
      await flush();

      // A refused create started no delivery, so the release happens here
      // rather than through the watch's usual path.
      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);
      // The caller had already applied its optimistic half to every loaded page,
      // and the first-page-only reconcile would leave pages 2+ wrong; the full
      // read is what settles whether the request was refused or merely lost on
      // the way back, and it covers every row either way.
      expect(reload).toHaveBeenCalledWith({ silent: true });
      expect(deps.reconcile, "a first-page read cannot undo the later pages").not.toHaveBeenCalled();
      expect(deps.onBusy).toHaveBeenNthCalledWith(1, true);
      expect(deps.onBusy).toHaveBeenNthCalledWith(2, false);
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(showToast.mock.calls[0][1]).toBe("error");
      expect(apiMocks.batchJobStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still offers its undo when the push was refused, because the commit is what an undo reverses", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j4", updated: 5 }));
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "j4" ? "failed" : "completed", total: 5, updated: 5, error: "boom" }),
      }));
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-4"] });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      const undo = successToast(showToast).action;
      await vi.advanceTimersByTimeAsync(600);

      // The local commit stands, so the sentence has to name the half that
      // broke -- and the server's own text is the only diagnosis of the cause.
      expect(showToast).toHaveBeenCalledWith(
        `mail.selection.deliveryFailed${JSON.stringify({ count: 5 })} boom`,
        "error",
      );
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });
      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);

      // The refused push is undoable, and refusing the click here is what the
      // old code did: `undoRefusal` required a `completed` parent, while a job
      // whose members span accounts routinely ends with one account failed. The
      // write the undo reverses was committed before the push ran.
      undo!.run();
      await flush();

      expect(apiMocks.batchJobUndo).toHaveBeenCalledWith("j4");
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-4");
      // The reverse's own settlement is the only place the click learns whether
      // the messages came back: the acceptance toast it came from is dismissed by
      // the click itself.
      expect(showToast).toHaveBeenCalledWith("mail.selection.undoDone", "success", undefined, { feedback: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats cancelled and unknown_delivery as settled deliveries", async () => {
    for (const status of ["cancelled", "unknown_delivery"]) {
      vi.useFakeTimers();
      try {
        const deps = makeDeps();
        const opts = runOpts();
        const runner = createBatchJobRunner(deps);
        apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: `j-${status}`, updated: 2 }));
        apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: `j-${status}`, status, total: 2, updated: 2 }) });

        runner.start(MOVE_PAYLOAD, opts);
        await flush();
        await vi.advanceTimersByTimeAsync(600);

        expect(opts.onDeliverySettled, `${status} must end the watch`).toHaveBeenCalledTimes(1);
        expect(deps.reload).toHaveBeenCalledWith({ silent: true });
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("tolerates a read blip and gives up only after three consecutive failures", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      let reads = 0;
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j6", updated: 2 }));
      apiMocks.batchJobStatus.mockImplementation(async () => {
        reads += 1;
        // A read can fail transiently -- a blip, a restart in progress. One
        // failed read used to end the watch with "the outcome is unknown" while
        // the push was in fact fine.
        throw new Error("blip");
      });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      // The acceptance's own read is the first failure; the loop has rescheduled.
      await vi.advanceTimersByTimeAsync(600);

      expect(reads, "two failures are not an outcome").toBe(2);
      expect(deps.showToast, "only the acceptance's toast").toHaveBeenCalledTimes(1);
      expect(opts.onDeliverySettled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(reads).toBe(3);
      expect(deps.showToast).toHaveBeenLastCalledWith("mail.selection.deliveryUnknown", "error");
      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);
      expect(deps.reload, "a watch that gave up is not a report about the server").not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the runaway budget instead of watching a push forever", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const deps = makeDeps({ now: () => clock });
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j5", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j5", status: "running" }) });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();

      // The budget measures elapsed time since the batch was accepted, so the
      // deadline is stamped once per job and never re-based by a later tick.
      clock = 11 * 60_000;
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.showToast).toHaveBeenLastCalledWith("mail.selection.deliveryUnknown", "error");
      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);
      const afterGiveUp = apiMocks.batchJobStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(apiMocks.batchJobStatus, "the loop must not reschedule itself").toHaveBeenCalledTimes(afterGiveUp);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps watching when the acceptance-time reconcile fails", async () => {
    vi.useFakeTimers();
    try {
      // The reconcile is a convenience read of state the server already holds;
      // the settlement reload is the authority. A platform refresh that fails --
      // or throws before it even returns a promise -- must not stop the watch.
      const deps = makeDeps({ reconcile: vi.fn().mockRejectedValue(new Error("offline")) });
      const opts = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j7", updated: 2 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j7", status: "completed", total: 2, updated: 2 }) });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      await vi.advanceTimersByTimeAsync(600);

      expect(opts.onDeliverySettled).toHaveBeenCalledTimes(1);
      expect(deps.reload).toHaveBeenCalledWith({ silent: true });

      const throwing = makeDeps({ reconcile: (() => { throw new Error("offline"); }) as BatchJobRunnerDeps["reconcile"] });
      const throwingOpts = runOpts();
      const throwingRunner = createBatchJobRunner(throwing);
      throwingRunner.start(MOVE_PAYLOAD, throwingOpts);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      expect(throwingOpts.onDeliverySettled, "a synchronous throw is the same non-event").toHaveBeenCalledTimes(1);
      expect(throwing.reload).toHaveBeenCalledWith({ silent: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the pins exactly once per delivery, before the settling reload", async () => {
    vi.useFakeTimers();
    try {
      // Order is the whole point: a pin still armed through the refresh would
      // keep a refused row looking applied, which is what the release exists to
      // prevent (see useBatchSelection).
      const order: string[] = [];
      const deps = makeDeps({
        reload: vi.fn(async () => { order.push("reload"); }),
      });
      const opts = runOpts({ onDeliverySettled: () => { order.push("release"); } });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j8", updated: 2 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j8", status: "completed", total: 2, updated: 2 }) });

      runner.start(MOVE_PAYLOAD, opts);
      await flush();
      await vi.advanceTimersByTimeAsync(1800);

      expect(order).toEqual(["release", "reload"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases only the batch whose delivery ended when two are being watched", async () => {
    vi.useFakeTimers();
    try {
      // Batches overlap by design (the toolbar releases at acceptance). The
      // release belongs to the batch, not to the runner: a shared slot would let
      // the first settlement consume the second batch's pins, dropping rows out
      // of the list while their push was still running.
      const deps = makeDeps();
      const first = runOpts();
      const second = runOpts();
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "first" ? "completed" : "running", total: 1, updated: 1 }),
      }));

      runner.followDelivery("first", first);
      runner.followDelivery("second", second);
      await flush();
      await vi.advanceTimersByTimeAsync(600);

      expect(first.onDeliverySettled).toHaveBeenCalledTimes(1);
      expect(second.onDeliverySettled, "the still-running batch keeps its pins").not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds an undo click until the delivery ends, then follows the inverse tasks", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reconcile = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reconcile });
      const runner = createBatchJobRunner(deps);
      let batchDelivered = false;
      let inverseFinished = false;
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j9", updated: 2 }));
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({
          id,
          status: id === "undo-9" ? (inverseFinished ? "completed" : "running") : batchDelivered ? "completed" : "running",
          total: 2,
          updated: 2,
        }),
      }));
      apiMocks.batchJobUndo.mockImplementation(async () => {
        setTimeout(() => { inverseFinished = true; }, 1500);
        return { ok: true, taskIds: ["undo-9"] };
      });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      const undo = successToast(showToast).action;
      expect(undo).toBeDefined();

      // A click while the push is still running: the server refuses to undo work
      // that has not finished, so the POST waits rather than being refused for a
      // batch the user just watched commit.
      undo!.run();
      await flush();
      expect(showToast).toHaveBeenCalledWith("mail.selection.undoStarted", "info", undefined, { feedback: true });
      expect(apiMocks.batchJobUndo).not.toHaveBeenCalled();

      // The batch's delivery lands; the held click goes through now.
      batchDelivered = true;
      await vi.advanceTimersByTimeAsync(600);
      await flush();
      expect(apiMocks.batchJobUndo).toHaveBeenCalledWith("j9");

      // The POST only ACCEPTS the inverse. Reading the list here would snapshot
      // the pre-undo state and the undo would look like it did nothing.
      const beforeUndo = reconcile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600);
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-9");
      expect(reconcile.mock.calls.length, "the undo POST alone must not reconcile").toBe(beforeUndo);

      await vi.advanceTimersByTimeAsync(1800);
      // `reconcile` and not the full `reload`: the undo puts back rows the list is
      // already showing, and a full load would collapse the pages the user is
      // reading.
      expect(reconcile.mock.calls.length).toBe(beforeUndo + 1);
      expect(deps.reload, "the undo must not collapse the loaded pages").toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith("mail.selection.undoDone", "success", undefined, { feedback: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for every inverse task of a cross-account undo before reconciling", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reconcile = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reconcile });
      const runner = createBatchJobRunner(deps);
      // Two accounts, so the reverse is two tasks and the answer names both
      // (§4.7 A ⑨). The second settles a full poll later than the first: a
      // follow-up that reconciled on the first would show one account reverted.
      const settled = new Set<string>();
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j11", updated: 2 }));
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "j11" || settled.has(id) ? "completed" : "running", total: 2, updated: 2 }),
      }));
      apiMocks.batchJobUndo.mockImplementation(async () => {
        setTimeout(() => settled.add("undo-a"), 600);
        setTimeout(() => settled.add("undo-b"), 1200);
        return { ok: true, taskIds: ["undo-a", "undo-b"] };
      });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reconcile.mock.calls.length;
      successToast(showToast).action!.run();
      await flush();
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-a");
      expect(apiMocks.batchJobStatus).toHaveBeenCalledWith("undo-b");

      // Past the first task's settlement but not the second's.
      await vi.advanceTimersByTimeAsync(800);
      expect(reconcile.mock.calls.length, "one of two inverse tasks is still running").toBe(beforeUndo);
      await vi.advanceTimersByTimeAsync(1400);
      expect(reconcile.mock.calls.length).toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the entries a reverse could not put back, and not a success it cannot claim", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j16", updated: 2 }));
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({
          id,
          // The reverse ran and latched one of its two entries failed: the
          // messages are split, and the click owes the user that number.
          status: "completed",
          total: 2,
          updated: 1,
          failed: id === "undo-partial" ? 1 : 0,
        }),
      }));
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-partial", "undo-clean"] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      successToast(showToast).action!.run();
      await flush();

      expect(showToast).toHaveBeenCalledWith(
        `mail.selection.undoPartialFailure${JSON.stringify({ count: 1 })}`,
        "error",
        undefined,
        { feedback: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the undo's outcome is unknown when a reverse ended without counting anything", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j17", updated: 2 }));
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({
          id,
          // Terminal with nothing through it: the reverse never ran at all (an
          // account it could not reach), so no entry was counted and nothing can
          // be promised -- `failed: 0` is not evidence of success here.
          status: id === "undo-aborted" ? "failed" : "completed",
          total: 2,
          updated: id === "undo-aborted" ? 0 : 2,
          failed: 0,
        }),
      }));
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-aborted"] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      successToast(showToast).action!.run();
      await flush();

      expect(showToast).toHaveBeenCalledWith("mail.selection.undoUnknown", "warning", undefined, { feedback: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a single failed status read as a blip, not as the inverse task settling", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reconcile = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reconcile });
      const runner = createBatchJobRunner(deps);
      let inverseReads = 0;
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j14", updated: 1 }));
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => {
        if (id !== "j14") {
          inverseReads += 1;
          if (inverseReads === 1) throw new Error("blip");
        }
        return { job: job({ id, status: id === "j14" || inverseReads > 1 ? "completed" : "running", total: 1, updated: 1 }) };
      });
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-blip"] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reconcile.mock.calls.length;
      successToast(showToast).action!.run();
      // The first read has failed by now; the follow-up has rescheduled itself.
      await flush();

      // Giving up on the first failure would reconcile the pre-undo list, which is
      // the "undo looks inert" symptom the tolerance exists to remove: the
      // reverse is still running server-side at that point.
      expect(reconcile.mock.calls.length, "a single failed read must not count as settled").toBe(beforeUndo);

      await vi.advanceTimersByTimeAsync(1200);
      expect(reconcile.mock.calls.length).toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops following an inverse task that never reports terminal, instead of following forever", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reconcile = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reconcile });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j15", updated: 1 }));
      // The batch settles at once; its reverse never does.
      apiMocks.batchJobStatus.mockImplementation(async (id: string) => ({
        job: job({ id, status: id === "j15" ? "completed" : "running", total: 1, updated: 1 }),
      }));
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: ["undo-stuck"] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reconcile.mock.calls.length;
      successToast(showToast).action!.run();
      await flush();

      // The follow-up has its own budget, and it is the only thing that ends a
      // reverse whose task row is stuck in `running`: without it the view would
      // keep the pre-undo list for as long as the page lives. The read still
      // happens -- the budget ends the follow-up, not the user's only way to see
      // what the server holds -- and what it cannot say is whether the messages
      // came back.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1200);
      expect(reconcile.mock.calls.length, "the stuck reverse must still reconcile, once").toBe(beforeUndo + 1);
      expect(showToast).toHaveBeenCalledWith("mail.selection.undoUnknown", "warning", undefined, { feedback: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles and reports done when the undo answer carries no task ids", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reconcile = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reconcile });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j10", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j10", status: "completed", total: 1, updated: 1 }) });
      // The server's own reading of "no ids": every entry's inverse was already
      // in force, so the reverse had no work to commit. That is a success, and
      // answering it with silence is what the empty-list branch exists to avoid.
      apiMocks.batchJobUndo.mockResolvedValue({ ok: true, taskIds: [] });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reconcile.mock.calls.length;
      successToast(showToast).action!.run();
      await flush();
      await vi.advanceTimersByTimeAsync(600);

      // Nothing to follow, so the only way to show what the server holds is to
      // ask it now.
      expect(reconcile.mock.calls.length).toBe(beforeUndo + 1);
      expect(showToast).toHaveBeenCalledWith("mail.selection.undoDone", "success", undefined, { feedback: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a refusal with the sentence that belongs to its reason", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j18", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j18", status: "completed", total: 1, updated: 1 }) });
      // The refusal is a 409 carrying the route's own `reason`, which is the only
      // place the difference between these words survives: the status code is the
      // same for six of the seven.
      apiMocks.batchJobUndo.mockRejectedValue(
        new ApiError("无法撤销该批量任务。", "conflict", 409, undefined, "already_undone"),
      );

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      successToast(showToast).action!.run();
      await flush();

      expect(showToast).toHaveBeenCalledWith("mail.selection.undoAlreadyDone", "error");
      expect(showToast, "the generic batch text is the fallback, not the answer").not.toHaveBeenCalledWith(
        "mail.selection.jobError",
        "error",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the generic text for a refusal word this bundle does not know", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const deps = makeDeps({ showToast });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j19", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j19", status: "completed", total: 1, updated: 1 }) });
      // A server newer than this bundle may refuse for a reason that did not
      // exist when it was built; saying nothing is worse than the generic line.
      apiMocks.batchJobUndo.mockRejectedValue(
        new ApiError("无法撤销该批量任务。", "conflict", 409, undefined, "some_future_reason"),
      );

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      successToast(showToast).action!.run();
      await flush();

      expect(showToast).toHaveBeenCalledWith("mail.selection.jobError", "error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed undo POST through the job error mapping, and reconciles any refusal", async () => {
    vi.useFakeTimers();
    try {
      const showToast = vi.fn();
      const reconcile = vi.fn(async () => undefined);
      const deps = makeDeps({ showToast, reconcile });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j12", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j12", status: "completed", total: 1, updated: 1 }) });
      // A rejection with no `reason` at all: a transport failure, a 500, a wedged
      // service. There is nothing to say about the job, so the generic line is
      // the answer.
      apiMocks.batchJobUndo.mockRejectedValue(new Error("offline"));

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      const beforeUndo = reconcile.mock.calls.length;
      successToast(showToast).action!.run();
      await flush();

      expect(showToast).toHaveBeenCalledWith("mail.selection.jobError", "error");
      // A refused undo can still have changed what the list should show (a
      // member reversed before the refusal was met), so the read happens here
      // too -- exactly once, and after the POST, never instead of it.
      expect(reconcile.mock.calls.length).toBe(beforeUndo + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets an outcome once the server's undo window has closed", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const showToast = vi.fn();
      const deps = makeDeps({ showToast, now: () => clock });
      const runner = createBatchJobRunner(deps);
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j13", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j13", status: "completed", total: 1, updated: 1 }) });

      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();
      await vi.advanceTimersByTimeAsync(600);
      const staleUndo = successToast(showToast).action;

      // Past the server's own undo window, the entry nothing can read again is
      // dropped, and the next acceptance is where that sweep happens (the only
      // moment the map can grow).
      clock = 6 * 60_000;
      apiMocks.batchJobCreate.mockResolvedValue(accepted({ jobId: "j14b", updated: 1 }));
      apiMocks.batchJobStatus.mockResolvedValue({ job: job({ id: "j14b", status: "completed", total: 1, updated: 1 }) });
      runner.start(MOVE_PAYLOAD, RUN_OPTS);
      await flush();

      // Dropping the entry does not drop the question: the POST still goes out,
      // and the server's own `expired` beats this client's guess at which of the
      // seven refusals applies. What the sweep buys is memory, not silence.
      apiMocks.batchJobUndo.mockRejectedValue(
        new ApiError("无法撤销该批量任务。", "conflict", 409, undefined, "expired"),
      );
      staleUndo!.run();
      await flush();
      expect(apiMocks.batchJobUndo).toHaveBeenCalledWith("j13");
      expect(showToast).toHaveBeenCalledWith("mail.selection.undoExpired", "error");
    } finally {
      vi.useRealTimers();
    }
  });
});
