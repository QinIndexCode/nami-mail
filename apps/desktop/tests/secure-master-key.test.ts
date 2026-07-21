import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopMasterKeyFiles, loadOrCreateDesktopMasterKey, type DesktopSafeStorage } from "../src/secure-master-key.mts";

class TestSafeStorage implements DesktopSafeStorage {
  private readonly values = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plaintext: string): Buffer {
    if (!this.available) throw new Error("unavailable");
    const token = `protected-${++this.sequence}-${randomBytes(8).toString("hex")}`;
    this.values.set(token, plaintext);
    return Buffer.from(token, "utf8");
  }

  decryptString(ciphertext: Buffer): string {
    const value = this.values.get(ciphertext.toString("utf8"));
    if (!value) throw new Error("invalid ciphertext");
    return value;
  }
}

async function withTemporaryDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-mail-secure-key-"));
  try {
    await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("creates a protected desktop key without writing a plaintext key file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = new TestSafeStorage();
    const result = await loadOrCreateDesktopMasterKey(directory, storage);
    const protectedPath = path.join(directory, desktopMasterKeyFiles.protected);
    const protectedPayload = await fs.readFile(protectedPath);

    assert.equal(result.created, true);
    assert.equal(result.migratedLegacyKey, false);
    assert.equal(result.key.length, 32);
    assert.equal(protectedPayload.includes(result.key), false);
    await assert.rejects(fs.access(path.join(directory, desktopMasterKeyFiles.legacy)), { code: "ENOENT" });

    const reopened = await loadOrCreateDesktopMasterKey(directory, storage);
    assert.deepEqual(reopened.key, result.key);
  });
});

test("migrates a legacy plaintext master key only after the protected wrapper verifies", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = new TestSafeStorage();
    const legacyKey = randomBytes(32);
    const legacyPath = path.join(directory, desktopMasterKeyFiles.legacy);
    await fs.writeFile(legacyPath, legacyKey.toString("base64url"), { mode: 0o600 });

    const result = await loadOrCreateDesktopMasterKey(directory, storage);
    assert.equal(result.created, false);
    assert.equal(result.migratedLegacyKey, true);
    assert.deepEqual(result.key, legacyKey);
    await fs.access(path.join(directory, desktopMasterKeyFiles.protected));
    await assert.rejects(fs.access(legacyPath), { code: "ENOENT" });
  });
});

test("blocks desktop startup rather than writing plaintext when secure storage is unavailable", async () => {
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(
      loadOrCreateDesktopMasterKey(directory, new TestSafeStorage(false)),
      /secure storage is unavailable/i,
    );
    await assert.rejects(fs.access(path.join(directory, desktopMasterKeyFiles.protected)), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(directory, desktopMasterKeyFiles.legacy)), { code: "ENOENT" });
  });
});

test("never falls back to a legacy plaintext key when the protected record cannot be unlocked", async () => {
  await withTemporaryDirectory(async (directory) => {
    const legacyPath = path.join(directory, desktopMasterKeyFiles.legacy);
    await fs.writeFile(legacyPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
    await fs.writeFile(path.join(directory, desktopMasterKeyFiles.protected), "invalid protected key", { mode: 0o600 });

    await assert.rejects(
      loadOrCreateDesktopMasterKey(directory, new TestSafeStorage()),
      /could not unlock its protected master key/i,
    );
    await fs.access(legacyPath);
  });
});
