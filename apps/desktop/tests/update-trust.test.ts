import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  canonicalUpdateManifestPayload,
  parseEd25519UpdateTrust,
  verifyEd25519UpdateManifest,
} from "../src/update-trust.mts";

test("verifies an Ed25519 manifest signature bound to every release identity field", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trust = parseEd25519UpdateTrust({
    schemaVersion: 1,
    algorithm: "ed25519",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
  assert.ok(trust);
  const unsigned = {
    version: "1.2.3",
    archiveName: "nami-mail-update-1.2.3-win-x64.zip",
    archiveSize: 123_456,
    archiveSha512: Buffer.alloc(64, 7).toString("base64"),
    installerName: "Nami Mail Setup 1.2.3.exe",
  };
  const signature = sign(null, canonicalUpdateManifestPayload(unsigned), privateKey).toString("base64");
  assert.equal(verifyEd25519UpdateManifest(trust, {
    ...unsigned,
    signature: { algorithm: "ed25519", value: signature },
  }), true);
  assert.equal(verifyEd25519UpdateManifest(trust, {
    ...unsigned,
    archiveName: "nami-mail-update-1.2.4-win-x64.zip",
    signature: { algorithm: "ed25519", value: signature },
  }), false);
});

test("rejects malformed or non-Ed25519 embedded release keys", () => {
  assert.equal(parseEd25519UpdateTrust({ schemaVersion: 1, algorithm: "ed25519", publicKey: "not-base64" }), undefined);
  assert.equal(parseEd25519UpdateTrust({ schemaVersion: 1, algorithm: "disabled" }), undefined);
});
