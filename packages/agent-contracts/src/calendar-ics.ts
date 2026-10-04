import { calendarEventColors, type CalendarEventColor } from "./mail-dto.js";

/**
 * RFC 5545 iCalendar (ICS) serializer and parser.
 * Encapsulates line folding, text escaping, timezone/datetime normalization,
 * and VEVENT object mapping for calendar imports and exports.
 */

export type CalendarEventExportSource = {
  id: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  color?: CalendarEventColor | string;
  createdAt?: string;
  updatedAt?: string;
};

export type ParsedIcsEvent = {
  uid: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  color: CalendarEventColor;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a Date object into UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ */
export function formatIcsUtcDateTime(date: Date): string {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

/** Formats a Date object into iCalendar date only: YYYYMMDD */
export function formatIcsDateOnly(date: Date): string {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  return `${y}${m}${d}`;
}

/** Escapes special characters per RFC 5545 section 3.3.11 */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Unescapes special characters per RFC 5545 section 3.3.11 */
export function unescapeIcsText(text: string): string {
  return text
    .replace(/\\([\\;,nN])/g, (_, char) => {
      if (char === "n" || char === "N") return "\n";
      return char;
    });
}

/** Folds a content line to at most 75 octets using CRLF followed by a space */
export function foldIcsLine(line: string, maxBytes = 75): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= maxBytes) return line;

  const chunks: string[] = [];
  let currentStart = 0;
  let isFirst = true;

  while (currentStart < bytes.length) {
    const limit = isFirst ? maxBytes : maxBytes - 1; // 1 byte reserved for leading space
    let sliceEnd = Math.min(currentStart + limit, bytes.length);

    // Ensure we do not cut in the middle of a multi-byte UTF-8 sequence
    while (sliceEnd > currentStart && sliceEnd < bytes.length && ((bytes[sliceEnd] ?? 0) & 0xc0) === 0x80) {
      sliceEnd--;
    }

    const chunk = bytes.subarray(currentStart, sliceEnd).toString("utf8");
    chunks.push(isFirst ? chunk : ` ${chunk}`);
    currentStart = sliceEnd;
    isFirst = false;
  }

  return chunks.join("\r\n");
}

/** Unfolds folded lines (CRLF followed by space/tab) */
export function unfoldIcsLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const unfolded = normalized.replace(/\n[ \t]/g, "");
  return unfolded
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parses iCalendar date / date-time strings into ISO 8601 UTC */
export function parseIcsDate(value: string, params: Record<string, string> = {}): { iso: string; allDay: boolean } {
  const cleanVal = value.trim();
  const isDateValue = params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(cleanVal);

  if (isDateValue) {
    const match = cleanVal.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]) - 1;
      const day = Number(match[3]);
      const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
      return { iso: date.toISOString(), allDay: true };
    }
  }

  // DateTime format: YYYYMMDDTHHMMSS(Z)?
  const dtMatch = cleanVal.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (dtMatch) {
    const year = Number(dtMatch[1]);
    const month = Number(dtMatch[2]) - 1;
    const day = Number(dtMatch[3]);
    const hours = Number(dtMatch[4]);
    const minutes = Number(dtMatch[5]);
    const seconds = Number(dtMatch[6]);
    const isUtc = dtMatch[7] === "Z";

    // If UTC, use Date.UTC
    if (isUtc) {
      const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
      return { iso: date.toISOString(), allDay: false };
    }

    // Floating/local time without timezone offset: interpret as UTC for deterministic local storage
    const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
    return { iso: date.toISOString(), allDay: false };
  }

  // Fallback: standard Date.parse
  const parsed = Date.parse(cleanVal);
  if (Number.isFinite(parsed)) {
    return { iso: new Date(parsed).toISOString(), allDay: false };
  }

  const fallback = new Date().toISOString();
  return { iso: fallback, allDay: false };
}

/** Parses an ISO 8601 duration (e.g., PT1H30M, P1D) into milliseconds */
export function parseIcsDurationMs(durationStr: string): number {
  const match = durationStr.match(/^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return 3600 * 1000;

  const sign = match[1] === "-" ? -1 : 1;
  const days = Number(match[2] ?? 0);
  const hours = Number(match[3] ?? 0);
  const minutes = Number(match[4] ?? 0);
  const seconds = Number(match[5] ?? 0);

  const totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return sign * totalSeconds * 1000;
}

/** Validates and maps a color to a known CalendarEventColor */
function normalizeCalendarColor(rawColor?: string): CalendarEventColor {
  if (!rawColor) return "blue";
  const lower = rawColor.toLowerCase();
  if ((calendarEventColors as readonly string[]).includes(lower)) {
    return lower as CalendarEventColor;
  }
  return "blue";
}

/**
 * Generates an RFC 5545 iCalendar string from a list of calendar events.
 */
export function generateIcs(events: readonly CalendarEventExportSource[], calendarName = "Nami Calendar"): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nami Mail//Nami Calendar v0.4.3//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  const nowUtc = formatIcsUtcDateTime(new Date());

  for (const event of events) {
    const startDate = new Date(event.startAt);
    const endDate = new Date(event.endAt);
    const isValidStart = Number.isFinite(startDate.getTime());
    const isValidEnd = Number.isFinite(endDate.getTime());
    if (!isValidStart) continue;

    const effectiveEnd = isValidEnd && endDate >= startDate ? endDate : new Date(startDate.getTime() + 3600_000);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.id || `nami-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}@namimail`);
    lines.push(`DTSTAMP:${nowUtc}`);

    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDateOnly(startDate)}`);
      // Per RFC 5545, all-day DTEND is exclusive: end date + 1 day
      const nextDay = new Date(effectiveEnd.getTime() + 86400_000);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDateOnly(nextDay)}`);
    } else {
      lines.push(`DTSTART:${formatIcsUtcDateTime(startDate)}`);
      lines.push(`DTEND:${formatIcsUtcDateTime(effectiveEnd)}`);
    }

    lines.push(`SUMMARY:${escapeIcsText(event.title || "Untitled Event")}`);

    if (event.description && event.description.trim().length > 0) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }
    if (event.location && event.location.trim().length > 0) {
      lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    }
    if (event.color) {
      lines.push(`CATEGORIES:${escapeIcsText(event.color)}`);
    }

    if (event.createdAt) {
      const created = new Date(event.createdAt);
      if (Number.isFinite(created.getTime())) {
        lines.push(`CREATED:${formatIcsUtcDateTime(created)}`);
      }
    }
    if (event.updatedAt) {
      const updated = new Date(event.updatedAt);
      if (Number.isFinite(updated.getTime())) {
        lines.push(`LAST-MODIFIED:${formatIcsUtcDateTime(updated)}`);
      }
    }

    lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.map((line) => foldIcsLine(line)).join("\r\n") + "\r\n";
}

/**
 * Parses an RFC 5545 iCalendar string into structured events ready for Nami Mail.
 */
export function parseIcs(icsContent: string): ParsedIcsEvent[] {
  const unfoldedLines = unfoldIcsLines(icsContent);
  const events: ParsedIcsEvent[] = [];

  let inVEvent = false;
  let currentFields: Record<string, { value: string; params: Record<string, string> }> = {};

  for (const line of unfoldedLines) {
    if (line === "BEGIN:VEVENT") {
      inVEvent = true;
      currentFields = {};
      continue;
    }

    if (line === "END:VEVENT") {
      if (inVEvent) {
        const parsed = processVEvent(currentFields);
        if (parsed) {
          events.push(parsed);
        }
      }
      inVEvent = false;
      currentFields = {};
      continue;
    }

    if (!inVEvent) continue;

    // Parse property: NAME;PARAM=VAL:VALUE
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const propPart = line.slice(0, colonIdx);
    const valuePart = line.slice(colonIdx + 1);

    const semicolonIdx = propPart.indexOf(";");
    let propName = propPart;
    const params: Record<string, string> = {};

    if (semicolonIdx !== -1) {
      propName = propPart.slice(0, semicolonIdx);
      const paramParts = propPart.slice(semicolonIdx + 1).split(";");
      for (const param of paramParts) {
        const [k, v] = param.split("=");
        if (k && v) {
          params[k.trim().toUpperCase()] = v.trim().replace(/^"|"$/g, "");
        }
      }
    }

    propName = propName.trim().toUpperCase();
    currentFields[propName] = { value: valuePart, params };
  }

  return events;
}

function processVEvent(fields: Record<string, { value: string; params: Record<string, string> }>): ParsedIcsEvent | null {
  const summaryRaw = fields.SUMMARY?.value ?? "";
  const title = unescapeIcsText(summaryRaw).trim() || "未命名日程";

  const descRaw = fields.DESCRIPTION?.value ?? "";
  const description = unescapeIcsText(descRaw).trim();

  const locRaw = fields.LOCATION?.value ?? "";
  const location = unescapeIcsText(locRaw).trim();

  const uidRaw = fields.UID?.value ?? "";
  const uid = uidRaw.trim() || `ics-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const dtStartField = fields.DTSTART;
  if (!dtStartField) {
    // A VEVENT without DTSTART is invalid per RFC 5545
    return null;
  }

  const { iso: startIso, allDay: startAllDay } = parseIcsDate(dtStartField.value, dtStartField.params);

  let endIso = startIso;
  let allDay = startAllDay;

  const dtEndField = fields.DTEND;
  if (dtEndField) {
    const parsedEnd = parseIcsDate(dtEndField.value, dtEndField.params);
    endIso = parsedEnd.iso;
    if (parsedEnd.allDay) {
      allDay = true;
      // Per RFC 5545, exclusive end day for all-day events:
      // If start is 2026-10-04 and end is 2026-10-05, it represents a 1-day event ending on 2026-10-04 23:59:59.
      const startDate = new Date(startIso);
      const endDate = new Date(endIso);
      if (endDate.getTime() > startDate.getTime()) {
        const normalizedEnd = new Date(endDate.getTime() - 1000);
        endIso = normalizedEnd.toISOString();
      }
    }
  } else if (fields.DURATION) {
    const durationMs = parseIcsDurationMs(fields.DURATION.value);
    const startDate = new Date(startIso);
    endIso = new Date(startDate.getTime() + Math.max(0, durationMs)).toISOString();
  } else {
    // If no DTEND or DURATION:
    if (allDay) {
      // End at 23:59:59 of start day
      const d = new Date(startIso);
      d.setUTCHours(23, 59, 59, 999);
      endIso = d.toISOString();
    } else {
      // 1 hour default
      endIso = new Date(new Date(startIso).getTime() + 3600_000).toISOString();
    }
  }

  // Guard against end preceding start
  if (Date.parse(endIso) < Date.parse(startIso)) {
    endIso = startIso;
  }

  const rawCategory = fields.CATEGORIES?.value;
  const color = normalizeCalendarColor(rawCategory);

  return {
    uid,
    title,
    description,
    location,
    startAt: startIso,
    endAt: endIso,
    allDay,
    color,
  };
}
