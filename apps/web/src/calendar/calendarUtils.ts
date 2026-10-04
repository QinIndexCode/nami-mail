import type { CalendarEvent, CalendarEventColor } from "../types";

export type EventDraft = {
  title: string;
  description: string;
  location: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  color: CalendarEventColor;
};

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isoToDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isoToTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeToIso(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

export function dateToStartIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

export function dateToEndIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

export function draftFromEvent(event: CalendarEvent): EventDraft {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    startDate: isoToDate(event.startAt),
    startTime: isoToTime(event.startAt),
    endDate: isoToDate(event.endAt),
    endTime: isoToTime(event.endAt),
    allDay: event.allDay,
    color: event.color,
  };
}

/** Local dates (inclusive) covered by an event, so multi-day events render on every day. */
export function eventDayKeys(event: CalendarEvent): string[] {
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const keys: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let guard = 0;
  while (cursor.getTime() <= endDay.getTime() && guard < 400) {
    keys.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return keys;
}

export function isIcsAttachment(attachment: { filename?: string; contentType?: string }): boolean {
  const filename = (attachment.filename || "").toLowerCase();
  const contentType = (attachment.contentType || "").toLowerCase();
  return filename.endsWith(".ics") || contentType.includes("calendar");
}

export function formatEventTimeSpan(startIso: string, endIso: string, allDay: boolean, locale = "zh-CN"): string {
  try {
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return "";
    const startDateStr = start.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
    if (allDay) {
      const endDateStr = end.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
      return startDateStr === endDateStr ? startDateStr : `${startDateStr} - ${endDateStr}`;
    }
    const isSameDay = start.toDateString() === end.toDateString();
    const startTimeStr = start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const endTimeStr = end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (isSameDay) {
      return `${startDateStr} ${startTimeStr} - ${endTimeStr}`;
    }
    const endDateStr = end.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
    return `${startDateStr} ${startTimeStr} - ${endDateStr} ${endTimeStr}`;
  } catch {
    return "";
  }
}
