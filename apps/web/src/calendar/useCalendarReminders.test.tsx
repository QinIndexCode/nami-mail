// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCalendarReminders, type UseCalendarRemindersOptions } from "./useCalendarReminders";
import type { CalendarEvent } from "../types";

const mockGet = vi.fn();
vi.mock("../dialogPrefetch", () => ({
  calendarCache: {
    get: () => mockGet(),
  },
}));

const mockNotify = vi.fn();
vi.mock("../desktop", () => ({
  desktopBridge: () => ({
    notify: mockNotify,
  }),
}));

function ReminderTester(props: UseCalendarRemindersOptions) {
  useCalendarReminders(props);
  return null;
}

describe("useCalendarReminders", () => {
  let root: Root;
  let container: HTMLElement;
  let showToast: UseCalendarRemindersOptions["showToast"] & ReturnType<typeof vi.fn>;
  let onOpenCalendar: UseCalendarRemindersOptions["onOpenCalendar"] & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { store = {}; },
    });
    mockNotify.mockReset();
    mockGet.mockReset();
    showToast = vi.fn() as unknown as UseCalendarRemindersOptions["showToast"] & ReturnType<typeof vi.fn>;
    onOpenCalendar = vi.fn() as unknown as UseCalendarRemindersOptions["onOpenCalendar"] & ReturnType<typeof vi.fn>;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("triggers desktop notification and actionable toast for upcoming meeting within 15 mins", async () => {
    const now = Date.now();
    // Meeting starts in 10 minutes (within 15 minutes reminder window)
    const startAt = new Date(now + 10 * 60 * 1000).toISOString();
    const endAt = new Date(now + 40 * 60 * 1000).toISOString();

    const sampleEvent: CalendarEvent = {
      id: "evt-1",
      title: "产品评审会",
      description: "参会链接：https://meeting.tencent.com/dm/12345678",
      location: "线上腾讯会议",
      startAt,
      endAt,
      allDay: false,
      color: "blue",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockGet.mockResolvedValue([sampleEvent]);

    await act(async () => {
      root.render(
        <ReminderTester
          demoMode={false}
          locale="zh-CN"
          onOpenCalendar={onOpenCalendar}
          showToast={showToast}
          notificationsEnabled={true}
        />,
      );
    });

    // Wait microtasks
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: "[日程提醒] 产品评审会",
    }));

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("产品评审会"),
      "info",
      expect.objectContaining({
        label: "加入腾讯会议",
      }),
    );
  });

  it("does not trigger reminder if event start time is hours in the future", async () => {
    const now = Date.now();
    // Meeting starts in 3 hours
    const startAt = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    const endAt = new Date(now + 4 * 60 * 60 * 1000).toISOString();

    mockGet.mockResolvedValue([{
      id: "evt-2",
      title: "远程周会",
      description: "",
      location: "",
      startAt,
      endAt,
      allDay: false,
      color: "teal",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);

    await act(async () => {
      root.render(
        <ReminderTester
          demoMode={false}
          locale="zh-CN"
          onOpenCalendar={onOpenCalendar}
          showToast={showToast}
          notificationsEnabled={true}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockNotify).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  // R13: the pre-durable reminder key is migrated on first read, not merely
  // fallen back to. The browser is the durable surface here (no bridge), so
  // migration is visible as the legacy key disappearing and the new key
  // carrying the set; an already-reminded event then stays quiet.
  it("migrates the legacy reminder key on read so an already-reminded event stays quiet", async () => {
    const now = Date.now();
    const startAt = new Date(now + 10 * 60 * 1000).toISOString();
    const endAt = new Date(now + 40 * 60 * 1000).toISOString();
    const event: CalendarEvent = {
      id: "evt-legacy",
      title: "旧键已提醒的会",
      description: "",
      location: "",
      startAt,
      endAt,
      allDay: false,
      color: "blue",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // The legacy key records this event+startAt as already reminded.
    const store = new Map<string, string>([["nami:reminded_calendar_events", JSON.stringify([`reminded:evt-legacy:${startAt}`])]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    });
    mockGet.mockResolvedValue([event]);

    await act(async () => {
      root.render(
        <ReminderTester
          demoMode={false}
          locale="zh-CN"
          onOpenCalendar={onOpenCalendar}
          showToast={showToast}
          notificationsEnabled={true}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    // Already reminded: silent, and the set now lives in the durable key
    // while the legacy key is gone.
    expect(mockNotify).not.toHaveBeenCalled();
    expect(store.has("nami:reminded_calendar_events")).toBe(false);
    const migrated = store.get("nami-mail.calendar-reminded-events");
    expect(migrated).toBe(JSON.stringify([`reminded:evt-legacy:${startAt}`]));
  });
});
