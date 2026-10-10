import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  emptyUpdatePreferences,
  normalizeUpdatePreferences,
  resolveUpdatePromptPolicy,
  skipUpdateVersion,
  snoozeUpdateVersion,
  UpdatePreferencesStore,
} from "../src/update-preferences.mts";

test("keeps a skipped release version-specific", () => {
  const preferences = skipUpdateVersion(emptyUpdatePreferences(), "1.2.3");
  assert.deepEqual(resolveUpdatePromptPolicy(preferences, "1.2.3", Date.UTC(2026, 6, 22)), {
    suppression: "skipped",
    remindAt: null,
  });
  assert.deepEqual(resolveUpdatePromptPolicy(preferences, "1.2.4", Date.UTC(2026, 6, 22)), {
    suppression: "none",
    remindAt: null,
  });
});

test("snoozes only until the requested reminder time", () => {
  const now = Date.UTC(2026, 6, 22, 8, 0, 0);
  const preferences = snoozeUpdateVersion(emptyUpdatePreferences(), "1.2.3", 60, now);
  assert.deepEqual(resolveUpdatePromptPolicy(preferences, "1.2.3", now + 59 * 60_000), {
    suppression: "snoozed",
    remindAt: "2026-07-22T09:00:00.000Z",
  });
  assert.deepEqual(resolveUpdatePromptPolicy(preferences, "1.2.3", now + 60 * 60_000), {
    suppression: "none",
    remindAt: null,
  });
  assert.throws(() => snoozeUpdateVersion(emptyUpdatePreferences(), "1.2.3", 4, now), /between 5 minutes and 30 days/);
});

test("normalizes damaged preference data without carrying arbitrary values forward", () => {
  assert.deepEqual(normalizeUpdatePreferences({
    schemaVersion: 1,
    skippedVersion: "1.2.3",
    snoozedVersion: "invalid",
    snoozedUntil: "not-a-date",
    extra: "ignore-me",
  }), {
    schemaVersion: 1,
    skippedVersion: "1.2.3",
    snoozedVersion: null,
    snoozedUntil: null,
  });
});

test("a mkdir failure leaves memory and disk on the previous preference", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-preferences-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // A plain file where the parent directory should be makes the very first
  // write step (mkdir -p) fail without touching permissions.
  const blocker = path.join(directory, "blocker.json");
  await fs.writeFile(blocker, "not a directory");
  const store = new UpdatePreferencesStore(path.join(blocker, "update-preferences.json"));
  await store.load();
  await assert.rejects(store.save(skipUpdateVersion(store.get(), "1.2.3")));
  assert.equal(store.get().skippedVersion, null);
  assert.equal(await fs.readFile(blocker, "utf8"), "not a directory");
});

test("a writeFile failure leaves memory and disk on the previous preference", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-preferences-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "update-preferences.json");
  const store = new UpdatePreferencesStore(filePath);
  await store.load();
  const persisted = await store.save(snoozeUpdateVersion(store.get(), "1.2.3", 30, Date.UTC(2026, 6, 22, 8, 0, 0)));
  const baselineBytes = await fs.readFile(filePath, "utf8");
  t.mock.method(fs, "writeFile", async () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  await assert.rejects(store.save(skipUpdateVersion(store.get(), "1.2.4")), /disk full/);
  // Memory still reflects the last committed preference, and the file on
  // disk is byte-identical to it — the caller's error and both views agree.
  assert.deepEqual(store.get(), persisted);
  assert.equal(await fs.readFile(filePath, "utf8"), baselineBytes);
});

test("a rename failure leaves memory and disk on the previous preference", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-preferences-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "update-preferences.json");
  const store = new UpdatePreferencesStore(filePath);
  await store.load();
  const persisted = await store.save(skipUpdateVersion(store.get(), "1.2.3"));
  const baselineBytes = await fs.readFile(filePath, "utf8");
  t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("rename failed"), { code: "EPERM" });
  });
  await assert.rejects(store.save(skipUpdateVersion(persisted, "1.2.4")), /rename failed/);
  assert.deepEqual(store.get(), persisted);
  assert.equal(await fs.readFile(filePath, "utf8"), baselineBytes);
  // The half-written temporary file must still be cleaned up.
  assert.equal((await fs.readdir(directory)).some((entry) => entry.endsWith(".tmp")), false);
});

test("a failed save followed by a successful one is what a restarted process loads", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-preferences-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "update-preferences.json");
  const store = new UpdatePreferencesStore(filePath);
  await store.load();
  const failing = t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("rename failed"), { code: "EPERM" });
  });
  await assert.rejects(store.save(skipUpdateVersion(store.get(), "1.2.3")));
  failing.mock.restore();
  const committed = await store.save(skipUpdateVersion(store.get(), "1.2.4"));
  assert.equal(committed.skippedVersion, "1.2.4");
  const restarted = new UpdatePreferencesStore(filePath);
  assert.deepEqual(await restarted.load(), committed);
});

test("persists update prompt choices atomically under the desktop profile", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-preferences-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "nested", "update-preferences.json");
  const original = new UpdatePreferencesStore(filePath);
  await original.load();
  await original.save(snoozeUpdateVersion(original.get(), "1.2.3", 30, Date.UTC(2026, 6, 22, 8, 0, 0)));

  const restored = new UpdatePreferencesStore(filePath);
  assert.deepEqual(await restored.load(), {
    schemaVersion: 1,
    skippedVersion: null,
    snoozedVersion: "1.2.3",
    snoozedUntil: "2026-07-22T08:30:00.000Z",
  });
  assert.equal((await fs.readdir(path.dirname(filePath))).some((entry) => entry.endsWith(".tmp")), false);
});
