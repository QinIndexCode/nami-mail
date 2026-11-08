import { ROUTE_ERROR_CODES } from "./error-codes.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import { clearImageGrants, setMessageImageGrant, ensureImagePolicySchema, imagePolicySchema, messageImagePermission, readImagePolicy, writeImagePolicy } from "../image-policy.js";

export function registerImagePolicyRoutes(app: FastifyInstance, context: RuntimeContext): void {
  const { db, masterKey } = context;
  ensureImagePolicySchema(db);
  app.get("/api/image-policy", async () => readImagePolicy(db, masterKey));
  app.delete("/api/image-policy/grants", async () => { clearImageGrants(db); return { ok: true }; });
  app.patch("/api/image-policy", async (request, reply) => {
    const parsed = imagePolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Invalid image policy." });
    return writeImagePolicy(db, masterKey, parsed.data);
  });
  app.get<{ Params: { id: string } }>("/api/messages/:id/images/permission", async (request, reply) => {
    const permission = messageImagePermission(db, masterKey, request.params.id);
    return permission.exists ? permission : reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "Message not found." });
  });
  app.post<{ Params: { id: string } }>("/api/messages/:id/images/allow", async (request, reply) => {
    const parsed = z.object({ trustSender: z.boolean().optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Invalid image authorization." });
    const permission = messageImagePermission(db, masterKey, request.params.id);
    if (!permission.exists) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "Message not found." });
    if (parsed.data.trustSender) {
      if (!z.email().safeParse(permission.sender).success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Sender has no valid email address." });
      const policy = readImagePolicy(db, masterKey);
      writeImagePolicy(db, masterKey, { ...policy, trustedSenders: [...policy.trustedSenders, permission.sender] });
    } else setMessageImageGrant(db, request.params.id, true);
    return messageImagePermission(db, masterKey, request.params.id);
  });
  app.delete<{ Params: { id: string } }>("/api/messages/:id/images/allow", async (request) => {
    setMessageImageGrant(db, request.params.id, false);
    return messageImagePermission(db, masterKey, request.params.id);
  });
}
