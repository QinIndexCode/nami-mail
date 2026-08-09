import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  CalendarEventTimeConflictError,
  calendarEventCreateSchema,
  calendarEventForId,
  calendarEventUpdateSchema,
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from "../src/calendar.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

describe("calendar events", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 9);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("creates, lists, updates and deletes events with encrypted storage", () => {
    const created = createCalendarEvent(db, masterKey, {
      title: "Design review",
      description: "Monthly design sync",
      location: "Room 4",
      startAt: "2026-08-10T09:00:00+08:00",
      endAt: "2026-08-10T10:00:00+08:00",
      color: "purple",
    });
    expect(created.title).toBe("Design review");
    // Timestamps are normalized to UTC so range comparisons are stable.
    expect(created.startAt).toBe("2026-08-10T01:00:00.000Z");

    // The stored columns are ciphertext, never the plaintext event.
    const row = db.prepare("SELECT title_enc, description_enc, location_enc FROM calendar_events WHERE id = ?").get(created.id) as {
      title_enc: string;
      description_enc: string;
      location_enc: string;
    };
    expect(row.title_enc).not.toContain("Design review");
    expect(row.description_enc).not.toContain("design sync");
    expect(row.location_enc).not.toContain("Room 4");
    expect(row.title_enc).toMatch(/^nami-v1\./);

    const listed = listCalendarEvents(db, masterKey);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Design review");
    expect(listed[0]?.color).toBe("purple");

    const updated = updateCalendarEvent(db, masterKey, created.id, { title: "Design review (moved)", color: "green" });
    expect(updated?.title).toBe("Design review (moved)");
    expect(updated?.color).toBe("green");
    expect(updated?.description).toBe("Monthly design sync");

    // Clearing an optional field is supported by an explicit empty string.
    const cleared = updateCalendarEvent(db, masterKey, created.id, { location: "" });
    expect(cleared?.location).toBe("");

    expect(deleteCalendarEvent(db, created.id)).toBe(true);
    expect(deleteCalendarEvent(db, created.id)).toBe(false);
    expect(listCalendarEvents(db, masterKey)).toHaveLength(0);
    expect(calendarEventForId(db, masterKey, created.id)).toBeUndefined();
  });

  it("filters events by an overlapping time range using normalized timestamps", () => {
    createCalendarEvent(db, masterKey, {
      title: "Morning standup",
      startAt: "2026-08-05T01:00:00Z",
      endAt: "2026-08-05T01:30:00Z",
    });
    createCalendarEvent(db, masterKey, {
      title: "Launch party",
      startAt: "2026-08-20T12:00:00Z",
      endAt: "2026-08-20T16:00:00Z",
    });
    // Offset-bearing bound must be normalized before the SQL comparison.
    const midMonth = listCalendarEvents(db, masterKey, { after: "2026-08-10T00:00:00+08:00", before: "2026-08-25T00:00:00Z" });
    expect(midMonth.map((event) => event.title)).toEqual(["Launch party"]);

    const beforeMonth = listCalendarEvents(db, masterKey, { before: "2026-08-01T00:00:00Z" });
    expect(beforeMonth).toHaveLength(0);
    expect(listCalendarEvents(db, masterKey)).toHaveLength(2);
  });

  it("rejects an end time before the start time", () => {
    expect(
      calendarEventCreateSchema.safeParse({
        title: "Broken",
        startAt: "2026-08-10T10:00:00Z",
        endAt: "2026-08-10T09:00:00Z",
      }).success,
    ).toBe(false);

    const created = createCalendarEvent(db, masterKey, {
      title: "Valid",
      startAt: "2026-08-10T09:00:00Z",
      endAt: "2026-08-10T10:00:00Z",
    });
    expect(() => updateCalendarEvent(db, masterKey, created.id, { endAt: "2026-08-10T08:00:00Z" })).toThrow(CalendarEventTimeConflictError);
  });

  it("exposes CRUD through the local API", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/calendar/events",
      payload: {
        title: "Team offsite",
        description: "All hands",
        location: "Parkside",
        startAt: "2026-09-01T00:00:00Z",
        endAt: "2026-09-03T00:00:00Z",
        allDay: true,
        color: "teal",
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as { ok: boolean; event: { id: string; title: string; allDay: boolean; color: string } };
    expect(createdBody).toMatchObject({ ok: true });
    expect(createdBody.event.title).toBe("Team offsite");
    expect(createdBody.event.allDay).toBe(true);
    expect(createdBody.event.color).toBe("teal");

    const listed = await app.inject({ method: "GET", url: "/api/calendar/events?after=2026-08-01T00:00:00Z&before=2026-10-01T00:00:00Z" });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: Array<{ id: string }> }).items).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/calendar/events/${createdBody.event.id}`,
      payload: { title: "Team offsite (postponed)" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { event: { title: string } }).event.title).toBe("Team offsite (postponed)");

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/calendar/events/does-not-exist",
      payload: { title: "X" },
    });
    expect(missing.statusCode).toBe(404);

    const invalidRange = await app.inject({
      method: "PATCH",
      url: `/api/calendar/events/${createdBody.event.id}`,
      payload: { startAt: "2026-09-05T00:00:00Z", endAt: "2026-09-01T00:00:00Z" },
    });
    expect(invalidRange.statusCode).toBe(400);

    const deleted = await app.inject({ method: "DELETE", url: `/api/calendar/events/${createdBody.event.id}` });
    expect(deleted.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: "/api/calendar/events" });
    expect((gone.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("validates event input through the strict schema", async () => {
    const missingTitle = await app.inject({
      method: "POST",
      url: "/api/calendar/events",
      payload: { startAt: "2026-08-10T09:00:00Z", endAt: "2026-08-10T10:00:00Z" },
    });
    expect(missingTitle.statusCode).toBe(400);

    const badColor = await app.inject({
      method: "POST",
      url: "/api/calendar/events",
      payload: { title: "X", startAt: "2026-08-10T09:00:00Z", endAt: "2026-08-10T10:00:00Z", color: "neon" },
    });
    expect(badColor.statusCode).toBe(400);

    expect(calendarEventUpdateSchema.safeParse({ title: "Renamed" }).success).toBe(true);
    expect(calendarEventUpdateSchema.safeParse({}).success).toBe(false);
  });
});
