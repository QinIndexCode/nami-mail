import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import { accountExists } from "../account-store.js";
import {
  createFilterRule,
  deleteFilterRule,
  filterRuleCreateSchema,
  filterRuleUpdateSchema,
  listFilterRules,
  updateFilterRule,
} from "../filter-rules.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";

export type FilterRuleRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerFilterRuleRoutes(app: FastifyInstance, deps: FilterRuleRouteDeps): void {
  const { context } = deps;

  app.get("/api/filter-rules", async (request, reply) => {
    const parsed = z.object({ accountId: z.string().trim().min(1).max(128).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    return { ok: true, rules: listFilterRules(context.db, parsed.data.accountId) };
  });

  app.post("/api/filter-rules", async (request, reply) => {
    const parsed = filterRuleCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    if (parsed.data.accountId) {
      const exists = accountExists(context.db, parsed.data.accountId);
      if (!exists) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "规则绑定的邮箱不存在。" });
    }
    return { ok: true, rule: createFilterRule(context.db, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/filter-rules/:id", async (request, reply) => {
    const parsed = filterRuleUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    if (parsed.data.accountId) {
      const exists = accountExists(context.db, parsed.data.accountId);
      if (!exists) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "规则绑定的邮箱不存在。" });
    }
    const rule = updateFilterRule(context.db, request.params.id, parsed.data);
    if (!rule) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "规则不存在。" });
    return { ok: true, rule };
  });

  app.delete<{ Params: { id: string } }>("/api/filter-rules/:id", async (request, reply) => {
    if (!deleteFilterRule(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "规则不存在。" });
    }
    return { ok: true };
  });
}
