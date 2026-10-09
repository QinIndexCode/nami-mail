import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { WriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareStableVersions,
  discoverGitHubZipUpdate,
  downloadGitHubZipUpdate,
  GitHubZipUpdateError,
  githubReleaseAssetUrl,
  githubZipUpdateAssetNames,
  hasVerifiedCachedUpdate,
  parseGitHubUpdateSource,
} from "../src/github-zip-update.mts";
import { canonicalUpdateManifestPayload, parseEd25519UpdateTrust, verifyEd25519UpdateManifest } from "../src/update-trust.mts";

const source = { owner: "NamiMail", repo: "nami-mail" };
const version = "1.2.3";
const archiveBytes = Buffer.from("a signed ZIP fixture is represented by deterministic bytes");
const assetNames = githubZipUpdateAssetNames(version);
const manifest = JSON.stringify({
  schemaVersion: 1,
  version,
  archive: {
    name: assetNames.archiveName,
    size: archiveBytes.byteLength,
    sha512: createHash("sha512").update(archiveBytes).digest("base64"),
  },
  installer: assetNames.installerName,
});

function releaseResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: assetNames.archiveName, size: archiveBytes.byteLength },
      { name: assetNames.manifestName, size: Buffer.byteLength(manifest, "utf8") },
    ],
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("accepts only an explicit electron-builder GitHub source", () => {
  assert.deepEqual(parseGitHubUpdateSource([
    "provider: github",
    "owner: NamiMail",
    "repo: nami-mail",
    "publisherName:",
    "  - Nami Mail",
  ].join("\n")), source);
  assert.equal(parseGitHubUpdateSource("provider: generic\nurl: https://example.test"), undefined);
  assert.equal(parseGitHubUpdateSource("provider: github\nowner: bad/owner\nrepo: nami-mail"), undefined);
});

test("uses versioned, deterministic ZIP update asset names", () => {
  assert.deepEqual(githubZipUpdateAssetNames("1.2.3"), {
    archiveName: "nami-mail-update-1.2.3-win-x64.zip",
    manifestName: "nami-mail-update-1.2.3-win-x64.json",
    installerName: "Nami Mail Setup 1.2.3.exe",
  });
  assert.equal(compareStableVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareStableVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareStableVersions("1.2.3", "2.0.0"), -1);
});

test("discovers only a published newer release with both required assets and a matching manifest", async () => {
  const requests: string[] = [];
  const update = await discoverGitHubZipUpdate({
    source,
    currentVersion: "1.2.2",
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("https://api.github.com/")) return releaseResponse();
      if (url === githubReleaseAssetUrl(source, "v1.2.3", assetNames.manifestName)) return new Response(manifest, { status: 200 });
      return new Response("missing", { status: 404 });
    },
  });
  assert.deepEqual(update && {
    version: update.version,
    archiveName: update.archiveName,
    archiveSize: update.archiveSize,
    installerName: update.installerName,
  }, {
    version: "1.2.3",
    archiveName: assetNames.archiveName,
    archiveSize: archiveBytes.byteLength,
    installerName: assetNames.installerName,
  });
  assert.deepEqual(requests, [
    "https://api.github.com/repos/NamiMail/nami-mail/releases/latest",
    githubReleaseAssetUrl(source, "v1.2.3", assetNames.manifestName),
  ]);
});

test("rejects malformed or incomplete update release metadata", async () => {
  await assert.rejects(
    discoverGitHubZipUpdate({
      source,
      currentVersion: "1.2.2",
      fetchImpl: async () => releaseResponse({ assets: [{ name: assetNames.archiveName, size: archiveBytes.byteLength }] }),
    }),
    /missing the required Nami Mail ZIP update assets/,
  );
  await assert.rejects(
    discoverGitHubZipUpdate({
      source,
      currentVersion: "1.2.2",
      fetchImpl: async (input) => {
        if (String(input).startsWith("https://api.github.com/")) return releaseResponse();
        const parsed = JSON.parse(manifest) as { archive: { sha512: string } };
        return new Response(JSON.stringify({ ...parsed, archive: { ...parsed.archive, sha512: "wrong" } }), { status: 200 });
      },
    }),
    /valid SHA-512 digest/,
  );
});

test("requires a valid Ed25519 signature when the installed app uses the unsigned release trust path", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trust = parseEd25519UpdateTrust({
    schemaVersion: 1,
    algorithm: "ed25519",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
  assert.ok(trust);
  const unsigned = JSON.parse(manifest) as {
    version: string;
    archive: { name: string; size: number; sha512: string };
    installer: string;
  };
  const signedManifest = JSON.stringify({
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      value: sign(null, canonicalUpdateManifestPayload({
        version: unsigned.version,
        archiveName: unsigned.archive.name,
        archiveSize: unsigned.archive.size,
        archiveSha512: unsigned.archive.sha512,
        installerName: unsigned.installer,
      }), privateKey).toString("base64"),
    },
  });
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          { name: assetNames.archiveName, size: archiveBytes.byteLength },
          { name: assetNames.manifestName, size: Buffer.byteLength(signedManifest, "utf8") },
        ],
      }), { status: 200 });
    }
    return new Response(signedManifest, { status: 200 });
  };
  const discovered = await discoverGitHubZipUpdate({
    source,
    currentVersion: "1.2.2",
    fetchImpl,
    verifyManifestSignature: (input) => verifyEd25519UpdateManifest(trust, input),
  });
  assert.equal(discovered?.archiveSha512, unsigned.archive.sha512);
  await assert.rejects(
    discoverGitHubZipUpdate({
      source,
      currentVersion: "1.2.2",
      fetchImpl,
      verifyManifestSignature: (input) => verifyEd25519UpdateManifest(trust, {
        ...input,
        archiveSha512: Buffer.alloc(64, 3).toString("base64"),
      }),
    }),
    /not signed by this Nami Mail release channel/,
  );
});

test("downloads, reports, verifies, and reuses the ZIP update archive", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-github-update-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const update = await discoverGitHubZipUpdate({
    source,
    currentVersion: "1.2.2",
    fetchImpl: async (input) => String(input).startsWith("https://api.github.com/")
      ? releaseResponse()
      : String(input).endsWith(".json")
        ? new Response(manifest, { status: 200 })
        : new Response(archiveBytes, { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } }),
  });
  assert.ok(update);
  const progress: number[] = [];
  const archivePath = await downloadGitHubZipUpdate({
    cacheDirectory: directory,
    update,
    onProgress: ({ percent }) => progress.push(percent),
    fetchImpl: async () => new Response(archiveBytes, { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } }),
  });
  assert.deepEqual(await fs.readFile(archivePath), archiveBytes);
  assert.equal(await hasVerifiedCachedUpdate(directory, update), true);
  assert.equal(progress.at(-1), 100);

  let extraDownloadCalls = 0;
  const reused = await downloadGitHubZipUpdate({
    cacheDirectory: directory,
    update,
    fetchImpl: async () => {
      extraDownloadCalls += 1;
      return new Response("unexpected", { status: 500 });
    },
  });
  assert.equal(reused, archivePath);
  assert.equal(extraDownloadCalls, 0);
});

test("deletes a partial ZIP when the published digest does not match", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-github-update-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const update = await discoverGitHubZipUpdate({
    source,
    currentVersion: "1.2.2",
    fetchImpl: async (input) => String(input).startsWith("https://api.github.com/")
      ? releaseResponse()
      : new Response(manifest, { status: 200 }),
  });
  assert.ok(update);
  await assert.rejects(
    downloadGitHubZipUpdate({
      cacheDirectory: directory,
      update,
      fetchImpl: async () => new Response(Buffer.from("wrong bytes"), { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } }),
    }),
    /integrity check/,
  );
  const archiveDirectory = path.join(directory, version);
  assert.equal(await fs.readdir(archiveDirectory).then((entries) => entries.some((entry) => entry.endsWith(".part"))), false);
});

test("rejects an update manifest body that exceeds the size cap", async () => {
  const oversizedManifest = JSON.stringify({
    schemaVersion: 1,
    version,
    archive: {
      name: assetNames.archiveName,
      size: archiveBytes.byteLength,
      sha512: createHash("sha512").update(archiveBytes).digest("base64"),
    },
    installer: assetNames.installerName,
    padding: "x".repeat(16 * 1024),
  });
  await assert.rejects(
    discoverGitHubZipUpdate({
      source,
      currentVersion: "1.2.2",
      fetchImpl: async (input) => String(input).startsWith("https://api.github.com/")
        ? releaseResponse()
        : new Response(oversizedManifest, { status: 200 }),
    }),
    (error: unknown) => error instanceof GitHubZipUpdateError && error.code === "UPDATE_MANIFEST_TOO_LARGE",
  );
});

test("keeps per-drain error listeners bounded under sustained backpressure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-github-update-backpressure-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x4e);
  const update = {
    source,
    version,
    tag: `v${version}`,
    archiveName: assetNames.archiveName,
    archiveUrl: "https://example.invalid/fixture.zip",
    archiveSize: bytes.byteLength,
    archiveSha512: createHash("sha512").update(bytes).digest("base64"),
    installerName: assetNames.installerName,
  };
  const warnings: Error[] = [];
  let peakErrorListeners = 0;
  const originalEmit = WriteStream.prototype.emit;
  t.mock.method(WriteStream.prototype, "emit", function (this: WriteStream, ...args: Parameters<WriteStream["emit"]>) {
    if (args[0] === "drain") peakErrorListeners = Math.max(peakErrorListeners, this.listenerCount("error"));
    return originalEmit.apply(this, args);
  });
  const capture = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  process.on("warning", capture);
  t.after(() => process.removeListener("warning", capture));
  let position = 0;
  await downloadGitHubZipUpdate({
    cacheDirectory: directory,
    update,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        if (position >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(position + 128 * 1024, bytes.byteLength);
        controller.enqueue(bytes.subarray(position, end));
        position = end;
      },
    }), { headers: { "content-length": String(bytes.byteLength) } }),
  });
  assert.equal(await hasVerifiedCachedUpdate(directory, update), true);
  assert.ok(peakErrorListeners <= 4, "Error listeners must stay bounded rather than increasing on every drain.");
  assert.equal(warnings.length, 0, "Every drain must detach its paired error handler.");
});

test("rejects the download and clears the temporary file when a backpressured write fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-github-update-write-fail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(1024 * 1024, 0x4e);
  const update = {
    source,
    version,
    tag: `v${version}`,
    archiveName: assetNames.archiveName,
    archiveUrl: "https://example.invalid/fixture.zip",
    archiveSize: bytes.byteLength,
    archiveSha512: createHash("sha512").update(bytes).digest("base64"),
    installerName: assetNames.installerName,
  };
  const originalWrite = WriteStream.prototype.write;
  let writes = 0;
  t.mock.method(WriteStream.prototype, "write", function (this: WriteStream, ...args: Parameters<WriteStream["write"]>) {
    writes += 1;
    if (writes === 2) {
      // A disk failure surfaces as a stream error after backpressure: the
      // waiting chunk must reject, the stream is destroyed, and the caller
      // still removes the partial file.
      process.nextTick(() => this.destroy(Object.assign(new Error("simulated disk failure"), { code: "EIO" })));
      return false;
    }
    return originalWrite.apply(this, args);
  });
  let position = 0;
  await assert.rejects(
    downloadGitHubZipUpdate({
      cacheDirectory: directory,
      update,
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          if (position >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(position + 128 * 1024, bytes.byteLength);
          controller.enqueue(bytes.subarray(position, end));
          position = end;
        },
      }), { headers: { "content-length": String(bytes.byteLength) } }),
    }),
    /simulated disk failure/,
  );
  assert.ok(writes >= 2);
  const archiveDirectory = path.join(directory, version);
  assert.equal(await fs.readdir(archiveDirectory).then((entries) => entries.some((entry) => entry.endsWith(".part"))), false);
});

test("rejects an oversized GitHub release metadata body", async () => {
  const oversizedRelease = new Response(JSON.stringify({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: assetNames.archiveName, size: archiveBytes.byteLength },
      { name: assetNames.manifestName, size: Buffer.byteLength(manifest, "utf8") },
      ...Array.from({ length: 3_000 }, (_, index) => ({ name: `padding-${index}`, size: 1 })),
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    discoverGitHubZipUpdate({
      source,
      currentVersion: "1.2.2",
      fetchImpl: async () => oversizedRelease,
    }),
    (error: unknown) => error instanceof GitHubZipUpdateError && error.code === "GITHUB_RELEASE_INVALID",
  );
});
