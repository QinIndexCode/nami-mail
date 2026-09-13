import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import {
  CalendarEventTimeConflictError,
  calendarEventCreateSchema,
  calendarEventUpdateSchema,
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from "../calendar.js";

export type CalendarRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerCalendarRoutes(app: FastifyInstance, deps: CalendarRouteDeps): void {
  const { context, log } = deps;

  app.get("/api/calendar/events", async (request, reply) => {
    const parsed = z.object({
      after: z.string().datetime({ offset: true }).optional(),
      before: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, items: listCalendarEvents(context.db, context.masterKey, { after: parsed.data.after, before: parsed.data.before }, parsed.data.limit) };
  });

  app.post("/api/calendar/events", async (request, reply) => {
    const parsed = calendarEventCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, event: createCalendarEvent(context.db, context.masterKey, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/calendar/events/:id", async (request, reply) => {
    const parsed = calendarEventUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const event = updateCalendarEvent(context.db, context.masterKey, request.params.id, parsed.data);
      if (!event) return reply.code(404).send({ ok: false, message: "事件不存在。" });
      return { ok: true, event };
    } catch (error) {
      if (error instanceof CalendarEventTimeConflictError) {
        return reply.code(400).send({ ok: false, message: "事件结束时间不能早于开始时间。" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/calendar/events/:id", async (request, reply) => {
    if (!deleteCalendarEvent(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "事件不存在。" });
    }
    return { ok: true };
  });
}
