import { createPublicKey, verify, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type Ed25519UpdateTrust = {
  kind: "ed25519";
  publicKey: KeyObject;
  publicKeyBase64: string;
};

export type UpdateManifestSignatureInput = {
  version: string;
  archiveName: string;
  archiveSize: number;
  archiveSha512: string;
  installerName: string;
  signature: {
    algorithm: "ed25519";
    value: string;
  } | null;
};

function decodeStrictBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !base64Pattern.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength > 0 && decoded.toString("base64") === value ? decoded : undefined;
}

/**
 * The payload is deliberately line-oriented rather than a serialized JSON
 * object. Every component is validated before this point, which makes the
 * exact UTF-8 bytes stable across the release script and desktop runtime.
 */
export function canonicalUpdateManifestPayload(input: Omit<UpdateManifestSignatureInput, "signature">): Buffer {
  return Buffer.from([
    "nami-mail-update-manifest-v1",
    input.version,
    input.archiveName,
    String(input.archiveSize),
    input.archiveSha512,
    input.installerName,
    "",
  ].join("\n"), "utf8");
}

export function parseEd25519UpdateTrust(value: unknown): Ed25519UpdateTrust | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { schemaVersion?: unknown; algorithm?: unknown; publicKey?: unknown };
  if (candidate.schemaVersion !== 1 || candidate.algorithm !== "ed25519") return undefined;
  const bytes = decodeStrictBase64(candidate.publicKey);
  if (!bytes) return undefined;
  try {
    const publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") return undefined;
    return { kind: "ed25519", publicKey, publicKeyBase64: candidate.publicKey as string };
  } catch {
    return undefined;
  }
}

export async function loadEd25519UpdateTrust(filePath: string): Promise<Ed25519UpdateTrust | undefined> {
  try {
    return parseEd25519UpdateTrust(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

export function verifyEd25519UpdateManifest(
  trust: Ed25519UpdateTrust,
  input: UpdateManifestSignatureInput,
): boolean {
  if (!input.signature || input.signature.algorithm !== "ed25519") return false;
  const signature = decodeStrictBase64(input.signature.value);
  if (!signature || signature.byteLength !== 64) return false;
  return verify(null, canonicalUpdateManifestPayload(input), trust.publicKey, signature);
}
