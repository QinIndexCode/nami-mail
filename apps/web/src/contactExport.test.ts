import { describe, expect, it } from "vitest";
import { calendarEventIcs, exportDownloadFilename, vCardText } from "./contactExport";

describe("vCardText", () => {
  it("builds a vCard 3.0 document with CRLF endings", () => {
    const card = vCardText("Ada Lovelace", "ada@example.com");
    expect(card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(card).toContain("FN:Ada Lovelace\r\n");
    expect(card).toContain("EMAIL:ada@example.com\r\n");
    expect(card.endsWith("END:VCARD\r\n")).toBe(true);
    expect(card).not.toContain("\n\n");
  });

  it("falls back to the address as the display name", () => {
    const card = vCardText("", "ada@example.com");
    expect(card).toContain("FN:ada@example.com");
  });

  it("escapes vCard punctuation and strips line breaks", () => {
    const card = vCardText("Smith, John; Jr.\r\n(Dev)", "j@example.com");
    expect(card).toContain("FN:Smith\\, John\\; Jr. (Dev)");
  });

  it("folds long values at the 75-octet limit with a continuation space", () => {
    const longName = "A".repeat(120);
    const card = vCardText(longName, "a@example.com");
    const fnLine = card.split("\r\n").find((line) => line.startsWith("FN:") || line.startsWith(" ")) ?? "";
    expect(fnLine.length).toBeLessThanOrEqual(76);
    const unfolded = card.replace(/\r\n /g, "");
    expect(unfolded).toContain(`FN:${longName}`);
  });

  it("folds by octets, not code points", () => {
    // 30 CJK characters occupy 90 octets (3 each) but only 30 code points.
    const cjkName = "汉".repeat(30);
    const card = vCardText(cjkName, "a@example.com");
    const lines = card.split("\r\n").filter((line) => line.startsWith("FN:") || line.startsWith(" "));
    expect(lines.length).toBeGreaterThan(1);
    expect(card.replace(/\r\n /g, "")).toContain(`FN:${cjkName}`);
  });
});

describe("calendarEventIcs", () => {
  it("builds a minimal valid iCalendar event with UTC basic timestamps", () => {
    const start = new Date("2026-08-16T09:00:00.000Z");
    const end = new Date("2026-08-16T10:00:00.000Z");
    const ics = calendarEventIcs({ summary: "Quarterly report", start, end, uid: "event-1" });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("UID:event-1\r\n");
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z\r\n/);
    expect(ics).toContain("DTSTART:20260816T090000Z\r\n");
    expect(ics).toContain("DTEND:20260816T100000Z\r\n");
    expect(ics).toContain("SUMMARY:Quarterly report\r\n");
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toContain("\r\n\r\n");
  });

  it("escapes iCalendar text and includes the description when given", () => {
    const ics = calendarEventIcs({
      summary: "Plan, review; & release",
      description: "First line\nSecond line",
      start: new Date("2026-08-16T09:00:00.000Z"),
      end: new Date("2026-08-16T09:30:00.000Z"),
      uid: "event-2",
    });
    expect(ics).toContain("SUMMARY:Plan\\, review\\; & release\r\n");
    expect(ics).toContain("DESCRIPTION:First line\\nSecond line\r\n");
  });

  it("omits the description line when absent", () => {
    const ics = calendarEventIcs({
      summary: "Standup",
      start: new Date("2026-08-16T09:00:00.000Z"),
      end: new Date("2026-08-16T09:15:00.000Z"),
      uid: "event-3",
    });
    expect(ics).not.toContain("DESCRIPTION:");
  });
});

describe("exportDownloadFilename", () => {
  it("sanitizes separators and keeps the extension", () => {
    expect(exportDownloadFilename("Quarterly/report", "contact", "vcf")).toBe("Quarterly report.vcf");
    expect(exportDownloadFilename("", "contact", "vcf")).toBe("contact.vcf");
    expect(exportDownloadFilename("a\nb\tc", "event", "ics")).toBe("a b c.ics");
  });
});