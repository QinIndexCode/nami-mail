import { z } from "zod";
import { timestampSchema } from "./primitives.js";

/**
 * Non-secret summary of one external CLI/MCP pairing. It crosses the desktop
 * Broker → local server → renderer boundary, so it must never carry keys,
 * counters, or payload material. Revoked entries stay visible so the user can
 * tell a revoked profile from a missing one.
 */
export const externalPairingSummarySchema = z.object({
  clientId: z.string().trim().min(1).max(160),
  createdAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  revokedAt: timestampSchema.optional(),
  accountIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
}).strict();

export type ExternalPairingSummary = z.infer<typeof externalPairingSummarySchema>;