import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  assertStableReleaseVersion,
  assertWindowsSignatureMatchesExpectedIdentity,
  expectedStableReleaseTag,
  parseExpectedWindowsSigningIdentity,
  parseGitHubRepository,
  promoteGitHubDraftRelease,
  resolveReleaseDirectory,
  resolveWindowsReleaseAssets,
  uploadGitHubReleaseAssets,
  verifyGitHubDraftRelease,
  verifyPublicGitHubRepository,
} from "./release-policy.mjs";
import { resolveLocalWindowsElectronDist } from "./electron-dist.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("stable GitHub releases reject prerelease, build metadata, and malformed versions", () => {
  assert.equal(assertStableReleaseVersion("1.2.3"), "1.2.3");
  assert.equal(expectedStableReleaseTag("1.2.3"), "v1.2.3");
  for (const version of ["1.2.3-beta.1", "1.2.3-rc", "1.2.3+build.7", "v1.2.3", "1.2", "01.2.3"]) {
    assert.throws(() => assertStableReleaseVersion(version), /exact x\.y\.z semantic version/);
  }
});

test("release artifacts stay inside an explicitly isolated repository directory", () => {
  const root = path.join(os.tmpdir(), "nami-release-root");
  assert.equal(
    resolveReleaseDirectory(root, "release-artifacts/1.2.3"),
    path.join(root, "release-artifacts", "1.2.3"),
  );
  assert.equal(resolveReleaseDirectory(root), path.join(root, "release"));
  assert.throws(() => resolveReleaseDirectory(root, "."), /isolated directory/);
  assert.throws(() => resolveReleaseDirectory(root, "../outside"), /inside this repository/);
});

test("Windows packaging reuses a local Electron distribution only when its executable exists", async (t) => {
  const temporaryProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nami-electron-dist-"));
  t.after(() => fs.rm(temporaryProjectRoot, { recursive: true, force: true }));
  const electronDist = path.join(temporaryProjectRoot, "node_modules", "electron", "dist");

  assert.equal(await resolveLocalWindowsElectronDist(temporaryProjectRoot), undefined);
  await fs.mkdir(electronDist, { recursive: true });
  assert.equal(await resolveLocalWindowsElectronDist(temporaryProjectRoot), undefined);
  await fs.writeFile(path.join(electronDist, "electron.exe"), "Electron");
  assert.equal(await resolveLocalWindowsElectronDist(temporaryProjectRoot), electronDist);

  const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(
    packageManifest.build.electronDist,
    undefined,
    "The package manifest must not force CI runners to use a local Electron directory.",
  );
  const packageScript = await fs.readFile(path.join(projectRoot, "scripts", "package-win.mjs"), "utf8");
  assert.match(packageScript, /resolveLocalWindowsElectronDist\(projectRoot\)/);
  assert.match(packageScript, /--config\.electronDist=\$\{localElectronDist\}/);
});

test("release repository and signing identity inputs are strict", () => {
  assert.deepEqual(parseGitHubRepository("https://github.com/Nami/mail.git"), { owner: "Nami", repo: "mail" });
  assert.throws(() => parseGitHubRepository("https://example.com/Nami/mail"), /github\.com/);
  assert.deepEqual(parseExpectedWindowsSigningIdentity({
    NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER: "Nami Mail LLC",
    NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT: "aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa",
  }), {
    publisher: "Nami Mail LLC",
    thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.throws(() => parseExpectedWindowsSigningIdentity({}), /EXPECTED_WINDOWS_PUBLISHER/);
  assert.throws(() => parseExpectedWindowsSigningIdentity({
    NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER: "Nami Mail LLC",
    NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT: "1234",
  }), /40-character/);
  const expectedIdentity = {
    publisher: "Nami Mail LLC",
    thumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  assert.doesNotThrow(() => assertWindowsSignatureMatchesExpectedIdentity({
    SimpleName: "Nami Mail LLC",
    Subject: "CN=Nami Mail LLC",
    Thumbprint: expectedIdentity.thumbprint,
  }, expectedIdentity, "installer.exe"));
  assert.throws(() => assertWindowsSignatureMatchesExpectedIdentity({
    SimpleName: "Nami Mail LLC",
    Subject: "CN=Nami Mail LLC",
    Thumbprint: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  }, expectedIdentity, "installer.exe"), /thumbprint/);
  assert.throws(() => assertWindowsSignatureMatchesExpectedIdentity({
    SimpleName: "Other Publisher",
    Subject: "CN=Other Publisher",
    Thumbprint: expectedIdentity.thumbprint,
  }, expectedIdentity, "installer.exe"), /publisher/);
});

test("public repository verification fails closed for private repositories", async () => {
  const publicFetch = async () => jsonResponse({ full_name: "Nami/mail", private: false, visibility: "public" });
  await verifyPublicGitHubRepository({ owner: "Nami", repo: "mail", fetchImpl: publicFetch });
  const privateFetch = async () => jsonResponse({ full_name: "Nami/mail", private: true, visibility: "private" });
  await assert.rejects(
    verifyPublicGitHubRepository({ owner: "Nami", repo: "mail", fetchImpl: privateFetch }),
    /not public/,
  );
});

test("release assets are resolved using the exact names in latest.yml", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nami-release-policy-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const releaseDirectory = path.join(projectRoot, "release");
  await fs.mkdir(releaseDirectory);
  const installer = Buffer.from("signed-installer");
  const blockmap = Buffer.from("blockmap");
  const zipUpdate = Buffer.from("zip-update");
  const zipManifest = Buffer.from("{\"schemaVersion\":1}\n");
  await fs.writeFile(path.join(releaseDirectory, "Nami Mail Setup 1.2.3.exe"), installer);
  await fs.writeFile(path.join(releaseDirectory, "Nami Mail Setup 1.2.3.exe.blockmap"), blockmap);
  await fs.writeFile(path.join(releaseDirectory, "nami-mail-update-1.2.3-win-x64.zip"), zipUpdate);
  await fs.writeFile(path.join(releaseDirectory, "nami-mail-update-1.2.3-win-x64.json"), zipManifest);
  await fs.writeFile(path.join(releaseDirectory, "latest.yml"), [
    "version: 1.2.3",
    "files:",
    "  - url: nami-mail-setup-1.2.3.exe",
    "    sha512: ignored-by-this-policy-layer",
    "path: nami-mail-setup-1.2.3.exe",
    "sha512: ignored-by-this-policy-layer",
    "",
  ].join("\n"));
  const assets = await resolveWindowsReleaseAssets({ projectRoot, version: "1.2.3" });
  assert.deepEqual(assets.map((asset) => asset.name), [
    "nami-mail-setup-1.2.3.exe",
    "nami-mail-setup-1.2.3.exe.blockmap",
    "latest.yml",
    "nami-mail-update-1.2.3-win-x64.zip",
    "nami-mail-update-1.2.3-win-x64.json",
  ]);
  assert.equal(assets[0].sha256, sha256(installer));
  assert.equal(assets[1].sha256, sha256(blockmap));
});

function createDraftFixture({ draft = true, remoteOverrides = {} } = {}) {
  const contents = new Map([
    ["nami-mail-setup-1.2.3.exe", Buffer.from("installer")],
    ["nami-mail-setup-1.2.3.exe.blockmap", Buffer.from("blockmap")],
    ["latest.yml", Buffer.from("version: 1.2.3\n")],
    ["nami-mail-update-1.2.3-win-x64.zip", Buffer.from("zip-update")],
    ["nami-mail-update-1.2.3-win-x64.json", Buffer.from("{\"schemaVersion\":1}\n")],
  ]);
  const expectedAssets = [...contents].map(([name, bytes]) => ({
    name,
    size: bytes.length,
    sha256: sha256(bytes),
  }));
  const remoteAssets = expectedAssets.map((asset, index) => ({
    id: index + 1,
    name: asset.name,
    size: asset.size,
    url: `https://api.github.com/assets/${index + 1}`,
    ...remoteOverrides[asset.name],
  }));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/repos/Nami/mail")) {
      return jsonResponse({ full_name: "Nami/mail", private: false, visibility: "public" });
    }
    if (String(url).endsWith("/releases/tags/v1.2.3")) {
      return jsonResponse({ id: 42, tag_name: "v1.2.3", draft, prerelease: false, assets: remoteAssets });
    }
    const asset = remoteAssets.find((candidate) => candidate.url === String(url));
    if (asset) return new Response(contents.get(asset.name), { status: 200 });
    if (String(url).endsWith("/releases/42") && options.method === "PATCH") {
      return jsonResponse({ id: 42, tag_name: "v1.2.3", draft: false, prerelease: false });
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  return { expectedAssets, fetchImpl, requests, contents };
}

test("remote draft verification hashes every exact asset before promotion", async () => {
  const fixture = createDraftFixture();
  const draft = await verifyGitHubDraftRelease({
    owner: "Nami",
    repo: "mail",
    tag: "v1.2.3",
    token: "test-token",
    expectedAssets: fixture.expectedAssets,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(draft.id, 42);
  const promoted = await promoteGitHubDraftRelease({
    owner: "Nami",
    repo: "mail",
    releaseId: draft.id,
    tag: "v1.2.3",
    token: "test-token",
    releaseName: "Nami Mail 1.2.3",
    releaseNotes: "# Nami Mail 1.2.3\n\nUser-facing release notes.",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(promoted.draft, false);
  const patch = fixture.requests.find((request) => request.options.method === "PATCH");
  assert.deepEqual(JSON.parse(patch.options.body), {
    name: "Nami Mail 1.2.3",
    body: "# Nami Mail 1.2.3\n\nUser-facing release notes.",
    draft: false,
    prerelease: false,
    make_latest: "true",
  });
});

test("remote verification rejects a published release and altered bytes", async () => {
  const published = createDraftFixture({ draft: false });
  await assert.rejects(verifyGitHubDraftRelease({
    owner: "Nami",
    repo: "mail",
    tag: "v1.2.3",
    token: "test-token",
    expectedAssets: published.expectedAssets,
    fetchImpl: published.fetchImpl,
  }), /not a draft/);

  const altered = createDraftFixture();
  altered.contents.set("nami-mail-setup-1.2.3.exe", Buffer.from("tampered!"));
  await assert.rejects(verifyGitHubDraftRelease({
    owner: "Nami",
    repo: "mail",
    tag: "v1.2.3",
    token: "test-token",
    expectedAssets: altered.expectedAssets,
    fetchImpl: altered.fetchImpl,
  }), /SHA-256/);
});

test("uploads the generated ZIP update assets only to the verified draft release", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-release-upload-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const zipPath = path.join(directory, "nami-mail-update-1.2.3-win-x64.zip");
  const manifestPath = path.join(directory, "nami-mail-update-1.2.3-win-x64.json");
  await fs.writeFile(zipPath, Buffer.from("zip"));
  await fs.writeFile(manifestPath, Buffer.from("manifest"));
  const uploads = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/releases/tags/v1.2.3")) {
      return jsonResponse({
        id: 42,
        draft: true,
        prerelease: false,
        assets: [{ name: "Nami Mail Setup 1.2.3.exe" }],
        upload_url: "https://uploads.github.com/repos/Nami/mail/releases/42/assets{?name,label}",
      });
    }
    if (requestUrl.startsWith("https://uploads.github.com/")) {
      uploads.push({ requestUrl, options });
      const name = new URL(requestUrl).searchParams.get("name");
      return jsonResponse({ name, size: Number(options.headers["Content-Length"]) }, 201);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  await uploadGitHubReleaseAssets({
    owner: "Nami",
    repo: "mail",
    tag: "v1.2.3",
    token: "test-token",
    assets: [
      { name: path.basename(zipPath), filePath: zipPath, size: 3 },
      { name: path.basename(manifestPath), filePath: manifestPath, size: 8 },
    ],
    fetchImpl,
  });
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((upload) => upload.options.method === "POST"));
  assert.ok(uploads.every((upload) => upload.options.headers.Authorization === "Bearer test-token"));
});

test("reuses previously uploaded ZIP update assets only after byte-for-byte verification", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-release-upload-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const zipPath = path.join(directory, "nami-mail-update-1.2.3-win-x64.zip");
  const manifestPath = path.join(directory, "nami-mail-update-1.2.3-win-x64.json");
  const contents = new Map([
    [path.basename(zipPath), Buffer.from("zip")],
    [path.basename(manifestPath), Buffer.from("manifest")],
  ]);
  await fs.writeFile(zipPath, contents.get(path.basename(zipPath)));
  await fs.writeFile(manifestPath, contents.get(path.basename(manifestPath)));
  const remoteAssets = [...contents].map(([name, bytes], index) => ({
    id: index + 1,
    name,
    size: bytes.length,
    url: `https://api.github.com/assets/${index + 1}`,
  }));
  const uploads = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/releases/tags/v1.2.3")) {
      return jsonResponse({
        id: 42,
        draft: true,
        prerelease: false,
        assets: remoteAssets,
        upload_url: "https://uploads.github.com/repos/Nami/mail/releases/42/assets{?name,label}",
      });
    }
    const remote = remoteAssets.find((asset) => asset.url === requestUrl);
    if (remote) return new Response(contents.get(remote.name), { status: 200 });
    if (requestUrl.startsWith("https://uploads.github.com/")) {
      uploads.push({ requestUrl, options });
      return jsonResponse({ name: new URL(requestUrl).searchParams.get("name"), size: Number(options.headers["Content-Length"]) }, 201);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const assets = [
    { name: path.basename(zipPath), filePath: zipPath, size: 3 },
    { name: path.basename(manifestPath), filePath: manifestPath, size: 8 },
  ];
  await uploadGitHubReleaseAssets({ owner: "Nami", repo: "mail", tag: "v1.2.3", token: "test-token", assets, fetchImpl });
  assert.equal(uploads.length, 0, "Verified draft assets must be reused without a second upload.");

  contents.set(path.basename(zipPath), Buffer.from("not"));
  await assert.rejects(
    uploadGitHubReleaseAssets({ owner: "Nami", repo: "mail", tag: "v1.2.3", token: "test-token", assets, fetchImpl }),
    /existing nami-mail-update-1\.2\.3-win-x64\.zip (?:size|SHA-256) does not match/,
  );
});

test("release workflow isolates read-only validation from credential-minimized publishing", async () => {
  const workflow = yaml.load(await fs.readFile(path.join(projectRoot, ".github", "workflows", "release-windows.yml"), "utf8"));
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.validate.permissions.contents, "read");
  assert.equal(workflow.jobs.release.permissions.contents, "write");
  assert.equal(workflow.jobs.release.needs, "validate");
  assert.equal(workflow.jobs.release.environment, "release");
  assert.equal(workflow.concurrency.group, "release-${{ github.repository }}-${{ github.ref_name }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  for (const jobName of ["validate", "release"]) {
    const checkout = workflow.jobs[jobName].steps.find(
      (step) => step.uses === "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    assert.equal(checkout.with["persist-credentials"], false, `${jobName} checkout must not persist its token.`);
    assert.ok(
      workflow.jobs[jobName].steps.some(
        (step) => step.uses === "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      ),
      `${jobName} must pin setup-node to its reviewed implementation.`,
    );
  }
  const packageStep = workflow.jobs.release.steps.find((step) => step.run === "npm run publish:github");
  assert.ok(
    workflow.jobs.validate.steps.some((step) => step.run === "npm audit --omit=dev --audit-level=high"),
    "Validation must enforce the documented production dependency audit.",
  );
  const validateBuildIndex = workflow.jobs.validate.steps.findIndex((step) => step.run === "npm run build");
  const runtimeSmokeIndex = workflow.jobs.validate.steps.findIndex((step) => step.run === "npm run smoke:runtime");
  assert.ok(validateBuildIndex >= 0, "Validation must build the distributable runtime before smoke testing it.");
  assert.ok(runtimeSmokeIndex > validateBuildIndex, "Runtime smoke must execute against freshly built server and renderer artifacts.");
  assert.equal(packageStep.env.NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER, "${{ secrets.WINDOWS_CSC_PUBLISHER }}");
  assert.equal(packageStep.env.NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT, "${{ secrets.WINDOWS_CSC_THUMBPRINT }}");
  assert.equal(packageStep.env.NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY, "${{ secrets.NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY }}");
  assert.equal(workflow.jobs.release.env.NAMI_MAIL_RELEASE_DIRECTORY, "release-artifacts/${{ github.ref_name }}");
  assert.equal(packageStep.env.NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY, "${{ secrets.NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY }}");
  assert.equal(workflow.jobs.release.env.NAMI_MAIL_RELEASE_DIRECTORY, "release-artifacts/${{ github.ref_name }}");
  const packageIndex = workflow.jobs.release.steps.indexOf(packageStep);
  const promotionIndex = workflow.jobs.release.steps.findIndex((step) => step.run === "node scripts/promote-github-release.mjs");
  assert.ok(promotionIndex > packageIndex, "Remote verification and promotion must run only after package and installer smoke.");
});

test("pull request validation runs the release gate without write credentials", async () => {
  const workflow = yaml.load(await fs.readFile(path.join(projectRoot, ".github", "workflows", "validate.yml"), "utf8"));
  assert.equal(workflow.name, "Validate Pull Request");
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.ok("workflow_dispatch" in workflow.on, "Maintainers must be able to rerun validation without creating a PR.");
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.validate.permissions.contents, "read");
  assert.equal(workflow.jobs.validate["runs-on"], "windows-latest");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  const checkout = workflow.jobs.validate.steps.find(
    (step) => step.uses === "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  );
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(
    workflow.jobs.validate.steps.some(
      (step) => step.uses === "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ),
  );
  const commands = workflow.jobs.validate.steps.map((step) => step.run).filter(Boolean);
  assert.deepEqual(commands, [
    "npm ci",
    "node --test scripts/release-policy.test.mjs",
    "npm run typecheck",
    "npm run build",
    "npm run test",
    "npm --workspace @nami/web run test",
    "npm run test:desktop-security",
    "npm run smoke:runtime",
    "npm audit --omit=dev --audit-level=high",
  ]);
});
