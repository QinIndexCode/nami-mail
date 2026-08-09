import { z } from "zod";
import { nonEmptyTextSchema } from "./primitives.js";

export const agentErrorCodes = [
  "INVALID_ARGUMENT",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL",
  "VERSION_MISMATCH",
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "SCOPE_DENIED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_REJECTED",
  "NOT_FOUND",
  "NOT_SUPPORTED",
  "HOST_UNAVAILABLE",
  "HOST_LEASE_UNAVAILABLE",
  "BROKER_SECURITY_UNAVAILABLE",
  "BROKER_PROTOCOL_UNSUPPORTED",
  "BROKER_AUTHENTICATION_FAILED",
  "BROKER_REPLAY_DETECTED",
  "BROKER_COUNTER_INVALID",
  "PAIRING_REQUIRED",
  "PAIRING_REVOKED",
  "PAIRING_EXPIRED",
  "UPDATE_IN_PROGRESS",
  "CLI_RUNTIME_FORBIDDEN",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
  "TOOL_NOT_FOUND",
  "TOOL_INPUT_INVALID",
  "TOOL_EXECUTION_FAILED",
  "TOOL_TIMEOUT",
  "RAG_UNAVAILABLE",
  "RAG_NOT_READY",
  "ACCOUNT_UNAVAILABLE",
  "ACCOUNT_STALE",
  "CONTEXT_TOO_LARGE",
  "CONFLICT",
  "CANCELLED",
  "TRANSPORT_UNAVAILABLE",
  "INTERNAL",
] as const;

export const agentErrorCodeSchema = z.enum(agentErrorCodes);

export const agentErrorSchema = z.object({
  code: agentErrorCodeSchema,
  message: nonEmptyTextSchema,
  retryable: z.boolean(),
  suggestion: z.string().trim().min(1).max(1_000).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>;
export type AgentError = z.infer<typeof agentErrorSchema>;
export type AgentErrorInput = Omit<AgentError, "retryable"> & { retryable?: boolean };

export function createAgentError(input: AgentErrorInput): AgentError {
  return agentErrorSchema.parse({ ...input, retryable: input.retryable ?? false });
}

export function notSupportedError(operation: string, suggestion?: string): AgentError {
  return createAgentError({
    code: "NOT_SUPPORTED",
    message: `${operation} is not supported by this Nami Mail Agent host.`,
    suggestion,
  });
}

export function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return agentErrorCodeSchema.safeParse(value).success;
}
