import { ROUTE_ERROR_CODES } from "./error-codes.js";
import { simpleParser } from "mailparser";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import type { TaskStarter } from "../tasks/index.js";
import { taskRow } from "../tasks/index.js";
import { dismissTask, retryTaskItems, taskRecoveryDetails } from "../tasks/recovery.js";
import { submissionForId, submissionRequestForId } from "../outbox.js";
import { createOutboundAttachment, outboundAttachmentDirectory, resolveOutboundAttachments } from "../outbound-attachments.js";

export function registerTaskRecoveryRoutes(app: FastifyInstance, context: RuntimeContext, scheduler: TaskStarter): void {
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>("/api/tasks/:id/recovery", async (request, reply) => {
    const offset = z.coerce.number().int().min(0).max(1_000_000).safeParse(request.query.offset ?? 0);
    if (!offset.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Invalid recovery page." });
    const details = taskRecoveryDetails(context.db, context.masterKey, request.params.id, offset.data);
    return details ?? reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "Task not found." });
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
    const input = z.object({ messageIds: z.array(z.string().min(1)).min(1).max(1000) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Select up to 1000 task items." });
    try { return retryTaskItems({ db: context.db, masterKey: context.masterKey, scheduler, agentEvents: context.agentMailEvents }, request.params.id, input.data.messageIds); }
    catch { return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "Task cannot be repeated. Refresh and review its current state." }); }
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/dismiss", async (request, reply) => {
    if (!z.object({ acknowledge: z.literal(true) }).strict().safeParse(request.body).success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Explicit acknowledgment is required." });
    const task = taskRow(context.db, request.params.id);
    if (!task || task.completed_at === null) return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "Only a settled task can be dismissed." });
    dismissTask(context.db, task.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/submissions/:id/retry-draft", async (request, reply) => {
    const input = z.object({ confirmUnknown: z.boolean().optional() }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "Invalid retry draft request." });
    const submission = submissionForId(context.db, context.masterKey, request.params.id);
    const original = submission && submissionRequestForId(context.db, context.masterKey, request.params.id);
    if (!submission || !original) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "Submission not found." });
    if (submission.deliveryStatus === "unknown_delivery" && !input.data.confirmUnknown) return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "Check Sent and explicitly acknowledge the duplicate-delivery risk." });
    if (!["failed", "unknown_delivery"].includes(submission.deliveryStatus) && !submission.recipientDelivery?.rejected.length) return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "This submission does not need a retry." });
    const rejected = submission.recipientDelivery?.rejected;
    const recipients = (values: string[] = []) => (rejected?.length ? values.filter((address) => rejected.some((item) => item.address.toLowerCase() === address.toLowerCase())) : values).join(", ");
    const attachments = [];
    let missingAttachments = 0;
    const directory = outboundAttachmentDirectory(context);
    for (const token of original.attachmentTokens) {
      try {
        const [source] = resolveOutboundAttachments(context.db, directory, context.masterKey, submission.accountId, [token]);
        if (!source) throw new Error("Attachment is unavailable.");
        attachments.push(createOutboundAttachment(context.db, directory, context.masterKey, { accountId: submission.accountId, filename: source.filename, contentType: source.contentType, content: source.content }));
      } catch { missingAttachments++; }
    }
    const text = original.text || (original.html ? (await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${original.html}`))).text ?? "" : "");
    return { draft: { accountId: submission.accountId, to: recipients(original.to), cc: recipients(original.cc), bcc: recipients(original.bcc),
      subject: original.subject, text, inReplyTo: original.inReplyTo, references: original.references,
      attachments, recoveryMissingAttachments: missingAttachments }, missingAttachments };
  });
}
