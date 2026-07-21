import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function strictBase64(value, label) {
  if (typeof value !== "string" || !base64Pattern.test(value)) {
    throw new Error(`${label} must be strict base64 without whitespace.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.byteLength || bytes.toString("base64") !== value) throw new Error(`${label} must be strict base64 without whitespace.`);
  return bytes;
}

function assertStableVersion(version) {
  if (typeof version !== "string" || !stableVersionPattern.test(version)) throw new Error("ZIP update assets require a stable x.y.z version.");
  return version;
}

function powershellPath() {
  return path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function githubZipUpdateAssetNames(version) {
  const stableVersion = assertStableVersion(version);
  return {
    archiveName: `nami-mail-update-${stableVersion}-win-x64.zip`,
    manifestName: `nami-mail-update-${stableVersion}-win-x64.json`,
    installerName: `Nami Mail Setup ${stableVersion}.exe`,
  };
}

/**
 * Keep this byte sequence in sync with apps/desktop/src/update-trust.mts.
 * Each field is independently validated before signing or verification.
 */
export function canonicalUpdateManifestPayload({ version, archiveName, archiveSize, archiveSha512, installerName }) {
  return Buffer.from([
    "nami-mail-update-manifest-v1",
    version,
    archiveName,
    String(archiveSize),
    archiveSha512,
    installerName,
    "",
  ].join("\n"), "utf8");
}

export function readEd25519SigningKey(environment = process.env) {
  const raw = environment.NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY?.trim();
  if (!raw) return undefined;
  const privateKey = createPrivateKey({
    key: strictBase64(raw, "NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY must contain a PKCS#8 Ed25519 private key.");
  }
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export async function writeEd25519UpdateTrust(filePath, signingKey) {
  if (!signingKey) return undefined;
  const contents = `${JSON.stringify({
    schemaVersion: 1,
    algorithm: "ed25519",
    publicKey: signingKey.publicKeyBase64,
  }, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o644 });
  return signingKey.publicKeyBase64;
}

async function sha512File(filePath) {
  const bytes = await fs.readFile(filePath);
  return {
    size: bytes.byteLength,
    sha512: createHash("sha512").update(bytes).digest("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function createZip(installerPath, archivePath) {
  const command = "Compress-Archive -LiteralPath $env:NAMI_MAIL_UPDATE_INSTALLER -DestinationPath $env:NAMI_MAIL_UPDATE_ARCHIVE -Force";
  await execFileAsync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: {
      ...process.env,
      NAMI_MAIL_UPDATE_INSTALLER: installerPath,
      NAMI_MAIL_UPDATE_ARCHIVE: archivePath,
    },
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024,
  });
}

export async function createGitHubZipUpdateAssets({ projectRoot, releaseDirectory: configuredReleaseDirectory, version, signingKey }) {
  const stableVersion = assertStableVersion(version);
  if (!configuredReleaseDirectory) {
    throw new Error("ZIP update asset generation requires the resolved release directory from the package workflow.");
  }
  const releaseDirectory = path.resolve(configuredReleaseDirectory);
  const relativeReleaseDirectory = path.relative(projectRoot, releaseDirectory);
  assert.ok(
    relativeReleaseDirectory && !relativeReleaseDirectory.startsWith("..") && !path.isAbsolute(relativeReleaseDirectory),
    "ZIP update assets must be generated inside the repository release directory.",
  );
  const { archiveName, manifestName, installerName } = githubZipUpdateAssetNames(stableVersion);
  const installerPath = path.join(releaseDirectory, installerName);
  const archivePath = path.join(releaseDirectory, archiveName);
  const manifestPath = path.join(releaseDirectory, manifestName);
  const installer = await fs.stat(installerPath);
  assert.ok(installer.isFile() && installer.size > 1_000_000, "The ZIP update must wrap the fresh NSIS installer.");
  await fs.rm(archivePath, { force: true });
  await fs.rm(manifestPath, { force: true });
  await createZip(installerPath, archivePath);
  const archive = await sha512File(archivePath);
  assert.ok(archive.size > 1_000_000, "The generated ZIP update is unexpectedly small.");
  const unsignedManifest = {
    schemaVersion: 1,
    version: stableVersion,
    archive: {
      name: archiveName,
      size: archive.size,
      sha512: archive.sha512,
    },
    installer: installerName,
  };
  const signature = signingKey
    ? {
      algorithm: "ed25519",
      value: sign(null, canonicalUpdateManifestPayload({
        version: unsignedManifest.version,
        archiveName: unsignedManifest.archive.name,
        archiveSize: unsignedManifest.archive.size,
        archiveSha512: unsignedManifest.archive.sha512,
        installerName: unsignedManifest.installer,
      }), signingKey.privateKey).toString("base64"),
    }
    : undefined;
  await fs.writeFile(manifestPath, `${JSON.stringify({ ...unsignedManifest, ...(signature ? { signature } : {}) }, null, 2)}\n`, "utf8");
  const manifest = await sha512File(manifestPath);
  return [
    { name: archiveName, filePath: archivePath, size: archive.size, sha256: archive.sha256 },
    { name: manifestName, filePath: manifestPath, size: manifest.size, sha256: manifest.sha256 },
  ];
}
