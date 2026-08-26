import { z } from "zod";
import type { AGENT_PROTOCOL_VERSION} from "./primitives.js";
import { accountIdSchema, agentProtocolVersionSchema } from "./primitives.js";

const brokerIdentifierPattern = /^[A-Za-z0-9_-]{16,160}$/;
const brokerRequestIdPattern = /^[A-Za-z0-9_-]{16,160}$/;
const brokerCounterPattern = /^(0|[1-9]\d{0,18})$/;
const brokerTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const brokerBase64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maxBrokerCounter = 9_223_372_036_854_775_807n;

export const brokerProtocolVersionSchema = agentProtocolVersionSchema;
export const brokerIdentifierSchema = z.string().regex(brokerIdentifierPattern, "Expected a Broker identity.");
export const brokerRequestIdSchema = z.string().regex(brokerRequestIdPattern, "Expected a Broker request identifier.");
export const brokerCounterSchema = z.string().regex(brokerCounterPattern, "Expected an unsigned decimal counter.").refine(
  (counter) => BigInt(counter) <= maxBrokerCounter,
  "Broker counters cannot exceed signed 64-bit range.",
);
export const brokerTimestampSchema = z.string().regex(brokerTimestampPattern, "Expected a UTC ISO-8601 timestamp.").refine(
  (timestamp) => Number.isFinite(Date.parse(timestamp)),
  "Expected a valid timestamp.",
);
export const brokerDetachedSignatureSchema = z.string().regex(brokerBase64UrlPattern, "Expected a base64url detached signature.");
export const brokerPublicKeyPemSchema = z.string()
  .min(64)
  .max(16_384)
  .regex(/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/, "Expected an SPKI public key PEM.")
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value), "PEM cannot contain control characters.");

export type BrokerJsonValue = null | boolean | number | string | BrokerJsonValue[] | { [key: string]: BrokerJsonValue };

export const brokerJsonValueSchema: z.ZodType<BrokerJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(brokerJsonValueSchema),
  z.record(z.string(), brokerJsonValueSchema),
]));

export const brokerHostIdentityProofSchema = z.object({
  protocolVersion: brokerProtocolVersionSchema,
  hostId: brokerIdentifierSchema,
  bootId: brokerIdentifierSchema,
  publicKeyPem: brokerPublicKeyPemSchema,
  issuedAt: brokerTimestampSchema,
  signature: brokerDetachedSignatureSchema,
}).strict();

export const brokerClientIdentitySchema = z.object({
  clientId: brokerIdentifierSchema,
  publicKeyPem: brokerPublicKeyPemSchema,
}).strict();

export const brokerHostIdentitySchema = z.object({
  hostId: brokerIdentifierSchema,
  publicKeyPem: brokerPublicKeyPemSchema,
}).strict();

export const brokerPairingScopeSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "Expected a Broker pairing scope.");
export const brokerPairingRecordSchema = z.object({
  schemaVersion: z.literal(1),
  clientId: brokerIdentifierSchema,
  clientPublicKeyPem: brokerPublicKeyPemSchema,
  hostId: brokerIdentifierSchema,
  hostPublicKeyPem: brokerPublicKeyPemSchema,
  scopes: z.array(brokerPairingScopeSchema).max(32).refine(
    (scopes) => new Set(scopes).size === scopes.length,
    "Broker pairing scopes cannot contain duplicates.",
  ),
  // Pairings created before scoped external access shipped omit this field and
  // deliberately fail closed until the user pairs again.
  accountIds: z.array(accountIdSchema).min(1).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Broker pairing account IDs cannot contain duplicates.",
  ).optional(),
  createdAt: brokerTimestampSchema,
  lastAcceptedCounter: brokerCounterSchema,
  revokedAt: brokerTimestampSchema.optional(),
}).strict();

export function brokerRequestFrameSchema<TPayload extends z.ZodType>(payloadSchema: TPayload) {
  return z.object({
    type: z.literal("request"),
    protocolVersion: brokerProtocolVersionSchema,
    requestId: brokerRequestIdSchema,
    hostId: brokerIdentifierSchema,
    bootId: brokerIdentifierSchema,
    clientId: brokerIdentifierSchema,
    counter: brokerCounterSchema,
    payload: payloadSchema,
    signature: brokerDetachedSignatureSchema,
  }).strict();
}

export function brokerResponseFrameSchema<TPayload extends z.ZodType>(payloadSchema: TPayload) {
  return z.object({
    type: z.literal("response"),
    protocolVersion: brokerProtocolVersionSchema,
    requestId: brokerRequestIdSchema,
    requestCounter: brokerCounterSchema,
    hostIdentity: brokerHostIdentityProofSchema,
    payload: payloadSchema,
    signature: brokerDetachedSignatureSchema,
  }).strict();
}

// Envelope aliases preserve the transport-neutral API name while using the exact signed frame shape.
export const brokerRequestEnvelopeSchema = brokerRequestFrameSchema;
export const brokerResponseEnvelopeSchema = brokerResponseFrameSchema;

// Operations belong inside the signed JSON payload. The frame deliberately has no mutable operation field.
export const brokerOperationSchema = z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/, "Expected a Broker operation name.");

export type BrokerProtocolVersion = typeof AGENT_PROTOCOL_VERSION;
export type BrokerCounter = z.infer<typeof brokerCounterSchema>;
export type BrokerDetachedSignature = z.infer<typeof brokerDetachedSignatureSchema>;
export type BrokerSignature = BrokerDetachedSignature;
export type BrokerClientIdentity = z.infer<typeof brokerClientIdentitySchema>;
export type BrokerHostIdentity = z.infer<typeof brokerHostIdentitySchema>;
export type BrokerHostIdentityProof = z.infer<typeof brokerHostIdentityProofSchema>;
export type BrokerPairingRecord = z.infer<typeof brokerPairingRecordSchema>;
export type BrokerOperation = z.infer<typeof brokerOperationSchema>;
export type BrokerRequestFrame<TPayload> = {
  type: "request";
  protocolVersion: BrokerProtocolVersion;
  requestId: string;
  hostId: string;
  bootId: string;
  clientId: string;
  counter: BrokerCounter;
  payload: TPayload;
  signature: BrokerDetachedSignature;
};
export type BrokerResponseFrame<TPayload> = {
  type: "response";
  protocolVersion: BrokerProtocolVersion;
  requestId: string;
  requestCounter: BrokerCounter;
  hostIdentity: BrokerHostIdentityProof;
  payload: TPayload;
  signature: BrokerDetachedSignature;
};
export type BrokerRequestEnvelope<TPayload> = BrokerRequestFrame<TPayload>;
export type BrokerResponseEnvelope<TPayload> = BrokerResponseFrame<TPayload>;
