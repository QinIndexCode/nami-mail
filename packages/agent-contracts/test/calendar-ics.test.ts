import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeIcsText,
  unescapeIcsText,
  foldIcsLine,
  unfoldIcsLines,
  generateIcs,
  parseIcs,
  parseIcsDate,
  parseIcsDurationMs,
  type CalendarEventExportSource,
} from "../src/calendar-ics.js";

test("calendar-ics: text escaping and unescaping roundtrip", () => {
  const original = "Line 1\nLine 2, with semicolon; and backslash \\ and details.";
  const escaped = escapeIcsText(original);
  assert.equal(escaped, "Line 1\\nLine 2\\, with semicolon\\; and backslash \\\\ and details.");
  const unescaped = unescapeIcsText(escaped);
  assert.equal(unescaped, original);
});

test("calendar-ics: line folding and unfolding preserves content", () => {
  const longLine = "DESCRIPTION:This is a very long line that should definitely exceed the seventy-five byte limit specified by RFC 5545 section 3.1 for testing purposes.";
  const folded = foldIcsLine(longLine, 75);
  assert.ok(folded.includes("\r\n "));
  const unfolded = unfoldIcsLines(folded);
  assert.equal(unfolded.length, 1);
  assert.equal(unfolded[0], longLine);
});

test("calendar-ics: parseIcsDate parses UTC and all-day values correctly", () => {
  const utc = parseIcsDate("20261004T123000Z");
  assert.equal(utc.allDay, false);
  assert.equal(utc.iso, "2026-10-04T12:30:00.000Z");

  const allDay = parseIcsDate("20261004", { VALUE: "DATE" });
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.iso, "2026-10-04T00:00:00.000Z");
});

test("calendar-ics: parseIcsDurationMs handles ISO durations", () => {
  assert.equal(parseIcsDurationMs("PT1H"), 3600_000);
  assert.equal(parseIcsDurationMs("PT30M"), 1800_000);
  assert.equal(parseIcsDurationMs("P1D"), 86400_000);
});

test("calendar-ics: generateIcs and parseIcs roundtrip", () => {
  const events: CalendarEventExportSource[] = [
    {
      id: "event-1",
      title: "Quarterly Strategy Meeting",
      description: "Discuss 2026 roadmap and milestones.\nPrepare slides in advance.",
      location: "Room A301 / Online",
      startAt: "2026-10-10T02:00:00.000Z",
      endAt: "2026-10-10T03:30:00.000Z",
      allDay: false,
      color: "purple",
    },
    {
      id: "event-2",
      title: "National Holiday",
      description: "Office closed",
      location: "",
      startAt: "2026-10-01T00:00:00.000Z",
      endAt: "2026-10-03T23:59:59.000Z",
      allDay: true,
      color: "amber",
    },
  ];

  const icsString = generateIcs(events, "Test Calendar");
  assert.ok(icsString.includes("BEGIN:VCALENDAR"));
  assert.ok(icsString.includes("SUMMARY:Quarterly Strategy Meeting"));
  assert.ok(icsString.includes("CATEGORIES:purple"));
  assert.ok(icsString.includes("END:VCALENDAR"));

  const parsed = parseIcs(icsString);
  assert.equal(parsed.length, 2);

  const first = parsed.find((e) => e.title === "Quarterly Strategy Meeting");
  assert.ok(first);
  assert.equal(first.location, "Room A301 / Online");
  assert.equal(first.startAt, "2026-10-10T02:00:00.000Z");
  assert.equal(first.endAt, "2026-10-10T03:30:00.000Z");
  assert.equal(first.allDay, false);
  assert.equal(first.color, "purple");

  const second = parsed.find((e) => e.title === "National Holiday");
  assert.ok(second);
  assert.equal(second.allDay, true);
  assert.equal(second.color, "amber");
});

test("calendar-ics: parse external real-world ICS sample with line folding and TZID", () => {
  const realIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
DTSTART;TZID=Asia/Shanghai:20261015T150000
DTEND;TZID=Asia/Shanghai:20261015T160000
DTSTAMP:20261004T100000Z
UID:google-event-12345@google.com
CREATED:20261004T090000Z
DESCRIPTION:Please join the conference via Zoom link:\\nhttps://
 example.com/j/123456789\\nPasscode: 9988
LAST-MODIFIED:20261004T095000Z
LOCATION:Hangzhou Innovation Park B2
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Architecture Design Review - Nami Mail
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`;

  const parsed = parseIcs(realIcs);
  assert.equal(parsed.length, 1);
  const event = parsed[0];
  assert.equal(event.title, "Architecture Design Review - Nami Mail");
  assert.equal(event.uid, "google-event-12345@google.com");
  assert.equal(event.location, "Hangzhou Innovation Park B2");
  assert.ok(event.description.includes("https://example.com/j/123456789"));
  assert.equal(event.allDay, false);
});
