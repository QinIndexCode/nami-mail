import test from "node:test";
import assert from "node:assert/strict";
import { parseIcsDate, parseIcs } from "../src/calendar-ics.js";

test("ICS honors TZID and seasonal offsets", () => {
  assert.equal(parseIcsDate("20261107T100000", { TZID: "Asia/Shanghai" }).iso, "2026-11-07T02:00:00.000Z");
  assert.equal(parseIcsDate("20260707T100000", { TZID: "America/New_York" }).iso, "2026-07-07T14:00:00.000Z");
  assert.equal(parseIcsDate("20261207T100000", { TZID: "America/New_York" }).iso, "2026-12-07T15:00:00.000Z");
});

test("ICS rejects invalid dates and unsupported zones without replacing them with now", () => {
  for (const input of ["not-a-date", "20260230", "20261301", "20261107T250000Z", "2026-02-30T12:00:00Z"]) assert.throws(() => parseIcsDate(input));
  assert.throws(() => parseIcsDate("20261107T100000", { TZID: "Unknown/Zone" }));
  assert.throws(() => parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:invalid\r\nEND:VEVENT\r\nEND:VCALENDAR"));
});

test("ICS handles repeated wall times and rejects nonexistent DST times explicitly", () => {
  assert.equal(parseIcsDate("20261101T013000", { TZID: "America/New_York" }).iso, "2026-11-01T05:30:00.000Z");
  assert.throws(() => parseIcsDate("20260308T023000", { TZID: "America/New_York" }));
});

test("floating ICS times retain local wall time while UTC and date-only stay stable", () => {
  assert.equal(parseIcsDate("20261107T100000").iso, new Date(2026, 10, 7, 10).toISOString());
  assert.equal(parseIcsDate("20261107T100000Z").iso, "2026-11-07T10:00:00.000Z");
  assert.deepEqual(parseIcsDate("20261107"), { iso: "2026-11-07T00:00:00.000Z", allDay: true });
});
