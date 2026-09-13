// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useCoalescedRefresh } from "./useCoalescedRefresh";

// jsdom's document.hidden is a read-only property that tracks the window being
// visible; there is no public setter. We swap it for a getter backed by a flag
// so tests can drive the frontend's visible/hidden state directly.
let hidden = false;
function setHidden(next: boolean) {
  hidden = next;
}

// A host that owns exactly one coalesced-refresh gate, so the test can drive
// the returned request function and observe how often the underlying refresh
// actually fires.
let refreshFn: ReturnType<typeof vi.fn<() => void>>;
let requestRefresh: () => void;

function RefreshGateHost() {
  requestRefresh = useCoalescedRefresh(refreshFn, { minIntervalMs: 2_000 });
  return null;
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<RefreshGateHost />); });
  return { root, container };
}

// The gate defers the actual refresh onto a microtask (Promise.resolve().then),
// so a passing test must let async act flush that queue before asserting.
async function request() {
  await act(async () => { requestRefresh(); });
}

describe("useCoalescedRefresh", () => {
  let originalHidden: PropertyDescriptor | undefined;

  beforeEach(() => {
    hidden = false;
    originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
  });

  afterEach(() => {
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("runs a visible request immediately", async () => {
    refreshFn = vi.fn<() => void>();
    mount();
    await request();
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("defers work while hidden and flushes one catch-up on restore", async () => {
    refreshFn = vi.fn<() => void>();
    setHidden(true);
    mount();
    await request();
    // Hidden: only marked dirty, nothing actually refreshed in the background.
    expect(refreshFn).not.toHaveBeenCalled();

    // Restore visibility: the pending dirty request must now run as the single
    // catch-up flush.
    setHidden(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst inside the coalescing window into one trailing refresh", async () => {
    refreshFn = vi.fn<() => void>();
    vi.useFakeTimers();
    mount();
    await request();
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // A flurry of requests arriving before the minimum interval elapses must
    // not each fire — they stack into exactly one trailing pass.
    act(() => { requestRefresh(); requestRefresh(); requestRefresh(); });
    expect(refreshFn).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(2_010); });
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });
});