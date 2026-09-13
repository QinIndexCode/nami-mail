import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import {
  ContactConflictError,
  contactCreateSchema,
  contactUpdateSchema,
  createContact,
  deleteContact,
  listContacts,
  updateContact,
} from "../contacts.js";

export type ContactRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerContactRoutes(app: FastifyInstance, deps: ContactRouteDeps): void {
  const { context, log } = deps;

  app.get("/api/contacts", async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().max(320).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, items: listContacts(context.db, context.masterKey, parsed.data.q, parsed.data.limit) };
  });

  app.post("/api/contacts", async (request, reply) => {
    const parsed = contactCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      return { ok: true, contact: createContact(context.db, context.masterKey, parsed.data) };
    } catch (error) {
      if (error instanceof ContactConflictError) {
        return reply.code(409).send({ ok: false, code: "contact_exists", message: "该邮箱已在地址簿中。" });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/contacts/:id", async (request, reply) => {
    const parsed = contactUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const contact = updateContact(context.db, context.masterKey, request.params.id, parsed.data);
      if (!contact) return reply.code(404).send({ ok: false, message: "联系人不存在。" });
      return { ok: true, contact };
    } catch (error) {
      if (error instanceof ContactConflictError) {
        return reply.code(409).send({ ok: false, code: "contact_exists", message: "该邮箱已在地址簿中。" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/contacts/:id", async (request, reply) => {
    if (!deleteContact(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "联系人不存在。" });
    }
    return { ok: true };
  });
}
