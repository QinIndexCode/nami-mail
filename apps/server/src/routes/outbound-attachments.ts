import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  cleanupExpiredOutboundAttachments,
  createOutboundAttachment,
  discardPendingOutboundAttachments,
  outboundAttachmentDirectory,
} from "../outbound-attachments.js";
import {
  decodedUploadHeader,
  outboundAttachmentErrorStatus,
  outboundAttachmentActionErrorMessage,
  validationMessage,
} from "../helpers.js";
import {
  outboundAttachmentDiscardSchema,
  outboundAttachmentUploadQuerySchema,
} from "../schemas.js";

export type OutboundAttachmentRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerOutboundAttachmentRoutes(app: FastifyInstance, deps: OutboundAttachmentRouteDeps): void {
  const { context, log } = deps;

  app.post<{ Querystring: { accountId?: string }; Body: Buffer }>(
    "/api/outbound-attachments",
    { bodyLimit: MAX_OUTBOUND_ATTACHMENT_BYTES },
    async (request, reply) => {
      const query = outboundAttachmentUploadQuerySchema.safeParse(request.query);
      const filename = decodedUploadHeader(request.headers["x-nami-file-name"]);
      const contentType = decodedUploadHeader(request.headers["x-nami-file-content-type"]);
      if (!query.success || !filename || !contentType) {
        return reply.code(400).send({ ok: false, message: "附件上传参数无效。" });
      }
      const directory = outboundAttachmentDirectory(context);
      try {
        cleanupExpiredOutboundAttachments(context.db, directory);
      } catch (error) {
        log.warn({ error }, "Could not complete stale outbound attachment cleanup");
      }
      try {
        const attachment = createOutboundAttachment(context.db, directory, context.masterKey, {
          accountId: query.data.accountId,
          filename,
          contentType,
          content: request.body,
        });
        return reply.code(201).send({ ok: true, attachment });
      } catch (error) {
        return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
      }
    },
  );

  app.delete("/api/outbound-attachments", async (request, reply) => {
    const parsed = outboundAttachmentDiscardSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const removed = discardPendingOutboundAttachments(
        context.db,
        outboundAttachmentDirectory(context),
        parsed.data.accountId,
        parsed.data.attachmentTokens,
      );
      return { ok: true, removed };
    } catch (error) {
      return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
    }
  });
}
