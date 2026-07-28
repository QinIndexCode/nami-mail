import { z } from "zod";

export const AGENT_PROTOCOL_VERSION = "1.0" as const;
export const AGENT_CONTRACT_VERSION = 1 as const;
export const BROKER_PROTOCOL_VERSION = "1.0" as const;

export const agentProtocolVersionSchema = z.literal(AGENT_PROTOCOL_VERSION);
export const agentContractVersionSchema = z.literal(AGENT_CONTRACT_VERSION);

export const timestampSchema = z.string().datetime({ offset: true });
export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 digest.");
export const base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected base64 data.");

export const agentIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected an opaque identifier.");

export const accountIdSchema = agentIdentifierSchema;
export const messageIdSchema = agentIdentifierSchema;
export const threadIdSchema = agentIdentifierSchema;
export const attachmentIdSchema = agentIdentifierSchema;
export const conversationIdSchema = agentIdentifierSchema;
export const toolCallIdSchema = agentIdentifierSchema;
export const confirmationIdSchema = agentIdentifierSchema;
export const sourceEventIdSchema = agentIdentifierSchema;
export const auditEventIdSchema = agentIdentifierSchema;
export const providerIdSchema = agentIdentifierSchema;
export const clientIdSchema = agentIdentifierSchema;
export const hostIdSchema = agentIdentifierSchema;
export const bootIdSchema = agentIdentifierSchema;

export const requestIdSchema = z.string().uuid();
export const traceIdSchema = z.string().uuid();
export const nonEmptyTextSchema = z.string().trim().min(1).max(4_000);

export type AgentProtocolVersion = z.infer<typeof agentProtocolVersionSchema>;
