// @vitest-environment jsdom
/**
 * Composition test for the shell's push-stream binding.
 *
 * `useAppRealtimeSync` routes every task/mail frame through the shell's one
 * visibility-gated refresh entry point. The regression this pins: a settled
 * task arriving while the window is hidden must still update the cloud-sync
 * panel locally, but must not start a mailbox read in the background; the
 * single catch-up runs on the first visibilitychange. The gate under test is
 * the production `useCoalescedRefresh`, not a stub, so the composition is the
 * real one App.tsx mounts.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../api";
import type { DeliveryTaskList } from "../batchJobTypes";
import { useCoalescedRefresh } from "../useCoalescedRefresh";
import { useAppRealtimeSync } from "./useAppRealtimeSync";

const mocks = vi.hoisted(() => ({ taskList: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: { ...actual.api, taskList: mocks.taskList },
  };
});

// jsdom's document.hidden has no public setter; back it with a flag.
let hidden = false;

type FakeSource = {
  listeners: Map<string, Array<(event: MessageEvent<string>) => void>>;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
};

let sources: FakeSource[] = [];

class FakeEventSource implements FakeSource {
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sources.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    // Nothing to release in the fake.
  }
}

const noop = () => undefined;
const translate: (key: string) => string = (key) => key;

let latest: ReturnType<typeof useAppRealtimeSync> | undefined;
let refreshSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;

function ShellHarness() {
  const requestRefresh = useCoalescedRefresh(refreshSpy);
  latest = useAppRealtimeSync({
    enabled: true,
    pushEnabled: true,
    refreshIntervalSeconds: 60,
    isDesktop: false,
    t: translate,
    showToast: noop,
    onRefresh: requestRefresh,
    onSettingsChanged: noop,
    onSyncProgress: noop,
  });
  return null;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ShellHarness />); });
}

async function dispatch(name: string, payload: unknown): Promise<void> {
  const listener = sources.at(-1)?.listeners.get(name)?.[0];
  await act(async () => {
    listener?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
    await Promise.resolve();
  });
}

async function restoreVisibility(): Promise<void> {
  hidden = false;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
}

const initialList: DeliveryTaskList = {
  syncing: [{ id: "t1", accountId: "a1", accountEmail: "me@example.com", kind: "move", scope: "batch", status: "running", total: 10, updated: 1, failed: 0, createdAt: 1, completedAt: null, dueAt: null }],
  attention: [],
};

describe("useAppRealtimeSync refresh gating", () => {
  let originalHidden: PropertyDescriptor | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    hidden = false;
    originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    sources = [];
    latest = undefined;
    refreshSpy = vi.fn<() => Promise<void>>(async () => undefined);
    vi.stubGlobal("EventSource", FakeEventSource);
    mocks.taskList.mockResolvedValue(initialList);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("keeps a hidden settlement local and defers the single mailbox read to the restore", async () => {
    await mount();
    expect(latest?.cloudSync.syncing.map((row) => row.id)).toEqual(["t1"]);

    hidden = true;
    await dispatch("task-settled", {
      type: "task-settled",
      payload: { accountId: "a1", taskId: "t1", status: "completed" },
    });

    // The frame's own consequence is local state, so the panel updates even in
    // the background; the expensive mailbox read is what must not start.
    expect(latest?.cloudSync.syncing).toEqual([]);
    expect(refreshSpy).not.toHaveBeenCalled();

    await restoreVisibility();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately when the window is visible", async () => {
    vi.useFakeTimers();
    await mount();

    await dispatch("task-settled", {
      type: "task-settled",
      payload: { accountId: "a1", taskId: "t1", status: "completed" },
    });
    await act(async () => { await Promise.resolve(); });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(latest?.cloudSync.syncing).toEqual([]);
  });

  it("runs exactly one catch-up for several frames that arrived hidden", async () => {
    await mount();
    hidden = true;
    await dispatch("task-settled", {
      type: "task-settled",
      payload: { accountId: "a1", taskId: "t1", status: "completed" },
    });
    await dispatch("mail-changed", { type: "mail-changed", payload: { accountId: "a1", folders: ["INBOX"] } });
    expect(refreshSpy).not.toHaveBeenCalled();

    await restoreVisibility();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
