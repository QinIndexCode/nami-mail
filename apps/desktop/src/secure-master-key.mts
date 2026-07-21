import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const masterKeyLength = 32;
const protectedMasterKeyFileName = "master.key.dpapi";
const legacyMasterKeyFileName = "master.key";

export type DesktopSafeStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plaintext: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
  getSelectedStorageBackend?: () => string;
};

export type DesktopMasterKey = {
  key: Buffer;
  created: boolean;
  migratedLegacyKey: boolean;
};

export const desktopMasterKeyFiles = {
  protected: protectedMasterKeyFileName,
  legacy: legacyMasterKeyFileName,
} as const;

function unavailableSecureStorageError(): Error {
  return new Error(
    "Windows secure storage is unavailable. Nami Mail will not store account credentials until DPAPI is available. Sign in to Windows normally and restart the app.",
  );
}

function assertSecureStorageAvailable(safeStorage: DesktopSafeStorage): void {
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    throw unavailableSecureStorageError();
  }
  if (!available) throw unavailableSecureStorageError();

  // Electron's Linux basic_text backend is an explicit plaintext fallback.
  // Windows uses DPAPI, so it never reports this backend.
  try {
    if (safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw unavailableSecureStorageError();
    }
  } catch (error) {
    if (error instanceof Error && error.message === unavailableSecureStorageError().message) throw error;
    // Backend introspection is optional in Electron. Availability above is
    // still authoritative for the supported Windows desktop target.
  }
}

function decodeMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), "base64url");
  if (key.length !== masterKeyLength) {
    throw new Error("Protected master key has an invalid length.");
  }
  return key;
}

function encodeMasterKey(key: Buffer): string {
  if (key.length !== masterKeyLength) throw new Error("Master key must be exactly 32 bytes.");
  return key.toString("base64url");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function decryptProtectedMasterKey(safeStorage: DesktopSafeStorage, ciphertext: Buffer): Buffer {
  try {
    return decodeMasterKey(safeStorage.decryptString(ciphertext));
  } catch {
    throw new Error(
      "Nami Mail could not unlock its protected master key. The Windows account or DPAPI protection may have changed; restore the original Windows profile or a compatible backup before continuing.",
    );
  }
}

async function writeProtectedMasterKey(filePath: string, payload: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, payload, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeLegacyMasterKey(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    throw new Error(
      "Nami Mail protected the master key but could not remove the legacy plaintext key. Close applications using the data folder and restart Nami Mail to complete the migration.",
    );
  }
}

/**
 * Uses Electron safeStorage (DPAPI on Windows) as the only persistent desktop
 * key wrapper. The server receives the unwrapped key in memory and never
 * needs a desktop plaintext key path or environment variable.
 */
export async function loadOrCreateDesktopMasterKey(
  dataDirectory: string,
  safeStorage: DesktopSafeStorage,
): Promise<DesktopMasterKey> {
  assertSecureStorageAvailable(safeStorage);
  await fs.mkdir(dataDirectory, { recursive: true });

  const protectedPath = path.join(dataDirectory, protectedMasterKeyFileName);
  const legacyPath = path.join(dataDirectory, legacyMasterKeyFileName);

  if (await exists(protectedPath)) {
    const key = decryptProtectedMasterKey(safeStorage, await fs.readFile(protectedPath));
    // A previous migration can be interrupted after the verified DPAPI write
    // but before cleanup. The protected record is now authoritative.
    if (await exists(legacyPath)) await removeLegacyMasterKey(legacyPath);
    return { key, created: false, migratedLegacyKey: false };
  }

  const hasLegacyKey = await exists(legacyPath);
  const key = hasLegacyKey
    ? decodeMasterKey(await fs.readFile(legacyPath, "utf8"))
    : randomBytes(masterKeyLength);

  let protectedPayload: Buffer;
  try {
    protectedPayload = safeStorage.encryptString(encodeMasterKey(key));
  } catch {
    key.fill(0);
    throw unavailableSecureStorageError();
  }

  await writeProtectedMasterKey(protectedPath, protectedPayload);
  const verified = decryptProtectedMasterKey(safeStorage, await fs.readFile(protectedPath));
  if (!verified.equals(key)) {
    key.fill(0);
    verified.fill(0);
    throw new Error("Nami Mail could not verify its protected master key.");
  }
  verified.fill(0);

  if (hasLegacyKey) await removeLegacyMasterKey(legacyPath);
  return { key, created: !hasLegacyKey, migratedLegacyKey: hasLegacyKey };
}
