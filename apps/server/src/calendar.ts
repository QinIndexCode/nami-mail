import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";
import type { DatabaseHandle } from "./db.js";

/**
 * Local calendar. Event title/description/location are encrypted at rest with
 * a derived master-key envelope (AES-256-GCM); start/end timestamps stay
 * plaintext so the month view's date-range query never needs to decrypt rows.
 * Timestamps are normalized to UTC before storage so range comparisons via
 * SQL string operators stay correct across timezone offsets.
 */

export const calendarEventColors = ["blue", "green", "amber", "red", "purple", "teal"] as const;
export type CalendarEventColor = typeof calendarEventColors[number];

export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  color: CalendarEventColor;
  createdAt: string;
  updatedAt: string;
};

const calendarPurpose = "nami-calendar-v1";
const maximumEventTitleLength = 300;
const maximumEventDescriptionLength = 10_000;
const maximumEventLocationLength = 500;

function calendarAad(id: string): string {
  return `calendar\0${id}\0v1`;
}

function withCalendarKey<T>(masterKey: Buffer, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, calendarPurpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

/** Normalizes an offset-bearing ISO timestamp to UTC so SQL comparisons are stable. */
function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export const calendarEventCreateSchema = z.object({
  title: z.string().trim().min(1).max(maximumEventTitleLength),
  description: z.string().trim().max(maximumEventDescriptionLength).optional(),
  location: z.string().trim().max(maximumEventLocationLength).optional(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  allDay: z.boolean().optional(),
  color: z.enum(calendarEventColors).optional(),
}).strict().superRefine((input, context) => {
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
    context.addIssue({
      code: "custom",
      path: ["endAt"],
      message: "The event end time must not precede its start time.",
    });
  }
});

export const calendarEventUpdateSchema = z.object({
  title: z.string().trim().min(1).max(maximumEventTitleLength).optional(),
  description: z.string().trim().max(maximumEventDescriptionLength).optional(),
  location: z.string().trim().max(maximumEventLocationLength).optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  allDay: z.boolean().optional(),
  color: z.enum(calendarEventColors).optional(),
}).strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "至少需要更新一个字段。" });

type CalendarEventRow = {
  id: string;
  title_enc: string;
  description_enc: string;
  location_enc: string;
  start_at: string;
  end_at: string;
  all_day: number;
  color: string;
  created_at: string;
  updated_at: string;
};

const calendarEventSelectColumns = "id, title_enc, description_enc, location_enc, start_at, end_at, all_day, color, created_at, updated_at";

function isCalendarEventColor(value: string): value is CalendarEventColor {
  return (calendarEventColors as readonly string[]).includes(value);
}

export function calendarEventFromRow(row: CalendarEventRow, masterKey: Buffer): CalendarEvent {
  return withCalendarKey(masterKey, (key) => ({
    id: row.id,
    title: decryptTextEnvelope(row.title_enc, key, calendarAad(row.id)),
    description: decryptTextEnvelope(row.description_enc, key, calendarAad(row.id)),
    location: decryptTextEnvelope(row.location_enc, key, calendarAad(row.id)),
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day === 1,
    color: isCalendarEventColor(row.color) ? row.color : "blue",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function writeCalendarEvent(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  values: {
    title: string;
    description: string;
    location: string;
    startAt: string;
    endAt: string;
    allDay: boolean;
    color: CalendarEventColor;
  },
  createdAt: string,
  updatedAt: string,
): CalendarEvent {
  withCalendarKey(masterKey, (key) => {
    db.prepare(`
      INSERT INTO calendar_events (id, title_enc, description_enc, location_enc, start_at, end_at, all_day, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      encryptTextEnvelope(values.title, key, calendarAad(id)),
      encryptTextEnvelope(values.description, key, calendarAad(id)),
      encryptTextEnvelope(values.location, key, calendarAad(id)),
      values.startAt,
      values.endAt,
      values.allDay ? 1 : 0,
      values.color,
      createdAt,
      updatedAt,
    );
  });
  const row = db.prepare(`SELECT ${calendarEventSelectColumns} FROM calendar_events WHERE id = ?`).get(id) as CalendarEventRow;
  return calendarEventFromRow(row, masterKey);
}

export function calendarEventForId(db: DatabaseHandle, masterKey: Buffer, id: string): CalendarEvent | undefined {
  const row = db.prepare(`SELECT ${calendarEventSelectColumns} FROM calendar_events WHERE id = ?`).get(id) as CalendarEventRow | undefined;
  return row ? calendarEventFromRow(row, masterKey) : undefined;
}

/**
 * Lists events that overlap the optional `after`/`before` range. The bounds are
 * exclusive: an event with `endAt <= after` or `startAt >= before` is outside.
 * Rows are ordered by start time for a stable month-view layout.
 */
export function listCalendarEvents(
  db: DatabaseHandle,
  masterKey: Buffer,
  range?: { after?: string; before?: string },
  limit = 1000,
): CalendarEvent[] {
  const after = range?.after === undefined ? undefined : normalizeTimestamp(range.after);
  const before = range?.before === undefined ? undefined : normalizeTimestamp(range.before);
  const rows = db.prepare(`
    SELECT ${calendarEventSelectColumns} FROM calendar_events
    WHERE (? IS NULL OR start_at < ?) AND (? IS NULL OR end_at > ?)
    ORDER BY start_at ASC
    LIMIT ?
  `).all(before ?? null, before ?? null, after ?? null, after ?? null, Math.max(1, Math.min(limit, 5000))) as CalendarEventRow[];
  return rows.map((row) => calendarEventFromRow(row, masterKey));
}

export function createCalendarEvent(
  db: DatabaseHandle,
  masterKey: Buffer,
  input: z.infer<typeof calendarEventCreateSchema>,
): CalendarEvent {
  const id = randomUUID();
  const now = new Date().toISOString();
  return writeCalendarEvent(db, masterKey, id, {
    title: input.title,
    description: input.description ?? "",
    location: input.location ?? "",
    startAt: normalizeTimestamp(input.startAt),
    endAt: normalizeTimestamp(input.endAt),
    allDay: input.allDay ?? false,
    color: input.color ?? "blue",
  }, now, now);
}

export class CalendarEventTimeConflictError extends Error {}

export function updateCalendarEvent(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  patch: z.infer<typeof calendarEventUpdateSchema>,
): CalendarEvent | undefined {
  const existing = calendarEventForId(db, masterKey, id);
  if (!existing) return undefined;
  const startAt = patch.startAt === undefined ? existing.startAt : normalizeTimestamp(patch.startAt);
  const endAt = patch.endAt === undefined ? existing.endAt : normalizeTimestamp(patch.endAt);
  if (Date.parse(endAt) < Date.parse(startAt)) {
    throw new CalendarEventTimeConflictError("The event end time must not precede its start time.");
  }
  const now = new Date().toISOString();
  withCalendarKey(masterKey, (key) => {
    db.prepare(`
      UPDATE calendar_events
      SET title_enc = ?, description_enc = ?, location_enc = ?, start_at = ?, end_at = ?, all_day = ?, color = ?, updated_at = ?
      WHERE id = ?
    `).run(
      encryptTextEnvelope(patch.title === undefined ? existing.title : patch.title, key, calendarAad(id)),
      encryptTextEnvelope(patch.description === undefined ? existing.description : patch.description, key, calendarAad(id)),
      encryptTextEnvelope(patch.location === undefined ? existing.location : patch.location, key, calendarAad(id)),
      startAt,
      endAt,
      (patch.allDay === undefined ? existing.allDay : patch.allDay) ? 1 : 0,
      patch.color === undefined ? existing.color : patch.color,
      now,
      id,
    );
  });
  const row = db.prepare(`SELECT ${calendarEventSelectColumns} FROM calendar_events WHERE id = ?`).get(id) as CalendarEventRow;
  return calendarEventFromRow(row, masterKey);
}

export function deleteCalendarEvent(db: DatabaseHandle, id: string): boolean {
  return db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id).changes === 1;
}
