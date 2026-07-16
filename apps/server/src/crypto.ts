import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FORMAT_VERSION = "v1";

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
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, nonce, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
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
