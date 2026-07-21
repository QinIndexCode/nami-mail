import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalUpdateManifestPayload,
  createGitHubZipUpdateAssets,
  githubZipUpdateAssetNames,
  readEd25519SigningKey,
  writeEd25519UpdateTrust,
} from "./github-update-assets.mjs";

test("derives an embedded public trust record without writing the release private key", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signingKey = readEd25519SigningKey({
    NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  assert.ok(signingKey);
  assert.equal(signingKey.publicKeyBase64, publicKey.export({ format: "der", type: "spki" }).toString("base64"));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-update-trust-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const trustPath = path.join(directory, "nami-update-trust.json");
  await writeEd25519UpdateTrust(trustPath, signingKey);
  const trustContents = await fs.readFile(trustPath, "utf8");
  assert.match(trustContents, /"algorithm": "ed25519"/);
  assert.equal(trustContents.includes(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")), false);
});

test("uses a fixed release asset rule and canonical signature payload", () => {
  assert.deepEqual(githubZipUpdateAssetNames("1.2.3"), {
    archiveName: "nami-mail-update-1.2.3-win-x64.zip",
    manifestName: "nami-mail-update-1.2.3-win-x64.json",
    installerName: "Nami Mail Setup 1.2.3.exe",
  });
  assert.equal(canonicalUpdateManifestPayload({
    version: "1.2.3",
    archiveName: "nami-mail-update-1.2.3-win-x64.zip",
    archiveSize: 42,
    archiveSha512: "abc",
    installerName: "Nami Mail Setup 1.2.3.exe",
  }).toString("utf8"), [
    "nami-mail-update-manifest-v1",
    "1.2.3",
    "nami-mail-update-1.2.3-win-x64.zip",
    "42",
    "abc",
    "Nami Mail Setup 1.2.3.exe",
    "",
  ].join("\n"));
});

test("requires the package workflow to pass one resolved release directory", async () => {
  await assert.rejects(
    createGitHubZipUpdateAssets({ projectRoot: process.cwd(), version: "1.2.3" }),
    /requires the resolved release directory/,
  );
});
