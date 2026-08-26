import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  beginTrustInjection,
  healTrustInjection,
  resolveTrustPaths,
  restoreTrustInjection,
} from "./package-win-trust.mjs";

const ORIGINAL = '{\n  "schemaVersion": 1,\n  "algorithm": "disabled"\n}\n';
const INJECTED = '{\n  "schemaVersion": 1,\n  "algorithm": "ed25519",\n  "publicKey": "injected"\n}\n';

async function withTrustDirectory(run) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nami-package-trust-"));
  try {
    await run(projectRoot);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

test("resolveTrustPaths places the sidecar next to the trust config", () => {
  const { trustConfigPath, sidecarPath } = resolveTrustPaths("C:\\repo");
  assert.equal(trustConfigPath, path.join("C:\\repo", "build", "nami-update-trust.json"));
  assert.equal(sidecarPath, `${trustConfigPath}.package-win-original`);
});

test("heal restores a killed injection and removes the sidecar", () =>
  withTrustDirectory(async (projectRoot) => {
    const paths = resolveTrustPaths(projectRoot);
    await fs.mkdir(path.dirname(paths.trustConfigPath), { recursive: true });
    await fs.writeFile(paths.sidecarPath, ORIGINAL, "utf8");
    await fs.writeFile(paths.trustConfigPath, INJECTED, "utf8");

    assert.equal(await healTrustInjection(paths), true);
    assert.equal(await fs.readFile(paths.trustConfigPath, "utf8"), ORIGINAL);
    await assert.rejects(fs.stat(paths.sidecarPath), { code: "ENOENT" });
  }));

test("heal removes the trust file when it did not exist before injection", () =>
  withTrustDirectory(async (projectRoot) => {
    const paths = resolveTrustPaths(projectRoot);
    await fs.mkdir(path.dirname(paths.trustConfigPath), { recursive: true });
    await fs.writeFile(paths.sidecarPath, "", "utf8");
    await fs.writeFile(paths.trustConfigPath, INJECTED, "utf8");

    assert.equal(await healTrustInjection(paths), true);
    await assert.rejects(fs.stat(paths.trustConfigPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(paths.sidecarPath), { code: "ENOENT" });
  }));

test("heal without a sidecar is a no-op", () =>
  withTrustDirectory(async (projectRoot) => {
    const paths = resolveTrustPaths(projectRoot);
    assert.equal(await healTrustInjection(paths), false);
    await assert.rejects(fs.stat(paths.sidecarPath), { code: "ENOENT" });
  }));

test("begin + restore round-trips without leaving the sidecar", () =>
  withTrustDirectory(async (projectRoot) => {
    const paths = resolveTrustPaths(projectRoot);
    await fs.mkdir(path.dirname(paths.trustConfigPath), { recursive: true });
    await fs.writeFile(paths.trustConfigPath, ORIGINAL, "utf8");

    await beginTrustInjection({ ...paths, originalTrustConfig: ORIGINAL });
    await fs.writeFile(paths.trustConfigPath, INJECTED, "utf8");
    await restoreTrustInjection(paths);

    assert.equal(await fs.readFile(paths.trustConfigPath, "utf8"), ORIGINAL);
    await assert.rejects(fs.stat(paths.sidecarPath), { code: "ENOENT" });
  }));

test("restore is idempotent when there is nothing to heal", () =>
  withTrustDirectory(async (projectRoot) => {
    const paths = resolveTrustPaths(projectRoot);
    await restoreTrustInjection(paths);
    await restoreTrustInjection(paths);
    await assert.rejects(fs.stat(paths.sidecarPath), { code: "ENOENT" });
  }));
