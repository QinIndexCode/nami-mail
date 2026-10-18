import { createHmac } from "node:crypto";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "../crypto.js";

/**
 * The task payload envelope, generalized from the outbox's request envelope.
 *
 * The algorithm and the AAD semantics are unchanged -- AES-256-GCM under an
 * HKDF-derived per-purpose key, with the row's identity bound as associated
 * data so a ciphertext moved to another row fails to decrypt instead of
 * silently answering with the wrong task's payload. What is generalized is the
 * value: the outbox seals one fixed request shape, this seals whatever a task
 * kind needs.
 */

/**
 * The version stamped on a normally sealed payload.
 *
 * Unlike `outbound_submissions.crypto_version` there is no plaintext-legacy
 * version here -- `tasks` is new, so nothing predates sealing. Version 0 is
 * still written, but only by the migration's backfill, which runs before the
 * master key exists and therefore stores the legacy queue's plaintext JSON in
 * `payload_ciphertext`. The seal pass then rewrites those rows to version 1.
 * Readers must accept both.
 */
export const PAYLOAD_ENVELOPE_VERSION = 1;

/** Plaintext carried in `payload_ciphertext` by the backfill only. */
export const PAYLOAD_VERSION_UNSEALED = 0;

const payloadKeyPurpose = "task-payload-v1";
const fingerprintKeyPurpose = "task-payload-fingerprint-v1";

/**
 * Per-derived-key memo, keyed by the master key object.
 *
 * Same reasoning as the outbox's cache: the derivation depends only on
 * (masterKey, purpose) -- HKDF's salt is a compile-time constant and no
 * per-call randomness enters it -- while a task sweep decrypts one payload per
 * row. Cached keys share the master key's lifetime, which is the process's.
 */
const derivedKeyCache = new WeakMap<Buffer, Map<string, Buffer>>();

function withDerivedKey<T>(masterKey: Buffer, purpose: string, callback: (key: Buffer) => T): T {
  let keysByPurpose = derivedKeyCache.get(masterKey);
  if (!keysByPurpose) {
    keysByPurpose = new Map();
    derivedKeyCache.set(masterKey, keysByPurpose);
  }
  let key = keysByPurpose.get(purpose);
  if (!key) {
    key = deriveEncryptionKey(masterKey, purpose);
    keysByPurpose.set(purpose, key);
  }
  return callback(key);
}

export type PayloadAad = { id: string; accountId: string };

/**
 * `tasks\0{accountId}\0{id}\0payload-v1`.
 *
 * The table name leads so a payload sealed for one table can never be accepted
 * by another, and the id and account are both bound because `tasks.id` alone is
 * not the row's full identity -- a task is only meaningful inside its account's
 * serialized chain.
 */
function payloadAad(aad: PayloadAad): string {
  return `tasks\0${aad.accountId}\0${aad.id}\0payload-v1`;
}

/**
 * A canonical JSON rendering: object keys sorted, no whitespace, so two
 * structurally equal payloads hash the same however they were built.
 *
 * The outbox's `canonicalRequest` can spell out a field order because it has one
 * request shape; a task payload has no fixed shape, so the ordering has to be
 * derived. Only the fingerprint depends on this -- the sealed ciphertext stores
 * the value as given.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Seals a payload for the row `aad` identifies.
 *
 * Callers write the three returned fields together; the fingerprint is not
 * optional padding -- it is what makes "the same idempotency key arrived with
 * different content" a detectable condition rather than a silent overwrite.
 */
export function sealPayload(
  masterKey: Buffer,
  aad: PayloadAad,
  value: unknown,
): { ciphertext: string; fingerprint: string; version: number } {
  const plaintext = JSON.stringify(value) ?? "null";
  return {
    ciphertext: withDerivedKey(masterKey, payloadKeyPurpose, (key) => encryptTextEnvelope(plaintext, key, payloadAad(aad))),
    fingerprint: payloadFingerprint(masterKey, aad.accountId, value),
    version: PAYLOAD_ENVELOPE_VERSION,
  };
}

/**
 * The keyed fingerprint of a payload, for idempotency conflict checks.
 *
 * Same construction as the ledger's `requestFingerprint`: HMAC-SHA256 over the
 * account id, a NUL, and the canonical value, tagged `h1.` and base64url
 * encoded. Keyed rather than a plain hash so the stored value cannot be used to
 * confirm a guessed payload without the master key.
 */
export function payloadFingerprint(masterKey: Buffer, accountId: string, value: unknown): string {
  return withDerivedKey(masterKey, fingerprintKeyPurpose, (key) =>
    `h1.${createHmac("sha256", key).update(accountId, "utf8").update("\0").update(canonicalJson(value), "utf8").digest("base64url")}`);
}

export type SealedPayloadRow = {
  payload_ciphertext: string | null;
  payload_version: number;
};

/**
 * Opens a payload, or returns `undefined` when the task carries none.
 *
 * "No payload" is a real state, not an error: `kind='send'` keeps its request in
 * the delivery ledger and points at it with `submission_id`, so sealing a copy
 * here would be the same ciphertext in two places, drifting apart, while the
 * ledger's copy is the only one the legacy fingerprint check honors.
 *
 * A version 0 row is the migration's intermediate state: plaintext sitting in
 * the same column, written by a pass that had no master key. It is returned
 * as-is. Any other version that is not the sealed one is an error rather than a
 * guess.
 */
export function openPayload<T>(masterKey: Buffer, aad: PayloadAad, row: SealedPayloadRow): T | undefined {
  const ciphertext = row.payload_ciphertext;
  if (ciphertext === null || ciphertext === undefined) return undefined;
  let plaintext: string;
  if (row.payload_version === PAYLOAD_VERSION_UNSEALED) {
    plaintext = ciphertext;
  } else if (row.payload_version === PAYLOAD_ENVELOPE_VERSION) {
    plaintext = withDerivedKey(masterKey, payloadKeyPurpose, (key) => decryptTextEnvelope(ciphertext, key, payloadAad(aad)));
  } else {
    throw new Error(`Task payload has an unsupported envelope version (${row.payload_version}).`);
  }
  return JSON.parse(plaintext) as T;
}