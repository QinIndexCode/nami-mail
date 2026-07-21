import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeUpdateInstallFailure,
  removeUpdateVersionCache,
  UpdateInstallResultStore,
  updateInstallResultPath,
} from "../src/update-install-result.mts";

test("consumes a sanitized helper failure exactly once", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-install-result-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resultPath = updateInstallResultPath(directory);
  await fs.writeFile(resultPath, JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    stage: "verify-archive",
    occurredAt: "2026-07-22T08:00:00.0000000Z",
    detail: "C:\\Users\\Admin\\secret.zip",
  }), "utf8");

  const store = new UpdateInstallResultStore(resultPath);
  const failure = await store.consumeFailure();
  assert.deepEqual(failure, {
    schemaVersion: 1,
    version: "1.2.3",
    stage: "verify-archive",
    occurredAt: "2026-07-22T08:00:00.0000000Z",
  });
  assert.equal(await store.consumeFailure(), undefined);
  assert.match(describeUpdateInstallFailure(failure), /v1\.2\.3/);
  assert.doesNotMatch(describeUpdateInstallFailure(failure), /Users|secret|zip/i);
});

test("keeps a valid helper result until startup cleanup acknowledges it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-install-result-pending-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resultPath = updateInstallResultPath(directory);
  await fs.writeFile(resultPath, JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    stage: "cleanup",
    occurredAt: "2026-07-22T08:00:00.0000000Z",
  }), "utf8");

  const store = new UpdateInstallResultStore(resultPath);
  assert.equal((await store.readFailure())?.stage, "cleanup");
  await fs.access(resultPath);
  await store.clearFailure();
  await assert.rejects(fs.access(resultPath), /ENOENT/);
});

test("discards malformed or unsafe helper results", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-install-result-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resultPath = updateInstallResultPath(directory);
  await fs.writeFile(resultPath, JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    stage: "C:\\leak",
    occurredAt: "not-a-time",
  }), "utf8");

  assert.equal(await new UpdateInstallResultStore(resultPath).consumeFailure(), undefined);
  await assert.rejects(fs.access(resultPath), /ENOENT/);
});

test("removes only the validated version cache and verifies its absence", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-cache-cleanup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cacheDirectory = path.join(directory, "updates");
  const targetDirectory = path.join(cacheDirectory, "1.2.3");
  const siblingDirectory = path.join(cacheDirectory, "1.2.4");
  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.mkdir(siblingDirectory, { recursive: true });
  await fs.writeFile(path.join(targetDirectory, "Nami-Mail-1.2.3-win-x64.zip"), "fixture", "utf8");
  await fs.writeFile(path.join(siblingDirectory, "keep.txt"), "fixture", "utf8");

  assert.equal(await removeUpdateVersionCache(cacheDirectory, "1.2.3"), true);
  await assert.rejects(fs.access(targetDirectory), /ENOENT/);
  await fs.access(siblingDirectory);
  assert.equal(await removeUpdateVersionCache(cacheDirectory, "../1.2.4"), false);
  await fs.access(siblingDirectory);
});
