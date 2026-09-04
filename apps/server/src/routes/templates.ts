import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  templateCreateSchema,
  templateUpdateSchema,
  updateTemplate,
} from "../templates.js";

export type TemplateRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerTemplateRoutes(app: FastifyInstance, deps: TemplateRouteDeps): void {
  const { context, log } = deps;

  app.get("/api/templates", async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, items: listTemplates(context.db, context.masterKey, parsed.data.q, parsed.data.limit) };
  });

  app.post("/api/templates", async (request, reply) => {
    const parsed = templateCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, template: createTemplate(context.db, context.masterKey, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const parsed = templateUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const template = updateTemplate(context.db, context.masterKey, request.params.id, parsed.data);
    if (!template) return reply.code(404).send({ ok: false, message: "模板不存在。" });
    return { ok: true, template };
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    if (!deleteTemplate(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "模板不存在。" });
    }
    return { ok: true };
  });
}
