import { z } from "zod";

const schema = z.object({ startAt: z.string().datetime(), id: z.string().min(1).max(256) }).strict();
export type CalendarCursor = z.infer<typeof schema>;
export function encodeCalendarCursor(value: CalendarCursor): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
export function decodeCalendarCursor(value: string): CalendarCursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid calendar cursor.");
  return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
}
