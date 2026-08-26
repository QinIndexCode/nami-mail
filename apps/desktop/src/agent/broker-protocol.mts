import {
  createPrivateKey,
  createPublicKey,
  sign as signDetached,
  verify as verifyDetached,
  type KeyLike,
} from "node:crypto";
import type { AgentError } from "@nami/agent-contracts";
import { AGENT_PROTOCOL_VERSION, agentDesktopError, type AgentErrorCode } from "./contracts.mjs";

const brokerDomain = "nami-mail-agent-broker-v1";
const identifierPattern = /^[A-Za-z0-9_-]{16,160}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{16,160}$/;
const counterPattern = /^(0|[1-9]\d{0,18})$/;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const maxCounter = 9_223_372_036_854_775_807n;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BrokerHostIdentityProof = {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  hostId: string;
  bootId: string;
  publicKeyPem: string;
  issuedAt: string;
  signature: string;
};

export type BrokerRequestFrame<TPayload extends JsonValue = JsonValue> = {
  type: "request";
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  hostId: string;
  bootId: string;
  clientId: string;
  counter: string;
  payload: TPayload;
  signature: string;
};

export type BrokerResponseFrame<TPayload extends JsonValue = JsonValue> = {
  type: "response";
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  requestCounter: string;
  hostIdentity: BrokerHostIdentityProof;
  payload: TPayload;
  signature: string;
};

export type BrokerPairingRecord = {
  schemaVersion: 1;
  clientId: string;
  clientPublicKeyPem: string;
  hostId: string;
  hostPublicKeyPem: string;
  scopes: readonly string[];
  /** Missing on pre-release records; those records are denied until re-paired. */
  accountIds?: readonly string[];
  createdAt: string;
  /** Pairings approved by current NamiMail builds carry a lifetime. When this
   * timestamp passes, the Broker rejects requests until the profile is paired
   * again. Legacy records without it keep their previous no-expiry behavior. */
  expiresAt?: string;
  lastAcceptedCounter: string;
  revokedAt?: string;
};

export type BrokerPairingStoreAdvanceResult =
  | { status: "advanced" }
  | { status: "missing" }
  | { status: "revoked" }
  | { status: "counter-conflict"; lastAcceptedCounter: string };

/**
 * Production storage must implement `advanceCounter` as one durable database
 * transaction. Reading a counter and then separately writing it is not safe
 * against duplicate processes or a restart during request verification.
 */
export interface BrokerPairingStore {
  read(clientId: string): Promise<BrokerPairingRecord | undefined>;
  save(record: BrokerPairingRecord): Promise<void>;
  revoke(clientId: string, revokedAt: string): Promise<boolean>;
  list(): Promise<BrokerPairingRecord[]>;
  advanceCounter(input: {
    clientId: string;
    expectedLastCounter: string;
    nextCounter: string;
  }): Promise<BrokerPairingStoreAdvanceResult>;
}

export type BrokerVerificationSuccess = {
  ok: true;
  pairing: BrokerPairingRecord;
};

export type BrokerVerificationFailure = {
  ok: false;
  error: AgentError;
};

export type BrokerVerificationResult = BrokerVerificationSuccess | BrokerVerificationFailure;

export type BrokerRequestVerificationOptions = {
  pairingStore: BrokerPairingStore;
  hostId: string;
  bootId: string;
  hostPublicKeyPem: string;
};

export type BrokerResponseVerificationOptions = {
  pairing: Pick<BrokerPairingRecord, "hostId" | "hostPublicKeyPem">;
  requestId: string;
  requestCounter: string;
  /** Bind a response to the live host instance recorded in discovery. */
  bootId?: string;
};

function failure(
  code: AgentErrorCode,
  message: string,
  retryable = false,
  suggestion?: string,
): BrokerVerificationFailure {
  return { ok: false, error: agentDesktopError(code, message, retryable, suggestion).toAgentError() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && isoTimestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

export function parseCounter(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !counterPattern.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= maxCounter ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nextCounter(value: string): string | undefined {
  const parsed = parseCounter(value);
  if (parsed === undefined || parsed >= maxCounter) return undefined;
  return (parsed + 1n).toString(10);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

/** Produces a deterministic, constrained representation for detached signing. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot serialize non-finite JSON number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}

function signingBytes(value: JsonValue): Buffer {
  return Buffer.from(`${brokerDomain}\n${canonicalJson(value)}`, "utf8");
}

function decodeSignature(signature: string): Buffer | undefined {
  if (!base64UrlPattern.test(signature)) return undefined;
  try {
    const decoded = Buffer.from(signature, "base64url");
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function createSigningKey(key: KeyLike): KeyLike {
  return typeof key === "string" || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}

function createVerificationKey(key: KeyLike): KeyLike {
  return typeof key === "string" || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}

function signValue(value: JsonValue, privateKey: KeyLike): string {
  return signDetached(null, signingBytes(value), createSigningKey(privateKey)).toString("base64url");
}

function verifyValue(value: JsonValue, signature: string, publicKey: KeyLike): boolean {
  const decodedSignature = decodeSignature(signature);
  if (!decodedSignature) return false;
  try {
    return verifyDetached(null, signingBytes(value), createVerificationKey(publicKey), decodedSignature);
  } catch {
    return false;
  }
}

function hostIdentityPayload(proof: Omit<BrokerHostIdentityProof, "signature">): JsonValue {
  return {
    protocolVersion: proof.protocolVersion,
    hostId: proof.hostId,
    bootId: proof.bootId,
    publicKeyPem: proof.publicKeyPem,
    issuedAt: proof.issuedAt,
  };
}

function requestPayload(frame: Omit<BrokerRequestFrame, "signature">): JsonValue {
  return {
    type: frame.type,
    protocolVersion: frame.protocolVersion,
    requestId: frame.requestId,
    hostId: frame.hostId,
    bootId: frame.bootId,
    clientId: frame.clientId,
    counter: frame.counter,
    payload: frame.payload,
  };
}

function responsePayload(frame: Omit<BrokerResponseFrame, "signature">): JsonValue {
  return {
    type: frame.type,
    protocolVersion: frame.protocolVersion,
    requestId: frame.requestId,
    requestCounter: frame.requestCounter,
    hostIdentity: hostIdentityPayload(frame.hostIdentity),
    payload: frame.payload,
  };
}

export function createHostIdentityProof(input: Omit<BrokerHostIdentityProof, "protocolVersion" | "signature"> & { privateKey: KeyLike }): BrokerHostIdentityProof {
  if (!isValidIdentifier(input.hostId) || !isValidIdentifier(input.bootId) || !isValidTimestamp(input.issuedAt) || !isSafePublicKey(input.publicKeyPem)) {
    throw agentDesktopError("INVALID_ARGUMENT", "The Agent host identity proof is not valid.", false);
  }
  const unsigned = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    hostId: input.hostId,
    bootId: input.bootId,
    publicKeyPem: input.publicKeyPem,
    issuedAt: input.issuedAt,
  } as const;
  return { ...unsigned, signature: signValue(hostIdentityPayload(unsigned), input.privateKey) };
}

export function verifyHostIdentityProof(
  proof: unknown,
  expected: Pick<BrokerPairingRecord, "hostId" | "hostPublicKeyPem"> & { bootId?: string },
): boolean {
  if (!isBrokerHostIdentityProof(proof)) return false;
  if (proof.protocolVersion !== AGENT_PROTOCOL_VERSION || proof.hostId !== expected.hostId || proof.publicKeyPem !== expected.hostPublicKeyPem) return false;
  if (expected.bootId && proof.bootId !== expected.bootId) return false;
  return verifyValue(hostIdentityPayload(proof), proof.signature, proof.publicKeyPem);
}

export function signBrokerRequest<TPayload extends JsonValue>(
  input: Omit<BrokerRequestFrame<TPayload>, "protocolVersion" | "type" | "signature"> & { privateKey: KeyLike },
): BrokerRequestFrame<TPayload> {
  const unsigned: Omit<BrokerRequestFrame<TPayload>, "signature"> = {
    type: "request",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: input.requestId,
    hostId: input.hostId,
    bootId: input.bootId,
    clientId: input.clientId,
    counter: input.counter,
    payload: input.payload,
  };
  if (!isBrokerRequestFrame({ ...unsigned, signature: "signature" })) {
    throw agentDesktopError("INVALID_ARGUMENT", "The Agent broker request is not valid.", false);
  }
  return { ...unsigned, signature: signValue(requestPayload(unsigned), input.privateKey) };
}

export function signBrokerResponse<TPayload extends JsonValue>(
  input: Omit<BrokerResponseFrame<TPayload>, "protocolVersion" | "type" | "signature"> & { privateKey: KeyLike },
): BrokerResponseFrame<TPayload> {
  const unsigned: Omit<BrokerResponseFrame<TPayload>, "signature"> = {
    type: "response",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: input.requestId,
    requestCounter: input.requestCounter,
    hostIdentity: input.hostIdentity,
    payload: input.payload,
  };
  if (!isBrokerResponseFrame({ ...unsigned, signature: "signature" })) {
    throw agentDesktopError("INVALID_ARGUMENT", "The Agent broker response is not valid.", false);
  }
  return { ...unsigned, signature: signValue(responsePayload(unsigned), input.privateKey) };
}

export async function verifyBrokerRequest(
  frame: unknown,
  options: BrokerRequestVerificationOptions,
): Promise<BrokerVerificationResult> {
  if (!isBrokerRequestFrame(frame)) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent request format is invalid.");
  }
  if (frame.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    return failure("BROKER_PROTOCOL_UNSUPPORTED", "The local Agent client uses an unsupported protocol version.", false);
  }
  if (frame.hostId !== options.hostId || frame.bootId !== options.bootId) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent request is not addressed to this host instance.");
  }

  const pairing = await options.pairingStore.read(frame.clientId);
  if (!pairing) {
    return failure("PAIRING_REQUIRED", "This local Agent client has not been paired with NamiMail.", false);
  }
if (pairing.revokedAt) {
    return failure("PAIRING_REVOKED", "This local Agent client has been revoked.");
  }
  if (pairing.expiresAt && Date.now() > Date.parse(pairing.expiresAt)) {
    return failure(
      "PAIRING_EXPIRED",
      "This local Agent pairing has expired and must be approved again.",
      false,
      "Run namimail revoke --profile <name>, then pair the profile again in NamiMail.",
    );
  }
  if (
    pairing.hostId !== options.hostId
    || pairing.hostPublicKeyPem !== options.hostPublicKeyPem
    || !isValidBrokerPairingRecord(pairing)
  ) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent pairing record is not valid.");
  }
  if (!verifyValue(requestPayload(frame), frame.signature, pairing.clientPublicKeyPem)) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent request signature could not be verified.");
  }

  const lastCounter = parseCounter(pairing.lastAcceptedCounter);
  const requestCounter = parseCounter(frame.counter);
  const expectedCounter = nextCounter(pairing.lastAcceptedCounter);
  if (lastCounter === undefined || requestCounter === undefined || !expectedCounter) {
    return failure("BROKER_COUNTER_INVALID", "The local Agent request counter is invalid.");
  }
  if (frame.counter !== expectedCounter) {
    if (requestCounter <= lastCounter) {
      return failure("BROKER_REPLAY_DETECTED", "This local Agent request was already processed or is stale.", false);
    }
    return failure("BROKER_COUNTER_INVALID", "The local Agent request counter is out of sequence.", true);
  }

  const advanced = await options.pairingStore.advanceCounter({
    clientId: frame.clientId,
    expectedLastCounter: pairing.lastAcceptedCounter,
    nextCounter: frame.counter,
  });
  if (advanced.status === "advanced") return { ok: true, pairing };
  if (advanced.status === "missing") return failure("PAIRING_REQUIRED", "This local Agent client has not been paired with NamiMail.");
  if (advanced.status === "revoked") return failure("PAIRING_REVOKED", "This local Agent client has been revoked.");
  return failure("BROKER_REPLAY_DETECTED", "This local Agent request was already processed or is stale.", false);
}

export function verifyBrokerResponse(
  frame: unknown,
  options: BrokerResponseVerificationOptions,
): BrokerVerificationResult {
  if (!isBrokerResponseFrame(frame)) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent response format is invalid.");
  }
  if (frame.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    return failure("BROKER_PROTOCOL_UNSUPPORTED", "The local Agent host uses an unsupported protocol version.", false);
  }
  if (frame.requestId !== options.requestId || frame.requestCounter !== options.requestCounter) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent response does not match the request.");
  }
  if (!verifyHostIdentityProof(frame.hostIdentity, {
    ...options.pairing,
    ...(options.bootId ? { bootId: options.bootId } : {}),
  })) {
    return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent host identity could not be verified.");
  }
  if (!verifyValue(responsePayload(frame), frame.signature, frame.hostIdentity.publicKeyPem)) {
  return failure("BROKER_AUTHENTICATION_FAILED", "The local Agent response signature could not be verified.");
  }
  return {
    ok: true,
    pairing: {
      schemaVersion: 1,
      clientId: "verified-response",
      clientPublicKeyPem: "",
      hostId: options.pairing.hostId,
      hostPublicKeyPem: options.pairing.hostPublicKeyPem,
      scopes: [],
      accountIds: ["verified-response"],
      createdAt: frame.hostIdentity.issuedAt,
      lastAcceptedCounter: frame.requestCounter,
    },
  };
}

function isSafePublicKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 64
    && value.length <= 16_384
    && /^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(value)
    // Control characters are rejected on purpose: they cannot appear in a
    // valid key and would complicate file-based transport handling.
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}

export function createBrokerPairingRecord(input: Omit<BrokerPairingRecord, "schemaVersion" | "lastAcceptedCounter" | "revokedAt"> & {
  lastAcceptedCounter?: string;
}): BrokerPairingRecord {
  const record: BrokerPairingRecord = {
    schemaVersion: 1,
    clientId: input.clientId,
    clientPublicKeyPem: input.clientPublicKeyPem,
    hostId: input.hostId,
    hostPublicKeyPem: input.hostPublicKeyPem,
    scopes: [...input.scopes],
    ...(input.accountIds ? { accountIds: [...input.accountIds] } : {}),
    createdAt: input.createdAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    lastAcceptedCounter: input.lastAcceptedCounter ?? "0",
  };
  if (!isValidBrokerPairingRecord(record) || new Set(record.scopes).size !== record.scopes.length) {
    throw agentDesktopError("INVALID_ARGUMENT", "The Agent pairing record is not valid.", false);
  }
  return record;
}

export function isValidBrokerPairingRecord(value: unknown): value is BrokerPairingRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "schemaVersion",
    "clientId",
    "clientPublicKeyPem",
    "hostId",
    "hostPublicKeyPem",
    "scopes",
    ...(Object.prototype.hasOwnProperty.call(value, "accountIds") ? ["accountIds"] : []),
    "createdAt",
    ...(Object.prototype.hasOwnProperty.call(value, "expiresAt") ? ["expiresAt"] : []),
    "lastAcceptedCounter",
    ...(Object.prototype.hasOwnProperty.call(value, "revokedAt") ? ["revokedAt"] : []),
  ])) return false;
  return value.schemaVersion === 1
    && isValidIdentifier(value.clientId)
    && isSafePublicKey(value.clientPublicKeyPem)
    && isValidIdentifier(value.hostId)
    && isSafePublicKey(value.hostPublicKeyPem)
    && Array.isArray(value.scopes)
    && value.scopes.length <= 32
    && value.scopes.every((scope) => typeof scope === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(scope))
    && new Set(value.scopes).size === value.scopes.length
    && (value.accountIds === undefined || (
      Array.isArray(value.accountIds)
      && value.accountIds.length >= 1
      && value.accountIds.length <= 100
      && value.accountIds.every((accountId) => typeof accountId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountId))
      && new Set(value.accountIds).size === value.accountIds.length
    ))
    && isValidTimestamp(value.createdAt)
    && (value.expiresAt === undefined || isValidTimestamp(value.expiresAt))
    && parseCounter(value.lastAcceptedCounter) !== undefined
    && (value.revokedAt === undefined || isValidTimestamp(value.revokedAt));
}

function isBrokerHostIdentityProof(value: unknown): value is BrokerHostIdentityProof {
  return isPlainObject(value)
    && hasExactKeys(value, ["protocolVersion", "hostId", "bootId", "publicKeyPem", "issuedAt", "signature"])
    && typeof value.protocolVersion === "string"
    && isValidIdentifier(value.hostId)
    && isValidIdentifier(value.bootId)
    && isSafePublicKey(value.publicKeyPem)
    && isValidTimestamp(value.issuedAt)
    && typeof value.signature === "string"
    && base64UrlPattern.test(value.signature);
}

export function isBrokerRequestFrame(value: unknown): value is BrokerRequestFrame {
  return isPlainObject(value)
    && hasExactKeys(value, ["type", "protocolVersion", "requestId", "hostId", "bootId", "clientId", "counter", "payload", "signature"])
    && value.type === "request"
    && typeof value.protocolVersion === "string"
    && isValidRequestId(value.requestId)
    && isValidIdentifier(value.hostId)
    && isValidIdentifier(value.bootId)
    && isValidIdentifier(value.clientId)
    && parseCounter(value.counter) !== undefined
    && isJsonValue(value.payload)
    && typeof value.signature === "string"
    && base64UrlPattern.test(value.signature);
}

export function isBrokerResponseFrame(value: unknown): value is BrokerResponseFrame {
  return isPlainObject(value)
    && hasExactKeys(value, ["type", "protocolVersion", "requestId", "requestCounter", "hostIdentity", "payload", "signature"])
    && value.type === "response"
    && typeof value.protocolVersion === "string"
    && isValidRequestId(value.requestId)
    && parseCounter(value.requestCounter) !== undefined
    && isBrokerHostIdentityProof(value.hostIdentity)
    && isJsonValue(value.payload)
    && typeof value.signature === "string"
    && base64UrlPattern.test(value.signature);
}

function clonePairingRecord(record: BrokerPairingRecord): BrokerPairingRecord {
  return { ...record, scopes: [...record.scopes], ...(record.accountIds ? { accountIds: [...record.accountIds] } : {}) };
}

/** In-memory only test double. It must never be selected by production startup. */
export class InMemoryBrokerPairingStore implements BrokerPairingStore {
  private readonly records = new Map<string, BrokerPairingRecord>();

  async read(clientId: string): Promise<BrokerPairingRecord | undefined> {
    const record = this.records.get(clientId);
    return record ? clonePairingRecord(record) : undefined;
  }

  async save(record: BrokerPairingRecord): Promise<void> {
    if (!isValidBrokerPairingRecord(record)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The Agent pairing record is not valid.", false);
    }
    this.records.set(record.clientId, clonePairingRecord(record));
  }

  async revoke(clientId: string, revokedAt: string): Promise<boolean> {
    if (!isValidIdentifier(clientId) || !isValidTimestamp(revokedAt)) return false;
    const record = this.records.get(clientId);
    if (!record) return false;
    this.records.set(clientId, { ...record, revokedAt });
    return true;
  }

  async list(): Promise<BrokerPairingRecord[]> {
    return [...this.records.values()].map(clonePairingRecord);
  }

  async advanceCounter(input: {
    clientId: string;
    expectedLastCounter: string;
    nextCounter: string;
  }): Promise<BrokerPairingStoreAdvanceResult> {
    const record = this.records.get(input.clientId);
    if (!record) return { status: "missing" };
    if (record.revokedAt) return { status: "revoked" };
    const expectedNext = nextCounter(input.expectedLastCounter);
    if (!expectedNext || input.nextCounter !== expectedNext || record.lastAcceptedCounter !== input.expectedLastCounter) {
      return { status: "counter-conflict", lastAcceptedCounter: record.lastAcceptedCounter };
    }
    this.records.set(input.clientId, { ...record, lastAcceptedCounter: input.nextCounter });
    return { status: "advanced" };
  }
}
