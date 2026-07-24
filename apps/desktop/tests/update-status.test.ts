import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesktopUpdateSnapshot } from "../src/preload.cts";
import { classifyUpdateError, createUpdateSnapshot } from "../src/update-status.mts";

test("classifies updater failures without exposing user-facing text", () => {
  const error = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
  assert.equal(classifyUpdateError(error), "network");
});

test("keeps TLS, signature, integrity, release, rate-limit, and unknown failures distinct", () => {
  assert.equal(classifyUpdateError(new Error("CERT_HAS_EXPIRED")), "tls");
  assert.equal(classifyUpdateError(new Error("New version is not signed by the application owner")), "signatureInvalid");
  assert.equal(classifyUpdateError(new Error("SHA512 checksum mismatch")), "integrityInvalid");
  assert.equal(classifyUpdateError(new Error("404 latest.yml not found")), "releaseUnavailable");
  assert.equal(classifyUpdateError(new Error("GitHub API rate limit 403")), "rateLimited");
  assert.equal(classifyUpdateError(new Error("unexpected updater state")), "unknown");
});

test("creates a stable renderer-safe update snapshot", () => {
  assert.deepEqual(createUpdateSnapshot("0.1.0", "checking", "checking"), {
    schemaVersion: 2,
    phase: "checking",
    currentVersion: "0.1.0",
    targetVersion: null,
    percent: null,
    checkedAt: null,
    suppression: "none",
    remindAt: null,
    reason: "checking",
    args: {},
  });
});

test("preload accepts only the structured v2 update snapshot contract", () => {
  const snapshot = {
    schemaVersion: 2,
    phase: "available",
    currentVersion: "0.1.0",
    targetVersion: "0.1.1",
    percent: null,
    checkedAt: "2026-07-23T08:00:00.000Z",
    suppression: "none",
    remindAt: null,
    reason: "releaseAvailable",
    args: {},
  } as const;

  assert.deepEqual(normalizeDesktopUpdateSnapshot(snapshot), snapshot);
  assert.deepEqual(
    normalizeDesktopUpdateSnapshot({ ...snapshot, reason: "installResult", args: { installStage: "cleanup", cleanupComplete: true } }),
    { ...snapshot, reason: "installResult", args: { installStage: "cleanup", cleanupComplete: true } },
  );

  for (const malformed of [
    { ...snapshot, schemaVersion: 1 },
    { ...snapshot, phase: "queued" },
    { ...snapshot, reason: "translatorProvidedText" },
    { ...snapshot, args: { installStage: "delete" } },
    { ...snapshot, args: { cleanupComplete: "true" } },
    { ...snapshot, percent: 101 },
    { ...snapshot, message: "legacy renderer text" },
  ]) {
    assert.equal(normalizeDesktopUpdateSnapshot(malformed), undefined);
  }
});
