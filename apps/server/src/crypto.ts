import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FORMAT_VERSION = "v1";
const DATA_ENVELOPE_PREFIX = "nami-v1";
const DATA_ENVELOPE_MAGIC = Buffer.from("NAMIENC", "ascii");
const DATA_ENVELOPE_VERSION = 1;
const DATA_ENVELOPE_NONCE_BYTES = 12;
const DATA_ENVELOPE_TAG_BYTES = 16;
const DATA_ENVELOPE_HEADER_BYTES = DATA_ENVELOPE_MAGIC.length + 1 + DATA_ENVELOPE_NONCE_BYTES + DATA_ENVELOPE_TAG_BYTES;
const HKDF_SALT = Buffer.from("Nami Mail local data encryption v1", "utf8");

export const encryptedBufferEnvelopeOverhead = DATA_ENVELOPE_HEADER_BYTES;

function assertEncryptionKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
}

function associatedData(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

/** Derives independent data-domain keys without persisting additional secrets. */
export function deriveEncryptionKey(masterKey: Buffer, purpose: string): Buffer {
  assertEncryptionKey(masterKey);
  if (!purpose || purpose.length > 256) throw new Error("Encryption key purpose is invalid.");
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(purpose, "utf8"), 32));
}

export function isEncryptedBufferEnvelope(payload: Buffer): boolean {
  return payload.length >= DATA_ENVELOPE_HEADER_BYTES
    && payload.subarray(0, DATA_ENVELOPE_MAGIC.length).equals(DATA_ENVELOPE_MAGIC)
    && payload[DATA_ENVELOPE_MAGIC.length] === DATA_ENVELOPE_VERSION;
}

/** AES-256-GCM binary envelope. AAD is required and deliberately not persisted. */
export function encryptBufferEnvelope(plaintext: Buffer, key: Buffer, aad: string | Buffer): Buffer {
  assertEncryptionKey(key);
  const nonce = randomBytes(DATA_ENVELOPE_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(aad), { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    DATA_ENVELOPE_MAGIC,
    Buffer.from([DATA_ENVELOPE_VERSION]),
    nonce,
    tag,
    ciphertext,
  ]);
}

export function decryptBufferEnvelope(payload: Buffer, key: Buffer, aad: string | Buffer): Buffer {
  assertEncryptionKey(key);
  if (!isEncryptedBufferEnvelope(payload)) throw new Error("Encrypted data has an unsupported format.");
  const nonceStart = DATA_ENVELOPE_MAGIC.length + 1;
  const tagStart = nonceStart + DATA_ENVELOPE_NONCE_BYTES;
  const ciphertextStart = tagStart + DATA_ENVELOPE_TAG_BYTES;
  const nonce = payload.subarray(nonceStart, tagStart);
  const tag = payload.subarray(tagStart, ciphertextStart);
  const ciphertext = payload.subarray(ciphertextStart);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(aad), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptTextEnvelope(plaintext: string, key: Buffer, aad: string | Buffer): string {
  const envelope = encryptBufferEnvelope(Buffer.from(plaintext, "utf8"), key, aad);
  return `${DATA_ENVELOPE_PREFIX}.${envelope.toString("base64url")}`;
}

export function decryptTextEnvelope(payload: string, key: Buffer, aad: string | Buffer): string {
  const [prefix, encoded, extra] = payload.split(".");
  if (prefix !== DATA_ENVELOPE_PREFIX || !encoded || extra !== undefined) {
    throw new Error("Encrypted text has an unsupported format.");
  }
  return decryptBufferEnvelope(Buffer.from(encoded, "base64url"), key, aad).toString("utf8");
}

export function loadOrCreateMasterKey(keyPath: string): Buffer {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  if (fs.existsSync(keyPath)) {
    const encoded = fs.readFileSync(keyPath, "utf8").trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) {
      throw new Error("Master key must decode to exactly 32 bytes.");
    }
    return key;
  }

  const key = randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("base64url"), { encoding: "utf8", mode: 0o600 });
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  assertEncryptionKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, nonce, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  assertEncryptionKey(key);
  const [version, noncePart, tagPart, ciphertextPart] = payload.split(".");
  if (version !== FORMAT_VERSION || !noncePart || !tagPart || ciphertextPart === undefined) {
    throw new Error("Encrypted secret has an unsupported format.");
  }
  const nonce = Buffer.from(noncePart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
