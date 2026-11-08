import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createCalendarEvent, listCalendarEvents } from "../src/calendar.js";

describe("calendar completeness and import validation", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const key = Buffer.alloc(32, 0x32);
  beforeEach(async () => { db = openDatabase(":memory:"); app = await buildApp({ db, masterKey: key }); });
  afterEach(async () => { await app.close(); db.close(); });

  it("paginates beyond 1000 historical events, including equal start times, without losing the current event", async () => {
    db.transaction(() => {
      for (let i = 0; i < 1001; i++) createCalendarEvent(db, key, { title: `History ${i}`, startAt: "2020-01-01T01:00:00Z", endAt: "2020-01-01T02:00:00Z" });
    })();
    const current = createCalendarEvent(db, key, { title: "Current", startAt: "2026-11-07T01:00:00Z", endAt: "2026-11-07T02:00:00Z" });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await app.inject({ method: "GET", url: `/api/calendar/events?limit=200${cursor ? `&cursor=${cursor}` : ""}` });
      expect(response.statusCode).toBe(200);
      const page = response.json() as { items: Array<{ id: string }>; nextCursor?: string };
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(1002);
    expect(new Set(ids).size).toBe(1002);
    expect(ids.at(-1)).toBe(current.id);
    const range = await app.inject({ method: "GET", url: "/api/calendar/events?after=2026-11-01T00:00:00Z&before=2026-12-01T00:00:00Z" });
    expect(range.json().items.map((item: { id: string }) => item.id)).toEqual([current.id]);
  });

  it("rejects a malformed cursor", async () => {
    expect((await app.inject({ method: "GET", url: "/api/calendar/events?cursor=invalid" })).statusCode).toBe(400);
  });

  it("preserves identity when locally created or legacy UID-less events are exported and reimported", async () => {
    const original = createCalendarEvent(db, key, { title: "Local", startAt: "2026-11-07T01:00:00Z", endAt: "2026-11-07T02:00:00Z" });
    expect(original.uid).toBe(original.id);
    db.prepare("UPDATE calendar_events SET uid=NULL WHERE id=?").run(original.id);
    const exported = await app.inject({ method: "GET", url: "/api/calendar/export.ics" });
    const imported = await app.inject({ method: "POST", url: "/api/calendar/import-ics", payload: { ics: exported.body } });
    expect(imported.json()).toMatchObject({ imported: 0, updated: 1 });
    expect(listCalendarEvents(db, key).map((item) => item.id)).toEqual([original.id]);
  });

  it("rejects invalid ICS before a replace import can delete existing events", async () => {
    const original = createCalendarEvent(db, key, { title: "Keep", startAt: "2026-11-07T01:00:00Z", endAt: "2026-11-07T02:00:00Z" });
    const response = await app.inject({ method: "POST", url: "/api/calendar/import-ics", payload: { mode: "replace", ics: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken\r\nDTSTART:invalid\r\nEND:VEVENT\r\nEND:VCALENDAR" } });
    expect(response.statusCode).toBe(400);
    expect(listCalendarEvents(db, key).map((item) => item.id)).toEqual([original.id]);
  });
});
