import { z } from "zod";
import { accountIdSchema, messageIdSchema, threadIdSchema, timestampSchema } from "./primitives.js";

export const citationSourceSchema = z.enum(["message", "thread", "rag-chunk"]);

export const citationSchema = z.object({
  id: z.string().trim().min(1).max(128),
  source: citationSourceSchema,
  accountId: accountIdSchema,
  messageId: messageIdSchema,
  threadId: threadIdSchema.optional(),
  chunkId: z.string().trim().min(1).max(256).optional(),
  subject: z.string().max(998),
  sender: z.string().trim().min(1).max(512).optional(),
  sentAt: timestampSchema.optional(),
  mailbox: z.string().trim().min(1).max(512).optional(),
  excerpt: z.string().trim().min(1).max(1_500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceRevision: z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(256)]).optional(),
  target: z.object({
    kind: z.enum(["message", "thread"]),
    id: z.string().trim().min(1).max(128),
  }).strict(),
}).strict();

export type CitationSource = z.infer<typeof citationSourceSchema>;
export type Citation = z.infer<typeof citationSchema>;
