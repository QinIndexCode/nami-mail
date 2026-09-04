import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decryptTextEnvelope,
  deriveEncryptionKey,
  encryptTextEnvelope,
} from "../crypto.js";

export const AGENT_STORE_CRYPTO_VERSION = 1;
export const AGENT_ACCOUNT_DEK_CRYPTO_VERSION = 1;

const accountDekWrappingPurpose = "agent/account-dek-wrapper/v1";
const recordKeyPrefix = "agent/record/";
const digestKeyPrefix = "agent/digest/";

/** Upper bound on cached derived record keys. HKDF is deterministic, so a
 *  bounded cache removes the per-decrypt derivation cost without ever
 *  weakening the crypto — the same input always yields the same key. */
const derivedRecordKeyCacheSize = 256;

/** Deterministic HKDF-derived record keys, keyed by the hex of the source key
 *  (master key or account DEK) followed by the purpose. A Map keeps
 *  insertion order, so this behaves as a coarse LRU: evicting the oldest entry
 *  when the bound is exceeded. */
function deriveRecordKey(sourceKey: Buffer, purpose: string): Buffer {
  const cache = recordKeyCacheForSize();
  const cacheKey = `${sourceKey.toString("hex")}\u0000${purpose}`;
  const hit = cache.get(cacheKey);
  if (hit) {
    cache.delete(cacheKey); // refresh recency
    cache.set(cacheKey, hit);
    return hit;
  }
  const derived = deriveEncryptionKey(sourceKey, purpose);
  if (cache.size >= derivedRecordKeyCacheSize) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(cacheKey, derived);
  return derived;
}

let recordKeyCache: Map<string, Buffer> | undefined;
/** Lazily allocated cache — never retained when store-crypto is imported but
 *  unused, and never shared across derivation purposes that are unrelated. */
function recordKeyCacheForSize(): Map<string, Buffer> {
  recordKeyCache ??= new Map<string, Buffer>();
  return recordKeyCache;
}

export class AgentStoreCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoreCryptoError";
  }
}

export type AccountDataKeyWrapper = {
  encryptedDek: string;
  cryptoVersion: number;
};

export type AccountEnvelopeScope = {
  accountId: string;
  generation: number;
  accountDek: Buffer;
};

export type EncryptedAccountEnvelope = {
  accountId: string;
  generation: number;
  encryptedPayload: string;
  cryptoVersion: number;
};

function requireKey(key: Buffer, name: string): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new AgentStoreCryptoError(`${name} must be exactly 32 bytes.`);
  }
}

function withDerivedKey<T>(masterKey: Buffer, purpose: string, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, purpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

function accountDekAad(accountId: string, generation: number): string {
  return JSON.stringify(["nami-agent-account-dek-v1", accountId, generation]);
}

function accountRecordAad(accountId: string, generation: number, recordType: string, recordId: string): string {
  return JSON.stringify(["nami-agent-record-v1", accountId, generation, recordType, recordId]);
}

function rootRecordAad(recordType: string, recordId: string): string {
  return JSON.stringify(["nami-agent-root-record-v1", recordType, recordId]);
}

function validateIdentifier(value: string, name: string): void {
  if (!value || value.length > 512) throw new AgentStoreCryptoError(`${name} is invalid.`);
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new AgentStoreCryptoError("Account generation is invalid.");
  }
}

/** Creates a random, account-scoped DEK. The caller owns zeroing the returned buffer. */
export function createAccountDataKey(): Buffer {
  return randomBytes(32);
}

/** Wraps an account DEK with the device master key and binds it to lifecycle generation. */
export function wrapAccountDataKey(
  masterKey: Buffer,
  accountId: string,
  generation: number,
  accountDek: Buffer,
): AccountDataKeyWrapper {
  requireKey(masterKey, "Master key");
  requireKey(accountDek, "Account data key");
  validateIdentifier(accountId, "Account id");
  validateGeneration(generation);
  return {
    encryptedDek: withDerivedKey(masterKey, accountDekWrappingPurpose, (key) =>
      encryptTextEnvelope(accountDek.toString("base64url"), key, accountDekAad(accountId, generation))),
    cryptoVersion: AGENT_ACCOUNT_DEK_CRYPTO_VERSION,
  };
}

/** Unwraps a DEK only after the caller has validated the account lifecycle. */
export function unwrapAccountDataKey(
  masterKey: Buffer,
  accountId: string,
  generation: number,
  wrapper: AccountDataKeyWrapper,
): Buffer {
  requireKey(masterKey, "Master key");
  validateIdentifier(accountId, "Account id");
  validateGeneration(generation);
  if (wrapper.cryptoVersion !== AGENT_ACCOUNT_DEK_CRYPTO_VERSION || !wrapper.encryptedDek) {
    throw new AgentStoreCryptoError("Account data key has an unsupported format.");
  }
  try {
    const encoded = withDerivedKey(masterKey, accountDekWrappingPurpose, (key) =>
      decryptTextEnvelope(wrapper.encryptedDek, key, accountDekAad(accountId, generation)));
    const accountDek = Buffer.from(encoded, "base64url");
    requireKey(accountDek, "Account data key");
    return accountDek;
  } catch (error) {
    if (error instanceof AgentStoreCryptoError) throw error;
    throw new AgentStoreCryptoError("Account data key could not be authenticated.");
  }
}

/** Encrypts an Agent record that belongs to one account and one lifecycle generation. */
export function encryptAccountAgentRecord(
  accountDek: Buffer,
  accountId: string,
  generation: number,
  recordType: string,
  recordId: string,
  plaintext: string,
): string {
  requireKey(accountDek, "Account data key");
  validateIdentifier(accountId, "Account id");
  validateIdentifier(recordType, "Record type");
  validateIdentifier(recordId, "Record id");
  validateGeneration(generation);
  return encryptTextEnvelope(plaintext, deriveRecordKey(accountDek, `${recordKeyPrefix}${recordType}/v1`), accountRecordAad(accountId, generation, recordType, recordId));
}

/** Rejects missing, unauthenticated, or cross-account Agent record payloads. */
export function decryptAccountAgentRecord(
  accountDek: Buffer,
  accountId: string,
  generation: number,
  recordType: string,
  recordId: string,
  encryptedPayload: string,
): string {
  requireKey(accountDek, "Account data key");
  validateIdentifier(accountId, "Account id");
  validateIdentifier(recordType, "Record type");
  validateIdentifier(recordId, "Record id");
  validateGeneration(generation);
  if (!encryptedPayload) throw new AgentStoreCryptoError("Encrypted Agent record is missing.");
  try {
    return decryptTextEnvelope(encryptedPayload, deriveRecordKey(accountDek, `${recordKeyPrefix}${recordType}/v1`), accountRecordAad(accountId, generation, recordType, recordId));
  } catch {
    throw new AgentStoreCryptoError("Agent record could not be authenticated.");
  }
}

/**
 * Encrypts one logical record for every account that contributed mail-derived
 * context. A later deletion of any account wrapper makes the record fail
 * closed instead of silently exposing the remaining accounts' data.
 */
export function encryptMultiAccountAgentRecord(
  scopes: readonly AccountEnvelopeScope[],
  recordType: string,
  recordId: string,
  plaintext: string,
): EncryptedAccountEnvelope[] {
  if (!scopes.length) throw new AgentStoreCryptoError("Mail-derived Agent records require an account scope.");
  const seen = new Set<string>();
  return [...scopes]
    .sort((left, right) => left.accountId.localeCompare(right.accountId) || left.generation - right.generation)
    .map((scope) => {
      validateIdentifier(scope.accountId, "Account id");
      validateGeneration(scope.generation);
      requireKey(scope.accountDek, "Account data key");
      const key = `${scope.accountId}\0${scope.generation}`;
      if (seen.has(key)) throw new AgentStoreCryptoError("Account encryption scope is duplicated.");
      seen.add(key);
      return {
        accountId: scope.accountId,
        generation: scope.generation,
        encryptedPayload: encryptAccountAgentRecord(
          scope.accountDek,
          scope.accountId,
          scope.generation,
          recordType,
          recordId,
          plaintext,
        ),
        cryptoVersion: AGENT_STORE_CRYPTO_VERSION,
      };
    });
}

/** Requires every account envelope to decrypt to the same authenticated content. */
export function decryptMultiAccountAgentRecord(
  envelopes: readonly EncryptedAccountEnvelope[],
  recordType: string,
  recordId: string,
  resolveAccountDataKey: (accountId: string, generation: number) => Buffer,
): string {
  if (!envelopes.length) throw new AgentStoreCryptoError("Agent record has no account encryption envelopes.");
  let plaintext: string | undefined;
  const seen = new Set<string>();
  for (const envelope of envelopes) {
    validateIdentifier(envelope.accountId, "Account id");
    validateGeneration(envelope.generation);
    if (envelope.cryptoVersion !== AGENT_STORE_CRYPTO_VERSION) {
      throw new AgentStoreCryptoError("Agent record has an unsupported encryption version.");
    }
    const identity = `${envelope.accountId}\0${envelope.generation}`;
    if (seen.has(identity)) throw new AgentStoreCryptoError("Agent record has duplicate account envelopes.");
    seen.add(identity);
    const accountDek = resolveAccountDataKey(envelope.accountId, envelope.generation);
    try {
      const candidate = decryptAccountAgentRecord(
        accountDek,
        envelope.accountId,
        envelope.generation,
        recordType,
        recordId,
        envelope.encryptedPayload,
      );
      if (plaintext !== undefined && plaintext !== candidate) {
        throw new AgentStoreCryptoError("Agent account envelopes disagree.");
      }
      plaintext = candidate;
    } finally {
      accountDek.fill(0);
    }
  }
  if (plaintext === undefined) throw new AgentStoreCryptoError("Agent record could not be decrypted.");
  return plaintext;
}

/** Encrypts device-wide Agent data such as audit records that can span accounts. */
export function encryptRootAgentRecord(
  masterKey: Buffer,
  recordType: string,
  recordId: string,
  plaintext: string,
): string {
  requireKey(masterKey, "Master key");
  validateIdentifier(recordType, "Record type");
  validateIdentifier(recordId, "Record id");
  return withDerivedKey(masterKey, `${recordKeyPrefix}${recordType}/v1`, (key) =>
    encryptTextEnvelope(plaintext, key, rootRecordAad(recordType, recordId)));
}

export function decryptRootAgentRecord(
  masterKey: Buffer,
  recordType: string,
  recordId: string,
  encryptedPayload: string,
): string {
  requireKey(masterKey, "Master key");
  validateIdentifier(recordType, "Record type");
  validateIdentifier(recordId, "Record id");
  if (!encryptedPayload) throw new AgentStoreCryptoError("Encrypted Agent record is missing.");
  try {
    return withDerivedKey(masterKey, `${recordKeyPrefix}${recordType}/v1`, (key) =>
      decryptTextEnvelope(encryptedPayload, key, rootRecordAad(recordType, recordId)));
  } catch {
    throw new AgentStoreCryptoError("Agent record could not be authenticated.");
  }
}

/** Returns a keyed opaque digest. It is safe for equality and idempotency checks, not for display. */
export function agentOpaqueDigest(masterKey: Buffer, purpose: string, value: string | Buffer): string {
  requireKey(masterKey, "Master key");
  validateIdentifier(purpose, "Digest purpose");
  return withDerivedKey(masterKey, `${digestKeyPrefix}${purpose}/v1`, (key) =>
    `h1.${createHmac("sha256", key).update(value).digest("base64url")}`);
}

export function agentOpaqueDigestEquals(expected: string, actual: string): boolean {
  if (!expected.startsWith("h1.") || !actual.startsWith("h1.")) return false;
  const expectedBytes = Buffer.from(expected.slice(3), "base64url");
  const actualBytes = Buffer.from(actual.slice(3), "base64url");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

/** Canonical JSON keeps encrypted request fingerprints stable across key order. */
export function canonicalAgentJson(value: unknown): string {
  const visit = (current: unknown, seen: Set<object>): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new AgentStoreCryptoError("Agent record contains a non-finite number.");
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) return `[${current.map((item) => visit(item, seen)).join(",")}]`;
    if (typeof current !== "object") throw new AgentStoreCryptoError("Agent record contains an unsupported value.");
    if (seen.has(current as object)) throw new AgentStoreCryptoError("Agent record contains a cycle.");
    seen.add(current as object);
    const object = current as Record<string, unknown>;
    const result = `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${visit(object[key], seen)}`).join(",")}}`;
    seen.delete(current as object);
    return result;
  };
  return visit(value, new Set<object>());
}
