import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptBufferEnvelope,
  decryptSecret,
  decryptTextEnvelope,
  deriveEncryptionKey,
  encryptBufferEnvelope,
  encryptSecret,
  encryptTextEnvelope,
} from "../src/crypto.js";

describe("credential encryption", () => {
  it("round-trips a Unicode application password", () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret("授权码-apple-1234", key);
    expect(encrypted).not.toContain("授权码");
    expect(decryptSecret(encrypted, key)).toBe("授权码-apple-1234");
  });

  it("rejects tampered ciphertext", () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret("secret", key);
    const tampered = `${encrypted.slice(0, -2)}AA`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});

describe("versioned data envelopes", () => {
  it("derives independent keys and authenticates text AAD", () => {
    const masterKey = randomBytes(32);
    const messageKey = deriveEncryptionKey(masterKey, "messages");
    const attachmentKey = deriveEncryptionKey(masterKey, "attachments");
    expect(messageKey.equals(attachmentKey)).toBe(false);

    const encrypted = encryptTextEnvelope("sensitive subject", messageKey, "message:one");
    expect(encrypted).not.toContain("sensitive subject");
    expect(decryptTextEnvelope(encrypted, messageKey, "message:one")).toBe("sensitive subject");
    expect(() => decryptTextEnvelope(encrypted, messageKey, "message:two")).toThrow();
  });

  it("round-trips binary data and rejects tampering or a wrong key", () => {
    const key = deriveEncryptionKey(randomBytes(32), "binary");
    const plaintext = Buffer.from([0, 1, 2, 3, 255]);
    const encrypted = encryptBufferEnvelope(plaintext, key, "attachment:one");
    expect(encrypted.includes(plaintext)).toBe(false);
    expect(decryptBufferEnvelope(encrypted, key, "attachment:one")).toEqual(plaintext);

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptBufferEnvelope(tampered, key, "attachment:one")).toThrow();
    expect(() => decryptBufferEnvelope(encrypted, randomBytes(32), "attachment:one")).toThrow();
  });
});
