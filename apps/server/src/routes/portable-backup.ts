import { ROUTE_ERROR_CODES } from "./error-codes.js";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { BackupError, MAX_BACKUP_BYTES } from "../portable-backup-format.js";
import { restoreIdSchema } from "../portable-backup-storage.js";

export function registerPortableBackupRoutes(app: FastifyInstance, context: RuntimeContext): void {
  app.addContentTypeParser("application/x-nami-backup", (_request, payload, done) => done(null, payload));
  app.post("/api/app-backups/export", async (request, reply) => {
    if (!context.portableBackup) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.backup_unavailable, message: "Application backup requires the full local runtime." });
    const parsed = z.object({ password: z.string().min(12).max(256) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Use a backup password of 12–256 characters." });
    reply.type("application/x-nami-backup").header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="nami-mail-${new Date().toISOString().slice(0, 10)}.namibak"`);
    return reply.send(Readable.from(context.portableBackup.export(parsed.data.password)));
  });
  app.post<{ Body: Readable }>("/api/app-backups/preview", { bodyLimit: MAX_BACKUP_BYTES }, async (request, reply) => {
    if (!context.portableBackup) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.backup_unavailable, message: "Application restore requires the full local runtime." });
    if (!(request.body instanceof Readable)) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Select a .namibak file." });
    const header = request.headers["x-nami-backup-password"];
    if (typeof header !== "string" || header.length > 2048) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Backup password is required." });
    try { return await context.portableBackup.preview(request.body, Buffer.from(header, "base64").toString("utf8")); }
    catch (error) {
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: error instanceof BackupError ? error.message : "The backup is damaged or incompatible. Existing data was not changed." });
    }
  });
  app.post<{ Params: { id: string } }>("/api/app-backups/:id/activate", async (request, reply) => {
    if (!context.portableBackup) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.backup_unavailable, message: "Application restore requires the full local runtime." });
    const parsed = restoreIdSchema.safeParse(request.params.id);
    const confirmed = z.object({ confirm: z.literal(true) }).strict().safeParse(request.body);
    if (!parsed.success || !confirmed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Confirm a validated restore preview." });
    try { context.portableBackup.activate(parsed.data); return { ok: true, restartRequired: true }; }
    catch { return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "The restore preview is unavailable. Upload and verify the backup again." }); }
  });
  app.delete<{ Params: { id: string } }>("/api/app-backups/:id", async (request, reply) => {
    if (!context.portableBackup || !restoreIdSchema.safeParse(request.params.id).success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Invalid restore preview." });
    try { await context.portableBackup.discard(request.params.id); return { ok: true }; }
    catch { return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "An activated restore must be retained." }); }
  });
}
