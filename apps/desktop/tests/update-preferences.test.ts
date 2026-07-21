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
