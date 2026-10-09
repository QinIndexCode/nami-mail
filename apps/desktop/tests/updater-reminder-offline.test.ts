import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { githubZipUpdateAssetNames } from "../src/github-zip-update.mts";
import { DesktopUpdater } from "../src/updater.mts";

// Regression coverage for the 2026-10-10 update-flow audit (two P2 findings):
// an expired snooze must not hide a verified resident archive behind a remote
// check that can fail offline, and a preference write that fails must not
// leave the running process believing it succeeded. Mocked timers, mocked
// GitHub responses, disposable profile — no installer, no real network.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const baseVersion = "1.2.3";
const archive = Buffer.from("reminder-offline regression archive fixture");

type MutableRelease = { version: string };

function manifestFor(version: string): string {
  const assetNames = githubZipUpdateAssetNames(version);
  return JSON.stringify({
    schemaVersion: 1,
    version,
    archive: {
      name: assetNames.archiveName,
      size: archive.byteLength,
      sha512: createHash("sha512").update(archive).digest("base64"),
    },
    installer: assetNames.installerName,
  });
}

async function fixture(t: test.TestContext) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-updater-reminder-"));
  const configPath = path.join(profile, "app-update.yml");
  await fs.writeFile(configPath, "provider: github\nowner: NamiMail\nrepo: nami-mail\n");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let currentTime = Date.UTC(2026, 9, 10, 8, 0, 0);
  const state = { offline: false, apiCalls: 0, archiveCalls: 0, release: { version: baseVersion } as MutableRelease };
  const snapshots: ReturnType<DesktopUpdater["getSnapshot"]>[] = [];
  const listeners = new Set<() => void>();
  const updater = new DesktopUpdater({
    currentVersion: "1.2.2",
    isPackaged: true,
    disabled: false,
    platform: "win32",
    updateConfigPath: configPath,
    updateTrustPath: path.join(profile, "nami-update-trust.json"),
    userDataPath: profile,
    executablePath: path.join(profile, "Nami Mail.exe"),
    random: () => 0.5,
    now: () => currentTime,
    readTrustedSigner: async () => ({ publisher: "Nami Mail", thumbprint: "A".repeat(40) }),
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) state.apiCalls++;
      if (state.offline) throw Object.assign(new Error("network offline"), { code: "ENETUNREACH" });
      const version = state.release.version;
      const assetNames = githubZipUpdateAssetNames(version);
      if (url.startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          assets: [
            { name: assetNames.archiveName, size: archive.byteLength },
            { name: assetNames.manifestName, size: Buffer.byteLength(manifestFor(version)) },
          ],
        }));
      }
      if (url.endsWith(".json")) return new Response(manifestFor(version));
      state.archiveCalls++;
      return new Response(archive, { headers: { "content-length": String(archive.byteLength) } });
    },
    broadcast: (snapshot) => {
      snapshots.push(snapshot);
      for (const listener of listeners) listener();
    },
    prepareForInstall: async () => true,
    launchInstaller: async () => true,
    recoverAfterInstallFailure: () => undefined,
    quitForInstall: () => undefined,
  });
  t.after(async () => {
    updater.dispose();
    t.mock.timers.reset();
    await fs.rm(profile, { recursive: true, force: true });
  });
  await updater.start();

  async function advance(ms: number, phase: string | string[]) {
    const phases = typeof phase === "string" ? [phase] : phase;
    const firstIndex = snapshots.length;
    const completed = new Promise<ReturnType<DesktopUpdater["getSnapshot"]>>((resolve, reject) => {
      const timeout = realSetTimeout(() => {
        listeners.delete(observe);
        reject(new Error(`Timed out awaiting ${phase}; current=${updater.getSnapshot().phase}`));
      }, 5_000);
      function observe() {
        const snapshot = snapshots.slice(firstIndex).find((item) => phases.includes(item.phase));
        if (!snapshot) return;
        listeners.delete(observe);
        realClearTimeout(timeout);
        resolve(snapshot);
      }
      listeners.add(observe);
    });
    t.mock.timers.tick(ms);
    return completed;
  }

  async function downloadAndSnooze(minutes: number) {
    await updater.checkForUpdates();
    await updater.downloadAvailableUpdate();
    const ready = updater.getSnapshot();
    const snoozed = await updater.snoozeAvailableUpdate(minutes);
    return { ready, snoozed };
  }

  return { updater, profile, state, snapshots, advance, downloadAndSnooze, advanceClock: (ms: number) => { currentTime += ms; } };
}

test("an expired snooze stays installable offline and records no fresh check", async (t) => {
  const f = await fixture(t);
  const { snoozed } = await f.downloadAndSnooze(5);
  assert.equal(snoozed.suppression, "snoozed");
  const checksBeforeExpiry = f.state.apiCalls;
  f.state.offline = true;
  f.advanceClock(5 * 60_000);
  const reminder = await f.advance(5 * 60_000, "ready");
  assert.equal(reminder.suppression, "none");
  // Local resolution only: no request was made and the truthful checkedAt
  // from the snoozed snapshot was carried over instead of refreshed.
  assert.equal(f.state.apiCalls, checksBeforeExpiry);
  assert.equal(reminder.checkedAt, snoozed.checkedAt);
  const install = await f.updater.installDownloadedUpdate();
  assert.equal(install.accepted, true);
});

test("a corrupted resident archive cannot reach ready when the reminder expires offline", async (t) => {
  const f = await fixture(t);
  await f.downloadAndSnooze(5);
  // The cache no longer passes verification, so neither the local expiry
  // path nor the failed-check restore may put it back into ready.
  const archivePath = path.join(f.profile, "updates", baseVersion, githubZipUpdateAssetNames(baseVersion).archiveName);
  await fs.appendFile(archivePath, "tampered");
  f.state.offline = true;
  f.advanceClock(5 * 60_000);
  const reminder = await f.advance(5 * 60_000, ["ready", "error"]);
  assert.equal(reminder.phase, "error");
  const install = await f.updater.installDownloadedUpdate();
  assert.equal(install.accepted, false);
});

test("a skipped release never schedules a reminder prompt", async (t) => {
  const f = await fixture(t);
  await f.updater.checkForUpdates();
  const skipped = await f.updater.skipAvailableUpdate();
  assert.equal(skipped.suppression, "skipped");
  assert.equal(skipped.remindAt, null);
  // The periodic check that follows still runs, but the policy for a
  // skipped version stays suppressed with no reminder time attached.
  const recheck = await f.advance(6 * 3_600_000, "available");
  assert.equal(recheck.suppression, "skipped");
  assert.equal(recheck.remindAt, null);
});

test("an undownloaded release keeps the exponential backoff while offline", async (t) => {
  const f = await fixture(t);
  f.state.offline = true;
  await f.advance(3_000, "error");
  assert.equal(f.state.apiCalls, 1);
  t.mock.timers.tick(59_999);
  assert.equal(f.state.apiCalls, 1);
  await f.advance(1, "error");
  assert.equal(f.state.apiCalls, 2);
  t.mock.timers.tick(119_999);
  assert.equal(f.state.apiCalls, 2);
  await f.advance(1, "error");
  assert.equal(f.state.apiCalls, 3);
});

test("a higher release discovered during the snooze window is handled normally", async (t) => {
  const f = await fixture(t);
  await f.downloadAndSnooze(60);
  f.state.release.version = "1.2.4";
  const discovered = await f.updater.checkAfterExternalTrigger();
  assert.equal(discovered.phase, "available");
  assert.equal(discovered.targetVersion, "1.2.4");
  assert.equal(discovered.suppression, "none");
});

test("a skip whose preference write fails stays retryable and unchanged in memory", async (t) => {
  const f = await fixture(t);
  await f.updater.checkForUpdates();
  // A directory at the target path makes the atomic rename fail — the
  // preference store must not commit the candidate before the rename lands.
  await fs.mkdir(path.join(f.profile, "update-preferences.json"));
  await assert.rejects(f.updater.skipAvailableUpdate());
  const rechecked = await f.updater.checkForUpdates();
  assert.equal(rechecked.suppression, "none");
  assert.equal(f.updater.getSnapshot().suppression, "none");
});
