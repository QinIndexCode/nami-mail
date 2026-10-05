import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import { generateIcs, parseIcs } from "@nami/agent-contracts";
import {
  CalendarEventTimeConflictError,
  calendarEventCreateSchema,
  calendarEventUpdateSchema,
  createCalendarEvent,
  deleteCalendarEvent,
  importCalendarEvents,
  listCalendarEvents,
  updateCalendarEvent,
} from "../calendar.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";

export type CalendarRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerCalendarRoutes(app: FastifyInstance, deps: CalendarRouteDeps): void {
  const { context } = deps;

  app.get("/api/calendar/events", async (request, reply) => {
    const parsed = z.object({
      after: z.string().datetime({ offset: true }).optional(),
      before: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    return { ok: true, items: listCalendarEvents(context.db, context.masterKey, { after: parsed.data.after, before: parsed.data.before }, parsed.data.limit) };
  });

  app.post("/api/calendar/events", async (request, reply) => {
    const parsed = calendarEventCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    return { ok: true, event: createCalendarEvent(context.db, context.masterKey, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/calendar/events/:id", async (request, reply) => {
    const parsed = calendarEventUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      const event = updateCalendarEvent(context.db, context.masterKey, request.params.id, parsed.data);
      if (!event) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "事件不存在。" });
      return { ok: true, event };
    } catch (error) {
      if (error instanceof CalendarEventTimeConflictError) {
        return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "事件结束时间不能早于开始时间。" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/calendar/events/:id", async (request, reply) => {
    if (!deleteCalendarEvent(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "事件不存在。" });
    }
    return { ok: true };
  });

  app.post("/api/calendar/import", async (request, reply) => {
    const parsed = z.object({
      events: z.array(calendarEventCreateSchema).min(1).max(5000),
      mode: z.enum(["append", "replace"]).default("append"),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const result = importCalendarEvents(context.db, context.masterKey, parsed.data.events, parsed.data.mode);
    return { ok: true, imported: result.imported, updated: result.updated, replaced: result.replaced };
  });

  app.post("/api/calendar/import-ics", async (request, reply) => {
    const parsed = z.object({
      ics: z.string().min(1).max(10_000_000),
      mode: z.enum(["append", "replace"]).default("append"),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const parsedEvents = parseIcs(parsed.data.ics);
    if (parsedEvents.length === 0) {
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "未能从 ICS 内容中解析出有效的日程事件。" });
    }
    const validatedEvents: Array<z.infer<typeof calendarEventCreateSchema>> = [];
    for (const item of parsedEvents) {
      const valid = calendarEventCreateSchema.safeParse({
        uid: item.uid,
        title: item.title,
        description: item.description,
        location: item.location,
        startAt: item.startAt,
        endAt: item.endAt,
        allDay: item.allDay,
        color: item.color,
      });
      if (valid.success) {
        validatedEvents.push(valid.data);
      }
    }
    if (validatedEvents.length === 0) {
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "解析出的日程事件校验未通过。" });
    }
    const result = importCalendarEvents(context.db, context.masterKey, validatedEvents, parsed.data.mode);
    return { ok: true, imported: result.imported, updated: result.updated, replaced: result.replaced };
  });

  app.get("/api/calendar/export.ics", async (request, reply) => {
    const parsed = z.object({
      after: z.string().datetime({ offset: true }).optional(),
      before: z.string().datetime({ offset: true }).optional(),
    }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const events = listCalendarEvents(context.db, context.masterKey, { after: parsed.data.after, before: parsed.data.before }, 5000);
    const icsText = generateIcs(events, "Nami Calendar");
    reply.header("Content-Type", "text/calendar; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="nami-calendar.ics"');
    return reply.send(icsText);
  });
}
