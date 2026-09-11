import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePendingUpdateInstall,
  PendingUpdateInstallStore,
  pendingInstallObservationDelayMs,
  pendingUpdateInstallPath,
  resolvePendingUpdateInstall,
} from "../src/update-pending-install.mts";

const startedAt = "2026-09-10T08:00:00.000Z";
const record = {
  schemaVersion: 1 as const,
  fromVersion: "0.3.0",
  toVersion: "0.3.1",
  startedAt,
};

async function temporaryStore(t: test.TestContext): Promise<{ store: PendingUpdateInstallStore; profile: string }> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-pending-install-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  return { store: new PendingUpdateInstallStore(pendingUpdateInstallPath(path.join(profile, "updates"))), profile };
}

test("parses only well-formed install records", () => {
  assert.deepEqual(parsePendingUpdateInstall(record), record);
  for (const invalid of [
    null,
    [],
    { ...record, schemaVersion: 2 },
    { ...record, fromVersion: "0.3" },
    { ...record, toVersion: "v0.3.1" },
    { ...record, startedAt: "2026-09-10 08:00:00" },
    { ...record, startedAt: "not-a-date" },
    { schemaVersion: 1, fromVersion: "0.3.0", toVersion: "0.3.1" },
  ]) {
    assert.equal(parsePendingUpdateInstall(invalid), undefined);
  }
});

test("reads the running version as the outcome of a recorded install", () => {
  const startedMs = Date.parse(startedAt);
  // Target running: the install landed.
  assert.equal(resolvePendingUpdateInstall(record, "0.3.1", startedMs + 10 * 60_000), "landed");
  // Still the source version, well past the helper's window: it never applied.
  assert.equal(resolvePendingUpdateInstall(record, "0.3.0", startedMs + 10 * 60_000), "not-applied");
  // Still the source version, inside the window: the helper may still be running.
  assert.equal(resolvePendingUpdateInstall(record, "0.3.0", startedMs + 1_000), "pending");
  assert.equal(
    resolvePendingUpdateInstall(record, "0.3.0", startedMs + pendingInstallObservationDelayMs - 1),
    "pending",
  );
  // A third version makes the record meaningless rather than a failed install.
  assert.equal(resolvePendingUpdateInstall(record, "0.2.9", startedMs + 10 * 60_000), "invalid");
  // A no-op record can never describe an upgrade.
  assert.equal(
    resolvePendingUpdateInstall({ ...record, toVersion: "0.3.0" }, "0.3.0", startedMs + 10 * 60_000),
    "invalid",
  );
});

test("round-trips a record and clears it again", async (t) => {
  const { store } = await temporaryStore(t);
  assert.equal(await store.read(), undefined);
  await store.write(record);
  assert.deepEqual(await store.read(), record);
  await store.clear();
  assert.equal(await store.read(), undefined);
});

test("refuses to persist a record it could not read back", async (t) => {
  const { store } = await temporaryStore(t);
  await assert.rejects(() => store.write({ ...record, toVersion: "not-a-version" } as typeof record));
  assert.equal(await store.read(), undefined);
});

test("discards a damaged record instead of failing the launch", async (t) => {
  const { store, profile } = await temporaryStore(t);
  const recordPath = pendingUpdateInstallPath(path.join(profile, "updates"));
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, "{ not json", "utf8");
  assert.equal(await store.read(), undefined);
  await assert.rejects(() => fs.access(recordPath));
});
