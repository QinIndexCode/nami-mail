import { describe, expect, it, vi } from "vitest";
import { AgentMailChangeBridge } from "../src/agent/mail-change-bridge.js";
import type {
  AgentAccountDeletion,
  AgentMailEventState,
  AgentMailStateEventSink,
} from "../src/agent/mail-state-events.js";
import { ServerEventBus, type ServerEvent } from "../src/events.js";

const LEASE = { accountId: "account-1", generation: 1 } as const;

type InnerCalls = {
  upserts: Array<{ messageId: string; state: AgentMailEventState }>;
  deletions: Array<{ messageId: string; state: AgentMailEventState }>;
  begun: string[];
  completed: Array<{ accountId: string; generation: number }>;
  leases: string[];
};

function recorder(overrides: Partial<AgentMailStateEventSink> = {}): {
  inner: AgentMailStateEventSink;
  calls: InnerCalls;
} {
  const calls: InnerCalls = { upserts: [], deletions: [], begun: [], completed: [], leases: [] };
  const inner: AgentMailStateEventSink = {
    acquireLease(accountId) {
      calls.leases.push(accountId);
      return { accountId, generation: 1 };
    },
    messageUpsertedWithinTransaction(_lease, messageId, state) {
      calls.upserts.push({ messageId, state });
    },
    messageDeletedWithinTransaction(_lease, messageId, state) {
      calls.deletions.push({ messageId, state });
    },
    beginAccountDeletion(accountId) {
      calls.begun.push(accountId);
      return { previousGeneration: 1, deletionGeneration: 2 };
    },
    completeAccountDeletion(accountId, deletionGeneration) {
      calls.completed.push({ accountId, generation: deletionGeneration });
    },
    ...overrides,
  };
  return { inner, calls };
}

function busRecorder(): { bus: ServerEventBus; events: ServerEvent[] } {
  const bus = new ServerEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return { bus, events };
}

/**
 * The production scheduler is `queueMicrotask`; a test that wants to look at
 * the window between "sink called" and "frame published" has to hold the
 * callback instead of racing the microtask queue.
 */
function manualSchedule(): { schedule: (flush: () => void) => void; run: () => void; count: () => number } {
  const queued: Array<() => void> = [];
  return {
    schedule: (flush) => queued.push(flush),
    run: () => {
      const next = queued.shift();
      next?.();
    },
    count: () => queued.length,
  };
}

describe("agent mail change bridge", () => {
  it("does not publish until the deferred flush runs, and then publishes once", () => {
    const { inner, calls } = recorder();
    const { bus, events } = busRecorder();
    const scheduler = manualSchedule();
    const bridge = new AgentMailChangeBridge(inner, bus, { schedule: scheduler.schedule });

    bridge.messageUpsertedWithinTransaction(LEASE, "m1", { mailbox: "INBOX" });

    // The sink runs inside the caller's transaction, so publishing here would
    // announce rows the database may still roll back.
    expect(events).toEqual([]);
    expect(calls.upserts).toEqual([{ messageId: "m1", state: { mailbox: "INBOX" } }]);
    expect(scheduler.count()).toBe(1);

    scheduler.run();

    expect(events).toEqual([
      { type: "mail-changed", payload: { accountId: "account-1", folders: ["INBOX"] } },
    ]);
  });

  it("coalesces a batch into one frame per account and sorts the folder names", () => {
    const { inner } = recorder();
    const { bus, events } = busRecorder();
    const scheduler = manualSchedule();
    const bridge = new AgentMailChangeBridge(inner, bus, { schedule: scheduler.schedule });

    bridge.messageUpsertedWithinTransaction(LEASE, "m1", { mailbox: "Zeta", pendingMoveDestination: "Archive" });
    bridge.messageUpsertedWithinTransaction(LEASE, "m2", { mailbox: "INBOX" });
    bridge.messageDeletedWithinTransaction(LEASE, "m3", { mailbox: "Archive" });
    bridge.messageUpsertedWithinTransaction({ accountId: "account-2", generation: 1 }, "m4", { mailbox: "Sent" });

    // A whole sync or multi-message Agent edit is one synchronous stack, so it
    // must not turn into hundreds of frames (or hundreds of refreshes).
    expect(scheduler.count()).toBe(1);
    expect(events).toEqual([]);

    scheduler.run();

    expect(events).toEqual([
      { type: "mail-changed", payload: { accountId: "account-1", folders: ["Archive", "INBOX", "Zeta"] } },
      { type: "mail-changed", payload: { accountId: "account-2", folders: ["Sent"] } },
    ]);
  });

  it("publishes an account-only frame when the state names no folder", () => {
    const { inner } = recorder();
    const { bus, events } = busRecorder();
    const scheduler = manualSchedule();
    const bridge = new AgentMailChangeBridge(inner, bus, { schedule: scheduler.schedule });

    bridge.messageUpsertedWithinTransaction(LEASE, "m1", { subject: "no mailbox here" });
    scheduler.run();

    // Dropping the frame would lose the change entirely; the contract lets
    // `folders` be empty exactly for a writer that cannot name one, and the
    // renderer still refreshes from it.
    expect(events).toEqual([
      { type: "mail-changed", payload: { accountId: "account-1", folders: [] } },
    ]);
  });

  it("keeps flushing idempotent and never re-publishes the same batch", () => {
    const { inner } = recorder();
    const { bus, events } = busRecorder();
    const scheduler = manualSchedule();
    const bridge = new AgentMailChangeBridge(inner, bus, { schedule: scheduler.schedule });

    bridge.messageUpsertedWithinTransaction(LEASE, "m1", { mailbox: "INBOX" });
    bridge.flush();
    bridge.flush();

    expect(events).toHaveLength(1);
    // The callback queued before the manual flush is still in the queue and
    // will run at the end of this stack; it must be a no-op, not a replay.
    scheduler.run();
    expect(events).toHaveLength(1);
    // A flush that ran early must not leave the bridge believing a batch is
    // still scheduled: the next change has to queue its own frame.
    bridge.messageUpsertedWithinTransaction(LEASE, "m2", { mailbox: "Sent" });
    expect(scheduler.count()).toBe(1);
    scheduler.run();
    expect(events).toHaveLength(2);
  });

  it("forwards to the recorder without scheduling anything when there is no bus", () => {
    const { inner, calls } = recorder();
    const schedule = vi.fn();
    const bridge = new AgentMailChangeBridge(inner, undefined, { schedule });

    bridge.messageUpsertedWithinTransaction(LEASE, "m1", { mailbox: "INBOX" });
    bridge.flush();

    expect(calls.upserts).toEqual([{ messageId: "m1", state: { mailbox: "INBOX" } }]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("delegates lease and account-deletion calls untouched", () => {
    const expectedDeletion: AgentAccountDeletion = { previousGeneration: 1, deletionGeneration: 2 };
    const { inner, calls } = recorder();
    const { bus, events } = busRecorder();
    const bridge = new AgentMailChangeBridge(inner, bus, { schedule: () => undefined });

    expect(bridge.acquireLease("account-1")).toEqual({ accountId: "account-1", generation: 1 });
    expect(bridge.beginAccountDeletion("account-1", () => undefined)).toEqual(expectedDeletion);
    bridge.completeAccountDeletion("account-1", 2);

    expect(calls.leases).toEqual(["account-1"]);
    expect(calls.begun).toEqual(["account-1"]);
    expect(calls.completed).toEqual([{ accountId: "account-1", generation: 2 }]);
    // Account deletion is not a mail-row edit; it must not publish a refresh
    // for folders that are being removed.
    expect(events).toEqual([]);
  });
});
