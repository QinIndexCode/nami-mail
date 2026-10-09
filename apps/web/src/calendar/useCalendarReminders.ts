import { useEffect, useRef } from "react";
import { calendarCache } from "../dialogPrefetch";
import { durableGet, durableSet } from "../durablePreferences";
import { desktopBridge } from "../desktop";
import type { CalendarEvent } from "../types";
import type { ToastAction, ToastKind, ToastOptions } from "../notifications/useToastQueue";
import { formatEventTimeSpan } from "./calendarUtils";
import { detectMeetingLink } from "./meetingLinks";

const STORAGE_KEY = "nami-mail.calendar-reminded-events";
// Pre-durable-layer key (the desktop's ephemeral origin wiped it anyway);
// read once as a fallback so reminders already shown in a browser session
// survive the rename.
const LEGACY_STORAGE_KEY = "nami:reminded_calendar_events";
const MAX_STORED_KEYS = 200;
const REMINDER_ADVANCE_MS = 15 * 60 * 1000; // 15 minutes before start
const STALE_WINDOW_MS = 30 * 60 * 1000; // Ignore reminders older than 30 minutes

function loadNotifiedKeys(): Set<string> {
  try {
    const current = durableGet(STORAGE_KEY);
    if (current) {
      const arr = JSON.parse(current);
      return new Set(Array.isArray(arr) ? arr : []);
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return new Set();
    const arr = JSON.parse(legacy);
    const keys = new Set(Array.isArray(arr) ? arr : []);
    // R13: migrate on read. A read-only fallback leaves the legacy entry
    // authoritative, so a session where every key was already reminded
    // (no state change, no durable write) would keep the dedup set in the
    // legacy key — invisible to a later clear and to the durable layer.
    // Only an EMPTY current value migrates: an intentionally cleared
    // durable key (the user re-enables reminders after a reset) must not
    // be overwritten by a legacy set that was never cleaned up.
    if (current === null && keys.size > 0) {
      saveNotifiedKeys(keys);
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // Removing the legacy key is best-effort; the durable write above
        // already made the new key authoritative for every future read.
      }
    }
    return keys;
  } catch {
    return new Set();
  }
}

function saveNotifiedKeys(set: Set<string>): void {
  try {
    // Durable layer: on the desktop the ephemeral origin wipes localStorage,
    // so without the mirror a restart inside the reminder window re-alerted.
    durableSet(STORAGE_KEY, JSON.stringify(Array.from(set).slice(-MAX_STORED_KEYS)));
  } catch {
    // Ignore storage quota or access errors
  }
}

export type UseCalendarRemindersOptions = {
  demoMode?: boolean;
  locale: string;
  onOpenCalendar: () => void;
  showToast: (message: string, kind?: ToastKind, actionOrOptions?: ToastAction | ToastOptions) => void;
  notificationsEnabled?: boolean;
};

export function useCalendarReminders({
  demoMode = false,
  locale,
  onOpenCalendar,
  showToast,
  notificationsEnabled = true,
}: UseCalendarRemindersOptions) {
  const notifiedKeysRef = useRef<Set<string>>(loadNotifiedKeys());

  useEffect(() => {
    if (!notificationsEnabled) return;

    const checkReminders = async () => {
      if (demoMode) return;
      let events: CalendarEvent[] = [];
      try {
        events = await calendarCache.get();
      } catch {
        return;
      }

      const now = Date.now();
      const notified = notifiedKeysRef.current;
      let stateChanged = false;

      for (const event of events) {
        const key = `reminded:${event.id}:${event.startAt}`;
        if (notified.has(key)) continue;

        const startTime = new Date(event.startAt).getTime();
        const endTime = new Date(event.endAt).getTime();
        if (isNaN(startTime) || isNaN(endTime)) continue;

        let reminderTargetTime = startTime - REMINDER_ADVANCE_MS;
        if (event.allDay) {
          const startDate = new Date(event.startAt);
          reminderTargetTime = new Date(
            startDate.getFullYear(),
            startDate.getMonth(),
            startDate.getDate(),
            9,
            0,
            0,
            0,
          ).getTime();
        }

        // Must be in window: current time reached reminder time, event has not finished yet,
        // and reminder is not older than 30 minutes.
        if (now >= reminderTargetTime && now < endTime && now - reminderTargetTime <= STALE_WINDOW_MS) {
          notified.add(key);
          stateChanged = true;

          const meeting = detectMeetingLink(`${event.location || ""} ${event.description || ""}`);
          const timeSpan = formatEventTimeSpan(event.startAt, event.endAt, event.allDay, locale);
          const isZh = locale.toLowerCase().startsWith("zh");
          const desktopTitle = isZh ? `[日程提醒] ${event.title}` : `[Calendar] ${event.title}`;
          const locationSuffix = event.location && (!meeting || !event.location.includes(meeting.url)) ? ` · ${event.location}` : "";
          const desktopBody = `${timeSpan}${locationSuffix}`.trim();

          // 1. Desktop native notification
          const bridge = desktopBridge();
          if (bridge) {
            void bridge.notify({ title: desktopTitle, body: desktopBody, silent: false });
          } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(desktopTitle, { body: desktopBody });
            } catch {
              // Ignore web notification error
            }
          }

          // 2. In-App Actionable Toast
          const toastAction: ToastAction = meeting
            ? {
              label: meeting.label,
              icon: "video",
              run: () => {
                window.open(meeting.url, "_blank");
              },
            }
            : {
              label: isZh ? "查看日历" : "View Calendar",
              icon: "calendar",
              run: onOpenCalendar,
            };

          const toastMessage = `${event.title} · ${timeSpan}${locationSuffix}`;
          showToast(toastMessage, "info", toastAction);
        }
      }

      if (stateChanged) {
        saveNotifiedKeys(notified);
      }
    };

    void checkReminders();
    const interval = window.setInterval(() => {
      void checkReminders();
    }, 30_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [demoMode, locale, notificationsEnabled, onOpenCalendar, showToast]);
}
