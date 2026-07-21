import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import asar from "@electron/asar";
import yaml from "js-yaml";
import {
  assertWindowsSignatureMatchesExpectedIdentity,
  parseExpectedWindowsSigningIdentity,
  resolveReleaseDirectory,
} from "./release-policy.mjs";
import { canonicalUpdateManifestPayload, githubZipUpdateAssetNames } from "./github-update-assets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseDirectory = resolveReleaseDirectory(projectRoot);
const expectedInstallerName = `Nami Mail Setup ${packageManifest.version}.exe`;
const archivePath = path.join(releaseDirectory, "win-unpacked", "resources", "app.asar");
const packagedExecutable = path.join(
  releaseDirectory,
  "win-unpacked",
  process.platform === "win32" ? "Nami Mail.exe" : "Nami Mail",
);
const execFileAsync = promisify(execFile);
const expectedInstallerOverride = process.env.NAMI_MAIL_EXPECTED_INSTALLER?.trim();
const packageStartedAt = Number.parseInt(process.env.NAMI_MAIL_PACKAGE_STARTED_AT ?? "", 10);
const {
  NAMI_MAIL_INSTALLER_EXECUTABLE: _ignoredInstallerExecutable,
  NAMI_MAIL_EXPECTED_INSTALLER: _ignoredExpectedInstaller,
  NAMI_MAIL_PACKAGE_STARTED_AT: _ignoredPackageStartedAt,
  GH_TOKEN: _githubToken,
  GITHUB_TOKEN: _githubActionsToken,
  GITHUB_RELEASE_TOKEN: _githubReleaseToken,
  CSC_LINK: _certificateLink,
  CSC_KEY_PASSWORD: _certificatePassword,
  WIN_CSC_LINK: _windowsCertificateLink,
  WIN_CSC_KEY_PASSWORD: _windowsCertificatePassword,
  NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY: _updatePrivateKey,
  NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER: _expectedWindowsPublisher,
  NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT: _expectedWindowsCertificateThumbprint,
  ...cleanEnvironment
} = process.env;
const sharpPlatformPackageDirectory = path.join(
  projectRoot,
  "node_modules",
  "@img",
  "sharp-win32-x64",
);
const sharpNativeBinaryNames = (await fs.readdir(path.join(sharpPlatformPackageDirectory, "lib")))
  .filter((entry) => entry.endsWith(".node"));
assert.ok(
  sharpNativeBinaryNames.length > 0,
  "Installed @img/sharp-win32-x64 package does not contain a native .node binary.",
);
const expectedFiles = [
  "apps/desktop/dist/main.mjs",
  "apps/desktop/dist/preload.cjs",
  "apps/server/dist/runtime.js",
  "apps/web/dist/index.html",
  "apps/web/dist/favicon.ico",
  "apps/web/dist/brand/mark-light.png",
  "apps/web/dist/brand/mark-dark.png",
  "apps/web/dist/backgrounds/paper.png",
  "apps/web/dist/backgrounds/mist.png",
  "apps/web/dist/backgrounds/coast.png",
  "apps/web/dist/backgrounds/dawn.png",
  "apps/web/dist/backgrounds/night.png",
  "node_modules/fastify/package.json",
  "node_modules/imapflow/package.json",
  "node_modules/nodemailer/package.json",
  "node_modules/oauth4webapi/package.json",
  "node_modules/dotenv/package.json",
  "node_modules/better-sqlite3/package.json",
  "node_modules/sharp/package.json",
  "node_modules/@img/sharp-win32-x64/package.json",
];

function resolveExactInstaller(target) {
  const resolved = path.resolve(target);
  assert.equal(
    path.relative(releaseDirectory, resolved),
    expectedInstallerName,
    `Installer smoke must use ${path.join("release", expectedInstallerName)}.`,
  );
  return resolved;
}

assert.equal(
  Boolean(process.env.NAMI_MAIL_INSTALLER_EXECUTABLE?.trim()),
  false,
  "NAMI_MAIL_INSTALLER_EXECUTABLE is not accepted by the package smoke. Use the exact build artifact instead.",
);
const installerPath = resolveExactInstaller(expectedInstallerOverride ?? path.join(releaseDirectory, expectedInstallerName));

await fs.access(archivePath);
const packagedIconPath = path.join(releaseDirectory, "win-unpacked", "resources", "icon.ico");
await fs.access(packagedIconPath);
assert.deepEqual(
  await fs.readFile(packagedIconPath),
  await fs.readFile(path.join(projectRoot, "build", "icon.ico")),
  "The packaged runtime icon must match the generated multi-size brand icon.",
);
const packageEntries = new Set(
  asar.listPackage(archivePath).map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, "")),
);
for (const expected of expectedFiles) {
  assert.equal(packageEntries.has(expected), true, `Packaged app is missing ${expected}`);
}
const expectedUpdateOwner = process.env.NAMI_MAIL_EXPECT_GITHUB_UPDATE_OWNER?.trim();
const expectedUpdateRepo = process.env.NAMI_MAIL_EXPECT_GITHUB_UPDATE_REPO?.trim();
const requireSignedUpdateArtifacts = process.env.NAMI_MAIL_REQUIRE_SIGNED_UPDATE_ARTIFACTS === "1";
const expectedEd25519PublicKey = process.env.NAMI_MAIL_EXPECT_ED25519_UPDATE_PUBLIC_KEY?.trim();
const expectedSigningIdentity = requireSignedUpdateArtifacts
  ? parseExpectedWindowsSigningIdentity(process.env)
  : undefined;
const appUpdateConfigPath = path.join(releaseDirectory, "win-unpacked", "resources", "app-update.yml");
assert.equal(Boolean(expectedUpdateOwner), Boolean(expectedUpdateRepo), "GitHub update owner and repository must be supplied together.");
if (requireSignedUpdateArtifacts) {
  assert.ok(expectedUpdateOwner && expectedUpdateRepo, "Authenticode update checks require a GitHub update build.");
}
if (expectedEd25519PublicKey) {
  assert.ok(expectedUpdateOwner && expectedUpdateRepo, "An embedded Ed25519 release key is only valid for a GitHub update build.");
}

function yamlRecord(contents, label) {
  const parsed = yaml.load(contents);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${label} must contain a YAML object.`);
  return parsed;
}

async function authenticodeSignature(filePath) {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:NAMI_MAIL_SIGNATURE_TARGET",
    "$certificate = $signature.SignerCertificate",
    "$timestampCertificate = $signature.TimeStamperCertificate",
    "$simpleName = if ($certificate) { $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }",
    "[PSCustomObject]@{ Status = [string]$signature.Status; Subject = if ($certificate) { $certificate.Subject } else { '' }; SimpleName = $simpleName; Thumbprint = if ($certificate) { $certificate.Thumbprint } else { '' }; TimestampThumbprint = if ($timestampCertificate) { $timestampCertificate.Thumbprint } else { '' } } | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...cleanEnvironment, NAMI_MAIL_SIGNATURE_TARGET: filePath },
    windowsHide: true,
  });
  return JSON.parse(stdout.trim());
}

async function inspectZipUpdateArchive(zipPath) {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$archive = [IO.Compression.ZipFile]::OpenRead($env:NAMI_MAIL_ZIP_UPDATE_ARCHIVE)",
    "try { [PSCustomObject]@{ Entries = @($archive.Entries | ForEach-Object { $_.FullName }) } | ConvertTo-Json -Compress } finally { $archive.Dispose() }",
  ].join("; ");
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...cleanEnvironment, NAMI_MAIL_ZIP_UPDATE_ARCHIVE: zipPath },
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout.trim());
  return Array.isArray(parsed.Entries) ? parsed.Entries : [parsed.Entries].filter((value) => typeof value === "string");
}

let updateMetadataVerified = false;
let signedUpdateArtifacts = false;
if (expectedUpdateOwner && expectedUpdateRepo) {
  const updateConfig = yamlRecord(await fs.readFile(appUpdateConfigPath, "utf8"), "app-update.yml");
  assert.equal(updateConfig.provider, "github", "Packaged update provider must be GitHub.");
  assert.equal(updateConfig.owner, expectedUpdateOwner);
  assert.equal(updateConfig.repo, expectedUpdateRepo);
  assert.equal("token" in updateConfig, false, "app-update.yml must never contain a GitHub token.");

  const latestPath = path.join(releaseDirectory, "latest.yml");
  const latest = yamlRecord(await fs.readFile(latestPath, "utf8"), "latest.yml");
  assert.equal(latest.version, packageManifest.version, "latest.yml version must match package.json.");
  assert.ok(Array.isArray(latest.files) && latest.files.length > 0, "latest.yml must describe at least one update artifact.");
  const installerEntry = latest.files.find((entry) => entry && typeof entry === "object" && typeof entry.url === "string" && entry.url.toLowerCase().endsWith(".exe"));
  assert.ok(installerEntry, "latest.yml must reference the NSIS installer.");
  const installerBytes = await fs.readFile(installerPath);
  const installerSha512 = createHash("sha512").update(installerBytes).digest("base64");
  assert.equal(installerEntry.sha512, installerSha512, "latest.yml installer SHA512 must match the exact installer bytes.");
  if (installerEntry.size !== undefined) assert.equal(installerEntry.size, installerBytes.length, "latest.yml installer size must match.");
  assert.equal(latest.path, installerEntry.url, "latest.yml legacy path must match its installer entry.");
  assert.equal(latest.sha512, installerSha512, "latest.yml legacy SHA512 must match the installer.");

  const blockmapPath = `${installerPath}.blockmap`;
  const blockmapBytes = await fs.readFile(blockmapPath);
  const blockmap = JSON.parse(gunzipSync(blockmapBytes).toString("utf8"));
  assert.equal(blockmap.version, "2", "NSIS blockmap must use the supported v2 format.");
  assert.ok(Array.isArray(blockmap.files) && blockmap.files.length > 0, "NSIS blockmap must describe installer files.");

  const { archiveName, manifestName, installerName } = githubZipUpdateAssetNames(packageManifest.version);
  const zipPath = path.join(releaseDirectory, archiveName);
  const manifestPath = path.join(releaseDirectory, manifestName);
  const updateManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const zipBytes = await fs.readFile(zipPath);
  assert.equal(updateManifest.schemaVersion, 1, "ZIP update manifest schema must be supported.");
  assert.equal(updateManifest.version, packageManifest.version, "ZIP update manifest version must match package.json.");
  assert.equal(updateManifest.archive?.name, archiveName, "ZIP update manifest must identify the exact release ZIP.");
  assert.equal(updateManifest.archive?.size, zipBytes.length, "ZIP update manifest size must match the exact ZIP bytes.");
  assert.equal(
    updateManifest.archive?.sha512,
    createHash("sha512").update(zipBytes).digest("base64"),
    "ZIP update manifest SHA-512 must match the exact ZIP bytes.",
  );
  assert.equal(updateManifest.installer, installerName, "ZIP update manifest must bind the version-specific NSIS installer name.");
  assert.deepEqual(await inspectZipUpdateArchive(zipPath), [installerName], "ZIP update must contain exactly the version-specific NSIS installer.");

  const trustPath = path.join(releaseDirectory, "win-unpacked", "resources", "nami-update-trust.json");
  const trust = JSON.parse(await fs.readFile(trustPath, "utf8"));
  if (expectedEd25519PublicKey) {
    assert.equal(trust.schemaVersion, 1, "Embedded ZIP update trust schema must be supported.");
    assert.equal(trust.algorithm, "ed25519", "Unsigned update builds must embed an Ed25519 trust root.");
    assert.equal(trust.publicKey, expectedEd25519PublicKey, "Embedded ZIP update public key must match the release signing key.");
    assert.equal(updateManifest.signature?.algorithm, "ed25519", "Ed25519 update builds must sign the ZIP update manifest.");
    const publicKey = createPublicKey({ key: Buffer.from(expectedEd25519PublicKey, "base64"), format: "der", type: "spki" });
    assert.equal(
      verify(null, canonicalUpdateManifestPayload({
        version: updateManifest.version,
        archiveName: updateManifest.archive.name,
        archiveSize: updateManifest.archive.size,
        archiveSha512: updateManifest.archive.sha512,
        installerName: updateManifest.installer,
      }), publicKey, Buffer.from(updateManifest.signature.value, "base64")),
      true,
      "ZIP update manifest signature must verify against the embedded Ed25519 public key.",
    );
  } else {
    assert.equal(trust.algorithm, "disabled", "A certificate-only update build must not silently embed an unrelated ZIP release key.");
  }

  if (Number.isFinite(packageStartedAt)) {
    for (const metadataPath of [appUpdateConfigPath, latestPath, blockmapPath, zipPath, manifestPath]) {
      assert.ok((await fs.stat(metadataPath)).mtimeMs >= packageStartedAt, `${path.basename(metadataPath)} predates this package run.`);
    }
  }

  if (requireSignedUpdateArtifacts) {
    assert.ok(expectedSigningIdentity, "Signed update artifact checks require a pinned Authenticode identity.");
    const publisherNames = (Array.isArray(updateConfig.publisherName) ? updateConfig.publisherName : [updateConfig.publisherName])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    assert.ok(publisherNames.includes(expectedSigningIdentity.publisher), "app-update.yml publisherName must include the independently configured Windows publisher.");
    for (const signedPath of [installerPath, packagedExecutable]) {
      const signature = await authenticodeSignature(signedPath);
      assert.equal(signature.Status, "Valid", `${path.basename(signedPath)} must have a valid Authenticode signature.`);
      assertWindowsSignatureMatchesExpectedIdentity(signature, expectedSigningIdentity, path.basename(signedPath));
      assert.ok(signature.TimestampThumbprint, `${path.basename(signedPath)} must carry a trusted signing timestamp.`);
    }
    signedUpdateArtifacts = true;
  }
  updateMetadataVerified = true;
}
await fs.access(path.join(
  releaseDirectory,
  "win-unpacked",
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
));
for (const sharpNativeBinaryName of sharpNativeBinaryNames) {
  await fs.access(path.join(
    releaseDirectory,
    "win-unpacked",
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@img",
    "sharp-win32-x64",
    "lib",
    sharpNativeBinaryName,
  ));
}

const installerStat = await fs.stat(installerPath);
assert.ok(installerStat.size > 1_000_000, "Windows installer is unexpectedly small.");
if (Number.isFinite(packageStartedAt)) {
  assert.ok(
    installerStat.mtimeMs >= packageStartedAt,
    `Installer predates this package run: ${new Date(installerStat.mtimeMs).toISOString()}`,
  );
}

// Verify the exact Electron executable that electron-builder produced. The
// normal desktop smoke uses the development runtime, which cannot prove that
// the packaged asar, preload and native SQLite module boot together.
await fs.access(packagedExecutable);
const { stdout, stderr } = await execFileAsync(
  process.execPath,
  [path.join(projectRoot, "scripts", "smoke-desktop.mjs")],
  {
    cwd: projectRoot,
    env: {
      ...cleanEnvironment,
      NAMI_MAIL_DESKTOP_EXECUTABLE: packagedExecutable,
    },
    timeout: 60_000,
    windowsHide: true,
  },
);
const packagedSmokeOutput = stdout.trim();
assert.ok(packagedSmokeOutput, `Packaged desktop smoke produced no output.${stderr ? ` ${stderr.trim()}` : ""}`);
let packagedSmoke;
try {
  packagedSmoke = JSON.parse(packagedSmokeOutput);
} catch {
  throw new Error(`Packaged desktop smoke did not return JSON: ${packagedSmokeOutput}`);
}
assert.equal(packagedSmoke.title, "Nami Mail");
assert.equal(packagedSmoke.desktopApiAvailable, true);
assert.equal(packagedSmoke.isolatedDataDirectory, true);
assert.equal(packagedSmoke.contentSecurityPolicy, true);
assert.equal(packagedSmoke.desktopLifecycle?.appUserModelId, "com.nami.mail");
assert.equal(packagedSmoke.desktopLifecycle?.closeBehavior, "ask");
assert.equal(packagedSmoke.desktopLifecycle?.trayCreated, true);

const installerSmokeResult = await execFileAsync(
  process.execPath,
  [path.join(projectRoot, "scripts", "smoke-installer.mjs")],
  {
    cwd: projectRoot,
    env: {
      ...cleanEnvironment,
      NAMI_MAIL_EXPECTED_INSTALLER: installerPath,
      ...(Number.isFinite(packageStartedAt) ? { NAMI_MAIL_PACKAGE_STARTED_AT: String(packageStartedAt) } : {}),
    },
    timeout: 240_000,
    windowsHide: true,
  },
);
const installerSmokeOutput = installerSmokeResult.stdout.trim();
assert.ok(installerSmokeOutput, `Installer smoke produced no output.${installerSmokeResult.stderr ? ` ${installerSmokeResult.stderr.trim()}` : ""}`);
let installerSmoke;
try {
  installerSmoke = JSON.parse(installerSmokeOutput);
} catch {
  throw new Error(`Installer smoke did not return JSON: ${installerSmokeOutput}`);
}
assert.equal(installerSmoke.installer, path.relative(projectRoot, installerPath));
assert.equal(installerSmoke.uninstalled, true);
assert.equal(installerSmoke.sameVersionSilentReinstall, true);
assert.equal(installerSmoke.noNewNamiMailProcesses, true);
assert.equal(installerSmoke.desktopSmoke?.title, "Nami Mail");

console.log(JSON.stringify({
  archive: path.relative(projectRoot, archivePath),
  installer: path.relative(projectRoot, installerPath),
  installerBytes: installerStat.size,
  verifiedEntries: expectedFiles.length,
  packagedDesktopSmoke: true,
  installerSmoke: true,
  updateMetadataVerified,
  signedUpdateArtifacts,
}));
