// @vitest-environment jsdom
/**
 * Unit tests for useRealtimeSync's connection reporting.
 *
 * Scope: the push stream's visible health (connecting → live → reconnecting →
 * offline after the backoff budget is spent) and the manual retry that resets
 * that budget. A FakeEventSource captures every connection attempt and lets the
 * test fire `open`/`error` deterministically; the poll fallback path is left to
 * the existing behaviour (it only depends on shouldPollTick).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { useRealtimeSync, type RealtimeConnectionState, type RealtimeSyncHandle } from "./realtimeSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeSource = {
  url: string;
  closed: boolean;
  listeners: Map<string, Array<(event: MessageEvent<string>) => void>>;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
  /** Test helpers: fire the browser callbacks the hook wired up. */
  open: () => void;
  fail: () => void;
};

let sources: FakeSource[] = [];

class FakeEventSource implements FakeSource {
  closed = false;
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sources.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

// The 30s backoff cap would make a "gave up" sequence slow; the timer is
// stubbed so each retry can be advanced in a single tick.
let timers: Array<{ fn: () => void; delay: number }> = [];

beforeEach(() => {
  sources = [];
  timers = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, delay?: number) => {
    timers.push({ fn, delay: delay ?? 0 });
    return timers.length;
  }) as unknown as typeof window.setTimeout);
  vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Drains every pending retry timer, opening the connection each time. */
async function drainRetries(): Promise<void> {
  for (let guard = 0; guard < 50 && timers.length > 0; guard += 1) {
    const pending = timers;
    timers = [];
    await act(async () => {
      for (const timer of pending) timer.fn();
    });
  }
}

// Stable identities: App.tsx's callbacks are memoized, and recreating them on
// every render would re-run the hook's poll effect (which depends on onRefresh).
const noop = () => undefined;
const translate: (key: string) => string = (key) => key;

function Harness({ onState }: { onState: (state: RealtimeConnectionState) => void }): ReactElement | null {
  const handleRef = useRef<RealtimeSyncHandle | undefined>(undefined);
  const next = useRealtimeSync({
    enabled: true,
    pushEnabled: true,
    refreshIntervalSeconds: 60,
    isDesktop: false,
    t: translate,
    showToast: noop,
    onRefresh: noop,
    onSettingsChanged: noop,
    onSyncProgress: noop,
  });
  // The hook returns a fresh object every render; keep the latest one in a ref
  // instead of state so observing it can never feed back into rendering.
  handleRef.current = next;
  useEffect(() => {
    onState(next.connectionState);
  }, [next.connectionState, onState]);
  return (
    <button type="button" data-reconnect onClick={() => handleRef.current?.reconnect()}>
      reconnect
    </button>
  );
}

async function mountHarness(): Promise<{ states: RealtimeConnectionState[]; container: HTMLDivElement; unmount: () => void }> {
  const states: RealtimeConnectionState[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness onState={(state) => states.push(state)} />);
  });
  const unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return { states, container, unmount };
}

describe("useRealtimeSync connection state", () => {
  it("reports a live stream once the source opens", async () => {
    const { states, container, unmount } = await mountHarness();
    expect(sources).toHaveLength(1);
    await act(async () => {
      sources[0]?.open();
    });
    expect(states.at(-1)).toBe("live");
    expect(sources[0]?.url).toBe("/api/events");
    unmount();
    container.remove();
  });

  it("gives up after the backoff budget and reports offline", async () => {
    const { states, container, unmount } = await mountHarness();
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const source = sources.at(-1);
      await act(async () => {
        source?.fail();
      });
      await drainRetries();
    }
    expect(states).toContain("reconnecting");
    expect(states.at(-1)).toBe("offline");
    // The failed connection is closed instead of letting EventSource hammer it.
    expect(sources.at(-1)?.closed).toBe(true);
    unmount();
    container.remove();
  });

  it("retry opens a fresh connection and returns to live", async () => {
    const { states, container, unmount } = await mountHarness();
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const source = sources.at(-1);
      await act(async () => {
        source?.fail();
      });
      await drainRetries();
    }
    expect(states.at(-1)).toBe("offline");
    const attemptsBeforeRetry = sources.length;

    const retryButton = container.querySelector("[data-reconnect]");
    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sources.length).toBe(attemptsBeforeRetry + 1);
    expect(states.at(-1)).toBe("connecting");

    await act(async () => {
      sources.at(-1)?.open();
    });
    expect(states.at(-1)).toBe("live");
    unmount();
    container.remove();
  });
});
