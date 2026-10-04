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
});
