/**
 * Client-side generators for vCard (.vcf) and iCalendar (.ics) exports.
 * Both are plain text formats generated locally; nothing leaves the device.
 */

/** Number of UTF-8 octets a string occupies (line folding is octet-based). */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Escapes vCard text and folds lines at the 75-octet RFC 2426 limit. */
function vCardLine(name: string, value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\r\n]+/g, " ");
  const prefix = `${name}:`;
  if (utf8Length(escaped) + prefix.length <= 75) return `${prefix}${escaped}`;
  const chunks: string[] = [];
  let current = prefix;
  for (const char of escaped) {
    if (utf8Length(current + char) > 75) {
      chunks.push(current);
      current = ` ${char}`;
    } else {
      current += char;
    }
  }
  if (current.length > 0) chunks.push(current);
  // Continuation chunks already carry the leading WSP; CRLF only separates.
  return chunks.join("\r\n");
}

/** Builds a vCard 3.0 document for one sender. */
export function vCardText(name: string, address: string): string {
  const displayName = name.trim() || address;
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    vCardLine("FN", displayName),
    address ? vCardLine("EMAIL", address) : "",
    "END:VCARD",
  ]
    .filter(Boolean)
    .join("\r\n") + "\r\n";
}

/** Escapes iCalendar text (backslash, semicolon, comma, newline). */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\r\n]+/g, "\\n");
}

/** Formats a Date as the UTC basic string iCalendar expects (20260718T090000Z). */
function icsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export type CalendarEventInput = {
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  uid: string;
};

/** Builds a minimal valid iCalendar event document (CRLF line endings). */
export function calendarEventIcs(event: CalendarEventInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nami Mail//Nami//EN",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(event.start)}`,
    `DTEND:${icsUtc(event.end)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** Derives a safe download filename from export text. */
export function exportDownloadFilename(text: string, fallback: string, extension: string): string {
  const cleaned = text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    // eslint-disable-next-line no-control-regex -- strips C0 controls from export names
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 60)
    .trim();
  return `${cleaned || fallback}.${extension}`;
}