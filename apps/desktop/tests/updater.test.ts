import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { githubZipUpdateAssetNames } from "../src/github-zip-update.mts";
import { canonicalUpdateManifestPayload } from "../src/update-trust.mts";
import { DesktopUpdater } from "../src/updater.mts";

const sourceConfig = ["provider: github", "owner: NamiMail", "repo: nami-mail"].join("\n");
const archiveBytes = Buffer.from("Nami Mail signed update ZIP fixture");
const targetVersion = "1.2.3";
const assetNames = githubZipUpdateAssetNames(targetVersion);
const manifest = JSON.stringify({
  schemaVersion: 1,
  version: targetVersion,
  archive: {
    name: assetNames.archiveName,
    size: archiveBytes.byteLength,
    sha512: createHash("sha512").update(archiveBytes).digest("base64"),
  },
  installer: assetNames.installerName,
});

function updateFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.startsWith("https://api.github.com/")) {
    return Promise.resolve(new Response(JSON.stringify({
      tag_name: `v${targetVersion}`,
      draft: false,
      prerelease: false,
      assets: [
        { name: assetNames.archiveName, size: archiveBytes.byteLength },
        { name: assetNames.manifestName, size: Buffer.byteLength(manifest, "utf8") },
      ],
    }), { status: 200 }));
  }
  if (url.endsWith(".json")) return Promise.resolve(new Response(manifest, { status: 200 }));
  return Promise.resolve(new Response(archiveBytes, { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } }));
}

async function createUpdater(t: test.TestContext, callbacks: {
  prepareForInstall?: () => Promise<boolean>;
  launchInstaller?: (plan: Parameters<NonNullable<ConstructorParameters<typeof DesktopUpdater>[0]["launchInstaller"]>>[0]) => Promise<boolean>;
  quitForInstall?: () => void;
} = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-desktop-updater-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const configPath = path.join(profile, "app-update.yml");
  await fs.writeFile(configPath, sourceConfig, "utf8");
  const snapshots: string[] = [];
  const updater = new DesktopUpdater({
    currentVersion: "1.2.2",
    isPackaged: true,
    updateConfigPath: configPath,
    updateTrustPath: path.join(profile, "nami-update-trust.json"),
    userDataPath: profile,
    executablePath: path.join(profile, "Nami Mail.exe"),
    disabled: false,
    platform: "win32",
    now: () => Date.UTC(2026, 6, 22, 8, 0, 0),
    automaticCheckDelayMs: 3_600_000,
    periodicCheckIntervalMs: 3_600_000,
    fetchImpl: updateFetch,
    readTrustedSigner: async () => ({ publisher: "Nami Mail", thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    launchInstaller: callbacks.launchInstaller,
    broadcast: (snapshot) => snapshots.push(snapshot.phase),
    prepareForInstall: callbacks.prepareForInstall ?? (async () => true),
    recoverAfterInstallFailure: () => snapshots.push("recover"),
    quitForInstall: callbacks.quitForInstall ?? (() => snapshots.push("quit")),
  });
  assert.equal((await updater.start()).phase, "idle");
  return { updater, profile, snapshots };
}

test("discovers a release without downloading until the user accepts it", async (t) => {
  const { updater } = await createUpdater(t);
  const available = await updater.checkForUpdates();
  assert.deepEqual({
    phase: available.phase,
    targetVersion: available.targetVersion,
    suppression: available.suppression,
  }, {
    phase: "available",
    targetVersion,
    suppression: "none",
  });
  updater.dispose();
});

test("surfaces a sanitized helper installation failure once after restarting the old version", async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-desktop-updater-install-result-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const configPath = path.join(profile, "app-update.yml");
  const resultPath = path.join(profile, "updates", "install-result.json");
  const versionDirectory = path.join(profile, "updates", targetVersion);
  await fs.writeFile(configPath, sourceConfig, "utf8");
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.mkdir(path.join(versionDirectory, "helpers"), { recursive: true });
  await fs.mkdir(path.join(versionDirectory, "install-work", "temporary"), { recursive: true });
  await fs.writeFile(path.join(versionDirectory, assetNames.archiveName), archiveBytes);
  await fs.writeFile(path.join(versionDirectory, "helpers", "install-leftover.ps1"), "fixture", "utf8");
  await fs.writeFile(path.join(versionDirectory, "install-work", "temporary", assetNames.installerName), "fixture", "utf8");
  await fs.writeFile(resultPath, JSON.stringify({
    schemaVersion: 1,
    version: targetVersion,
    stage: "install",
    occurredAt: "2026-07-22T08:00:00.0000000Z",
    rawException: "C:\\Users\\Admin\\private.zip",
  }), "utf8");
  const phases: string[] = [];
  const updater = new DesktopUpdater({
    currentVersion: "1.2.2",
    isPackaged: true,
    updateConfigPath: configPath,
    updateTrustPath: path.join(profile, "nami-update-trust.json"),
    userDataPath: profile,
    executablePath: path.join(profile, "Nami Mail.exe"),
    disabled: false,
    platform: "win32",
    automaticCheckDelayMs: 3_600_000,
    periodicCheckIntervalMs: 3_600_000,
    fetchImpl: updateFetch,
    readTrustedSigner: async () => ({ publisher: "Nami Mail", thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    broadcast: (snapshot) => phases.push(snapshot.phase),
    prepareForInstall: async () => true,
    recoverAfterInstallFailure: () => undefined,
    quitForInstall: () => undefined,
  });

  const restored = await updater.start();
  assert.equal(restored.phase, "error");
  assert.equal(restored.targetVersion, targetVersion);
  assert.equal(restored.checkedAt, "2026-07-22T08:00:00.0000000Z");
  assert.match(restored.message, /重新检查并下载更新/);
  assert.doesNotMatch(restored.message, /Users|private|zip/i);
  assert.ok(phases.includes("error"));
  await assert.rejects(fs.access(resultPath), /ENOENT/);
  await assert.rejects(fs.access(versionDirectory), /ENOENT/);
  assert.equal((await updater.checkForUpdates()).phase, "available");
  updater.dispose();
});

test("cleans a persisted successful-update cache by its validated target version on startup", async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-desktop-updater-cleanup-result-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const configPath = path.join(profile, "app-update.yml");
  const cacheDirectory = path.join(profile, "updates");
  const versionDirectory = path.join(cacheDirectory, targetVersion);
  const resultPath = path.join(cacheDirectory, "install-result.json");
  await fs.writeFile(configPath, sourceConfig, "utf8");
  await fs.mkdir(versionDirectory, { recursive: true });
  await fs.writeFile(path.join(versionDirectory, assetNames.archiveName), archiveBytes);
  await fs.writeFile(resultPath, JSON.stringify({
    schemaVersion: 1,
    version: targetVersion,
    stage: "cleanup",
    occurredAt: "2026-07-22T08:00:00.0000000Z",
  }), "utf8");
  const updater = new DesktopUpdater({
    currentVersion: targetVersion,
    isPackaged: true,
    updateConfigPath: configPath,
    updateTrustPath: path.join(profile, "nami-update-trust.json"),
    userDataPath: profile,
    executablePath: path.join(profile, "Nami Mail.exe"),
    disabled: false,
    platform: "win32",
    automaticCheckDelayMs: 3_600_000,
    periodicCheckIntervalMs: 3_600_000,
    fetchImpl: updateFetch,
    readTrustedSigner: async () => ({ publisher: "Nami Mail", thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    broadcast: () => undefined,
    prepareForInstall: async () => true,
    recoverAfterInstallFailure: () => undefined,
    quitForInstall: () => undefined,
  });

  const restored = await updater.start();
  assert.equal(restored.phase, "up-to-date");
  assert.equal(restored.targetVersion, targetVersion);
  assert.match(restored.message, /已在启动时清理/);
  await assert.rejects(fs.access(versionDirectory), /ENOENT/);
  await assert.rejects(fs.access(resultPath), /ENOENT/);
  updater.dispose();
});

test("uses the embedded Ed25519 release trust when the installed executable is unsigned", async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-desktop-updater-ed25519-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const configPath = path.join(profile, "app-update.yml");
  const trustPath = path.join(profile, "nami-update-trust.json");
  await fs.writeFile(configPath, sourceConfig, "utf8");
  await fs.writeFile(trustPath, JSON.stringify({
    schemaVersion: 1,
    algorithm: "ed25519",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }), "utf8");
  const unsignedManifest = JSON.parse(manifest) as {
    version: string;
    archive: { name: string; size: number; sha512: string };
    installer: string;
  };
  const signedManifest = JSON.stringify({
    ...unsignedManifest,
    signature: {
      algorithm: "ed25519",
      value: sign(null, canonicalUpdateManifestPayload({
        version: unsignedManifest.version,
        archiveName: unsignedManifest.archive.name,
        archiveSize: unsignedManifest.archive.size,
        archiveSha512: unsignedManifest.archive.sha512,
        installerName: unsignedManifest.installer,
      }), privateKey).toString("base64"),
    },
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({
        tag_name: `v${targetVersion}`,
        draft: false,
        prerelease: false,
        assets: [
          { name: assetNames.archiveName, size: archiveBytes.byteLength },
          { name: assetNames.manifestName, size: Buffer.byteLength(signedManifest, "utf8") },
        ],
      }), { status: 200 });
    }
    if (url.endsWith(".json")) return new Response(signedManifest, { status: 200 });
    return new Response(archiveBytes, { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } });
  };
  const updater = new DesktopUpdater({
    currentVersion: "1.2.2",
    isPackaged: true,
    updateConfigPath: configPath,
    updateTrustPath: trustPath,
    userDataPath: profile,
    executablePath: path.join(profile, "Nami Mail.exe"),
    disabled: false,
    platform: "win32",
    automaticCheckDelayMs: 3_600_000,
    periodicCheckIntervalMs: 3_600_000,
    fetchImpl,
    readTrustedSigner: async () => undefined,
    broadcast: () => undefined,
    prepareForInstall: async () => true,
    recoverAfterInstallFailure: () => undefined,
    quitForInstall: () => undefined,
  });

  assert.equal((await updater.start()).phase, "idle");
  const available = await updater.checkForUpdates();
  assert.equal(available.phase, "available");
  assert.equal(available.targetVersion, targetVersion);
  updater.dispose();
});

test("persists skip and later recognizes that only the same target is suppressed", async (t) => {
  const first = await createUpdater(t);
  await first.updater.checkForUpdates();
  const skipped = await first.updater.skipAvailableUpdate();
  assert.equal(skipped.suppression, "skipped");
  assert.equal(skipped.phase, "available");
  first.updater.dispose();

  const second = new DesktopUpdater({
    currentVersion: "1.2.2",
    isPackaged: true,
    updateConfigPath: path.join(first.profile, "app-update.yml"),
    updateTrustPath: path.join(first.profile, "nami-update-trust.json"),
    userDataPath: first.profile,
    executablePath: path.join(first.profile, "Nami Mail.exe"),
    disabled: false,
    platform: "win32",
    automaticCheckDelayMs: 3_600_000,
    periodicCheckIntervalMs: 3_600_000,
    fetchImpl: updateFetch,
    readTrustedSigner: async () => ({ publisher: "Nami Mail", thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    broadcast: () => undefined,
    prepareForInstall: async () => true,
    recoverAfterInstallFailure: () => undefined,
    quitForInstall: () => undefined,
  });
  await second.start();
  const rechecked = await second.checkForUpdates();
  assert.equal(rechecked.targetVersion, targetVersion);
  assert.equal(rechecked.suppression, "skipped");
  second.dispose();
});

test("downloads with progress and only launches the installer after service shutdown", async (t) => {
  const calls: string[] = [];
  const { updater, profile, snapshots } = await createUpdater(t, {
    prepareForInstall: async () => {
      calls.push("prepare");
      return true;
    },
    launchInstaller: async (plan) => {
      calls.push("launch");
      assert.equal(plan.archivePath, path.join(profile, "updates", targetVersion, assetNames.archiveName));
      assert.equal(plan.installerName, assetNames.installerName);
      assert.equal(plan.archiveSize, archiveBytes.byteLength);
      return true;
    },
    quitForInstall: () => calls.push("quit"),
  });
  await updater.checkForUpdates();
  const ready = await updater.downloadAvailableUpdate();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.percent, 100);
  assert.ok(snapshots.includes("downloading"));
  const installed = await updater.installDownloadedUpdate();
  assert.equal(installed.accepted, true);
  assert.deepEqual(calls, ["prepare", "launch", "quit"]);
  updater.dispose();
});

test("does not launch an installer when local mail data cannot close safely", async (t) => {
  const calls: string[] = [];
  const { updater } = await createUpdater(t, {
    prepareForInstall: async () => false,
    launchInstaller: async () => {
      calls.push("launch");
      return true;
    },
  });
  await updater.checkForUpdates();
  await updater.downloadAvailableUpdate();
  const installed = await updater.installDownloadedUpdate();
  assert.equal(installed.accepted, false);
  assert.equal(installed.snapshot.phase, "error");
  assert.deepEqual(calls, []);
  updater.dispose();
});
