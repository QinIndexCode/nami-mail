import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

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
