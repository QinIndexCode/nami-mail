import { z } from "zod";
import { callerContextSchema, type CallerContext } from "./caller.js";
import { agentErrorSchema, type AgentError } from "./errors.js";
import {
  AGENT_CONTRACT_VERSION,
  AGENT_PROTOCOL_VERSION,
  agentContractVersionSchema,
  agentProtocolVersionSchema,
  requestIdSchema,
  timestampSchema,
  traceIdSchema,
} from "./primitives.js";

export const agentRequestMetaSchema = z.object({
  sentAt: timestampSchema,
  traceId: traceIdSchema.optional(),
}).strict();

export const agentResponseMetaSchema = z.object({
  contractVersion: agentContractVersionSchema,
  durationMs: z.number().int().nonnegative(),
  traceId: traceIdSchema.optional(),
}).strict();

export function agentRequestEnvelopeSchema<TPayload extends z.ZodType>(payloadSchema: TPayload) {
  return z.object({
    protocolVersion: agentProtocolVersionSchema,
    requestId: requestIdSchema,
    caller: callerContextSchema,
    payload: payloadSchema,
    meta: agentRequestMetaSchema,
  }).strict();
}

export function agentSuccessEnvelopeSchema<TData extends z.ZodType>(dataSchema: TData) {
  return z.object({
    protocolVersion: agentProtocolVersionSchema,
    requestId: requestIdSchema,
    success: z.literal(true),
    data: dataSchema,
    error: z.null(),
    meta: agentResponseMetaSchema,
  }).strict();
}

export const agentFailureEnvelopeSchema = z.object({
  protocolVersion: agentProtocolVersionSchema,
  requestId: requestIdSchema,
  success: z.literal(false),
  data: z.null(),
  error: agentErrorSchema,
  meta: agentResponseMetaSchema,
}).strict();

export function agentResponseEnvelopeSchema<TData extends z.ZodType>(dataSchema: TData) {
  return z.discriminatedUnion("success", [
    agentSuccessEnvelopeSchema(dataSchema),
    agentFailureEnvelopeSchema,
  ]);
}

export type AgentRequestMeta = z.infer<typeof agentRequestMetaSchema>;
export type AgentResponseMeta = z.infer<typeof agentResponseMetaSchema>;
export type AgentRequestEnvelope<TPayload> = {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  caller: CallerContext;
  payload: TPayload;
  meta: AgentRequestMeta;
};
export type AgentSuccessEnvelope<TData> = {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  success: true;
  data: TData;
  error: null;
  meta: AgentResponseMeta;
};
export type AgentFailureEnvelope = {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  success: false;
  data: null;
  error: AgentError;
  meta: AgentResponseMeta;
};
export type AgentResponseEnvelope<TData> = AgentSuccessEnvelope<TData> | AgentFailureEnvelope;

export function createAgentSuccessEnvelope<TData>(input: Omit<AgentSuccessEnvelope<TData>, "protocolVersion" | "success" | "error" | "meta"> & {
  meta?: Omit<AgentResponseMeta, "contractVersion">;
}): AgentSuccessEnvelope<TData> {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: input.requestId,
    success: true,
    data: input.data,
    error: null,
    meta: {
      contractVersion: AGENT_CONTRACT_VERSION,
      durationMs: input.meta?.durationMs ?? 0,
      ...(input.meta?.traceId ? { traceId: input.meta.traceId } : {}),
    },
  };
}

export function createAgentFailureEnvelope(input: Omit<AgentFailureEnvelope, "protocolVersion" | "success" | "data" | "meta"> & {
  meta?: Omit<AgentResponseMeta, "contractVersion">;
}): AgentFailureEnvelope {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: input.requestId,
    success: false,
    data: null,
    error: input.error,
    meta: {
      contractVersion: AGENT_CONTRACT_VERSION,
      durationMs: input.meta?.durationMs ?? 0,
      ...(input.meta?.traceId ? { traceId: input.meta.traceId } : {}),
    },
  };
}
