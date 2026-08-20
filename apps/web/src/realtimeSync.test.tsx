// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { shouldPollTick, useRealtimeSync, type RealtimeSyncOptions } from "./realtimeSync";
import { translate, type Translate } from "./i18n";
import type { ToastKind } from "./mailUi";

const zh: Translate = (key, values) => translate("zh-CN", key, values);

describe("shouldPollTick", () => {
  const intervalMs = 60_000;

  it("polls when no SSE event has ever arrived (stream disabled or never connected)", () => {
    // lastSseEventAt starts at 0; a fresh mount must keep the poll cadence.
    expect(shouldPollTick(0, 1_700_000_000_000, intervalMs)).toBe(true);
  });

  it("skips every tick while events keep the stream fresh", () => {
    const lastEvent = 5_000_000;
    expect(shouldPollTick(lastEvent, lastEvent + 1, intervalMs)).toBe(false);
    expect(shouldPollTick(lastEvent, lastEvent + 20_000, intervalMs)).toBe(false);
    expect(shouldPollTick(lastEvent, lastEvent + intervalMs - 1, intervalMs)).toBe(false);
  });

  it("polls again once a full interval passes without an event", () => {
    const lastEvent = 5_000_000;
    expect(shouldPollTick(lastEvent, lastEvent + intervalMs, intervalMs)).toBe(true);
    expect(shouldPollTick(lastEvent, lastEvent + intervalMs + 5_000, intervalMs)).toBe(true);
  });
});

// Unmounted lookup stand-in for the browser's EventSource (jsdom has none).
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event?: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event?: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  close() {
    this.closed = true;
  }
}

function RealtimeHarness(options: RealtimeSyncOptions) {
  useRealtimeSync(options);
  return null;
}

function baseOptions(): RealtimeSyncOptions {
  return {
    enabled: true,
    pushEnabled: true,
    refreshIntervalSeconds: 60,
    isDesktop: false,
    t: zh,
    showToast: vi.fn<(message: string, kind?: ToastKind) => void>(),
    onRefresh: vi.fn<() => void>(),
    onSettingsChanged: vi.fn<() => void>(),
  };
}

function mount(options: RealtimeSyncOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const rerender = (next: RealtimeSyncOptions) => {
    act(() => { root.render(<RealtimeHarness {...next} />); });
  };
  act(() => { root.render(<RealtimeHarness {...options} />); });
  return { root, rerender, container };
}

describe("useRealtimeSync", () => {
  afterEach(() => {
    FakeEventSource.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("does not connect or poll in demo mode", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mount({ ...baseOptions(), enabled: false });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("stays dormant while the push toggle is off", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mount({ ...baseOptions(), pushEnabled: false });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("opens one stream and subscribes to the three event names", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mount(baseOptions());
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events");
    for (const eventName of ["mail.received", "mail.synced", "settings.changed"]) {
      expect(FakeEventSource.instances[0].listeners.has(eventName)).toBe(true);
    }
  });

  it("rebuilds the stream when the push toggle flips, closing the old one", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const options = baseOptions();
    const { rerender } = mount(options);
    const first = FakeEventSource.instances[0];
    rerender({ ...options, pushEnabled: false });
    expect(first.closed).toBe(true);
    rerender({ ...options, pushEnabled: true });
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("closes the stream on unmount", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { root } = mount(baseOptions());
    const instance = FakeEventSource.instances[0];
    act(() => { root.unmount(); });
    expect(instance.closed).toBe(true);
  });

  it("refreshes and toasts the sender on mail.received (browser fallback)", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { onRefresh, showToast } = baseOptions();
    mount({ ...baseOptions(), onRefresh, showToast });
    const instance = FakeEventSource.instances[0];
    act(() => {
      instance.dispatch("mail.received", { data: JSON.stringify({ type: "mail.received", payload: { count: 1, messages: [{ fromName: "Alice", fromAddress: "alice@example.com" }] } }) });
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(zh("mail.notification.singleToast", { sender: "Alice" }));
  });

  it("toasts the count for a batch arrival", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { showToast } = baseOptions();
    mount({ ...baseOptions(), showToast });
    const instance = FakeEventSource.instances[0];
    act(() => {
      instance.dispatch("mail.received", { data: JSON.stringify({ type: "mail.received", payload: { count: 3, messages: [] } }) });
    });
    expect(showToast).toHaveBeenCalledWith(zh("mail.notification.multipleToast", { count: 3 }));
  });

  it("refreshes without a toast on desktop (the IPC bridge owns the notice)", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { onRefresh, showToast } = baseOptions();
    mount({ ...baseOptions(), onRefresh, showToast, isDesktop: true });
    const instance = FakeEventSource.instances[0];
    act(() => {
      instance.dispatch("mail.received", { data: JSON.stringify({ type: "mail.received", payload: { count: 1, messages: [{ fromName: "Alice" }] } }) });
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("ignores malformed or non-mail payloads for the toast but still refreshes", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { onRefresh, showToast } = baseOptions();
    mount({ ...baseOptions(), onRefresh, showToast });
    const instance = FakeEventSource.instances[0];
    act(() => {
      instance.dispatch("mail.received", { data: "{ not json" });
      instance.dispatch("mail.received", { data: JSON.stringify({ type: "mail.other", payload: { count: 1 } }) });
      instance.dispatch("mail.received", { data: JSON.stringify({ type: "mail.received", payload: { count: 0 } }) });
    });
    // The refresh fires on every received event before payload validation.
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("refreshes on mail.synced without a toast", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { onRefresh, showToast } = baseOptions();
    mount({ ...baseOptions(), onRefresh, showToast });
    act(() => { FakeEventSource.instances[0].dispatch("mail.synced"); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("re-applies settings on settings.changed", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { onSettingsChanged } = baseOptions();
    mount({ ...baseOptions(), onSettingsChanged });
    act(() => { FakeEventSource.instances[0].dispatch("settings.changed"); });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting after the capped backoff budget is exhausted", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    mount(baseOptions());
    let instance = FakeEventSource.instances[0];
    // Ten errors each schedule a reconnect with capped exponential backoff
    // (1s, 2s, 4s, ... capped at 30s); the eleventh error gives up.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      act(() => { instance.onerror?.(); });
      vi.advanceTimersByTime(Math.min(1_000 * 2 ** attempt, 30_000) + 10);
      instance = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    }
    expect(FakeEventSource.instances).toHaveLength(11);
    act(() => { instance.onerror?.(); });
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(11);
  });

  it("a successful open resets the backoff budget", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    mount(baseOptions());
    let instance = FakeEventSource.instances[0];
    act(() => { instance.onerror?.(); });
    vi.advanceTimersByTime(1_010);
    instance = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    act(() => { instance.onopen?.(); });
    act(() => { instance.onerror?.(); });
    // attempt was reset by onopen, so this error reconnects with the 1s delay.
    vi.advanceTimersByTime(1_010);
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});