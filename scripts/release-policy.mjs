import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { githubZipUpdateAssetNames } from "./github-update-assets.mjs";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const certificateThumbprintPattern = /^[A-F0-9]{40}$/;

export function resolveReleaseDirectory(projectRoot, configuredDirectory = process.env.NAMI_MAIL_RELEASE_DIRECTORY) {
  const raw = configuredDirectory?.trim();
  if (!raw) return path.join(projectRoot, "release");
  const resolved = path.resolve(projectRoot, raw);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("NAMI_MAIL_RELEASE_DIRECTORY must be an isolated directory inside this repository.");
  }
  return resolved;
}

export function parseGitHubRepository(value) {
  const raw = value?.trim();
  if (!raw) throw new Error("NAMI_MAIL_GITHUB_REPOSITORY must identify a public GitHub repository.");
  let repository = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
      throw new Error("NAMI_MAIL_GITHUB_REPOSITORY URL must use https://github.com/owner/repo.");
    }
    repository = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  }
  const parts = repository.split("/");
  if (parts.length !== 2
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0] ?? "")
    || !/^[A-Za-z0-9_.-]+$/.test(parts[1] ?? "")) {
    throw new Error("NAMI_MAIL_GITHUB_REPOSITORY must identify exactly one GitHub owner/repository.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function assertStableReleaseVersion(value) {
  const version = value?.trim();
  if (!version || !stableVersionPattern.test(version)) {
    throw new Error(`GitHub stable releases require an exact x.y.z semantic version without prerelease or build metadata; received ${JSON.stringify(value)}.`);
  }
  return version;
}

export function expectedStableReleaseTag(version) {
  return `v${assertStableReleaseVersion(version)}`;
}

export function parseExpectedWindowsSigningIdentity(environment = process.env) {
  const publisher = environment.NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER?.trim();
  const thumbprint = environment.NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT
    ?.replaceAll(/\s/g, "")
    .toUpperCase();
  if (!publisher || /[\r\n]/.test(publisher)) {
    throw new Error("NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER must pin the expected Authenticode publisher.");
  }
  if (!thumbprint || !certificateThumbprintPattern.test(thumbprint)) {
    throw new Error("NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT must be the expected 40-character SHA-1 certificate thumbprint.");
  }
  return { publisher, thumbprint };
}

export function assertWindowsSignatureMatchesExpectedIdentity(signature, expectedIdentity, label) {
  assert.equal(
    signature?.Thumbprint?.replaceAll(/\s/g, "").toUpperCase(),
    expectedIdentity.thumbprint,
    `${label} signer thumbprint must match the independently configured certificate.`,
  );
  assert.ok(
    expectedIdentity.publisher === signature?.SimpleName || expectedIdentity.publisher === signature?.Subject,
    `${label} signer must match the independently configured Windows publisher.`,
  );
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "Nami-Mail-release-verifier",
    "X-GitHub-Api-Version": githubApiVersion,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function responseError(response, label) {
  const requestId = response.headers.get("x-github-request-id");
  let detail = "";
  try {
    const body = await response.text();
    if (body) detail = ` ${body.slice(0, 500)}`;
  } catch {
    // Preserve the status even when GitHub closes the response body early.
  }
  return new Error(`${label} failed with GitHub HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}.${detail}`);
}

async function githubJson(pathname, options = {}) {
  const {
    token,
    fetchImpl = globalThis.fetch,
    method = "GET",
    body,
    label = pathname,
  } = options;
  if (typeof fetchImpl !== "function") throw new Error("A Fetch implementation is required for GitHub release verification.");
  const response = await fetchImpl(`${githubApiBaseUrl}${pathname}`, {
    method,
    headers: {
      ...githubHeaders(token),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    redirect: "follow",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await responseError(response, label);
  return response.json();
}

function githubReleasesPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
}

async function listGitHubReleases({ owner, repo, token, fetchImpl }) {
  const releases = await githubJson(`${githubReleasesPath(owner, repo)}?per_page=100`, {
    token,
    fetchImpl,
    label: `GitHub Releases for ${owner}/${repo}`,
  });
  if (!Array.isArray(releases)) throw new Error(`GitHub Releases for ${owner}/${repo} returned an invalid list.`);
  return releases;
}

function releasesWithTag(releases, tag) {
  return releases.filter((release) => release && release.tag_name === tag);
}

function assertGitHubDraftRelease(release, tag, { requireUploadTarget = false } = {}) {
  if (!Number.isInteger(release?.id) || release.id <= 0) throw new Error(`GitHub Release ${tag} has no valid release id.`);
  if (release.tag_name !== tag) throw new Error(`GitHub Release tag ${release.tag_name ?? "<missing>"} does not match ${tag}.`);
  if (release.draft !== true) throw new Error(`GitHub Release ${tag} is not a draft; refusing to overwrite or re-promote it.`);
  if (release.prerelease !== false) throw new Error(`GitHub Release ${tag} is marked as a prerelease; refusing stable promotion.`);
  if (!Array.isArray(release.assets)) throw new Error(`GitHub draft Release ${tag} returned no asset list.`);
  if (requireUploadTarget && typeof release.upload_url !== "string") {
    throw new Error(`GitHub draft Release ${tag} has no valid upload target.`);
  }
  return release;
}

async function findUniqueGitHubDraftRelease({ owner, repo, tag, token, fetchImpl }) {
  const matches = releasesWithTag(await listGitHubReleases({ owner, repo, token, fetchImpl }), tag);
  if (matches.length !== 1) {
    throw new Error(`GitHub draft Release ${tag} must have exactly one matching Release; found ${matches.length}.`);
  }
  return assertGitHubDraftRelease(matches[0], tag, { requireUploadTarget: true });
}

export async function createGitHubDraftRelease({ owner, repo, tag, token, fetchImpl = globalThis.fetch }) {
  if (!token?.trim()) throw new Error("GH_TOKEN is required to create a GitHub Release draft.");
  const existing = releasesWithTag(await listGitHubReleases({ owner, repo, token, fetchImpl }), tag);
  if (existing.length > 0) {
    throw new Error(`Refusing to create GitHub draft Release ${tag}: found ${existing.length} existing matching Release(s).`);
  }
  const created = await githubJson(githubReleasesPath(owner, repo), {
    token,
    fetchImpl,
    method: "POST",
    body: {
      tag_name: tag,
      draft: true,
      prerelease: false,
      generate_release_notes: false,
    },
    label: `GitHub draft Release creation ${tag}`,
  });
  return assertGitHubDraftRelease(created, tag, { requireUploadTarget: true });
}

export async function verifyPublicGitHubRepository({ owner, repo, token, fetchImpl = globalThis.fetch }) {
  const metadata = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    fetchImpl,
    label: `GitHub repository ${owner}/${repo}`,
  });
  const expectedFullName = `${owner}/${repo}`.toLowerCase();
  if (typeof metadata.full_name !== "string" || metadata.full_name.toLowerCase() !== expectedFullName) {
    throw new Error(`GitHub returned an unexpected repository identity for ${owner}/${repo}.`);
  }
  if (metadata.private !== false || metadata.visibility !== "public") {
    throw new Error(`GitHub repository ${owner}/${repo} is not public; token-free desktop updates would fail.`);
  }
  return metadata;
}

function yamlRecord(contents, label) {
  const parsed = yaml.load(contents);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${label} must contain a YAML object.`);
  return parsed;
}

function releaseAssetName(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string.`);
  const trimmed = value.trim();
  assert.ok(trimmed, `${label} must not be empty.`);
  assert.equal(trimmed.includes("?"), false, `${label} must not include a query string.`);
  assert.equal(trimmed.includes("#"), false, `${label} must not include a fragment.`);
  const normalized = trimmed.replaceAll("\\", "/");
  assert.equal(path.posix.basename(normalized), normalized, `${label} must be a single release asset name.`);
  const decoded = decodeURIComponent(normalized);
  assert.equal(path.posix.basename(decoded), decoded, `${label} must not encode a path separator.`);
  assert.equal(/[\0\r\n]/.test(decoded), false, `${label} contains an invalid control character.`);
  return decoded;
}

export async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

export async function resolveWindowsReleaseAssets({ projectRoot, version, releaseDirectory: configuredReleaseDirectory }) {
  const stableVersion = assertStableReleaseVersion(version);
  const releaseDirectory = configuredReleaseDirectory
    ? resolveReleaseDirectory(projectRoot, configuredReleaseDirectory)
    : resolveReleaseDirectory(projectRoot);
  const installerPath = path.join(releaseDirectory, `Nami Mail Setup ${stableVersion}.exe`);
  const blockmapPath = `${installerPath}.blockmap`;
  const latestPath = path.join(releaseDirectory, "latest.yml");
  const { archiveName, manifestName } = githubZipUpdateAssetNames(stableVersion);
  const archivePath = path.join(releaseDirectory, archiveName);
  const manifestPath = path.join(releaseDirectory, manifestName);
  const latest = yamlRecord(await fs.readFile(latestPath, "utf8"), "latest.yml");
  assert.equal(latest.version, stableVersion, "latest.yml version must match the stable package version.");
  assert.ok(Array.isArray(latest.files), "latest.yml files must be an array.");
  const installerEntry = latest.files.find((entry) => entry
    && typeof entry === "object"
    && typeof entry.url === "string"
    && entry.url.toLowerCase().endsWith(".exe"));
  assert.ok(installerEntry, "latest.yml must identify the remote NSIS installer asset.");
  const installerAssetName = releaseAssetName(installerEntry.url, "latest.yml installer URL");
  assert.equal(releaseAssetName(latest.path, "latest.yml path"), installerAssetName, "latest.yml path must match its installer entry.");

  const descriptors = [
    { name: installerAssetName, filePath: installerPath },
    { name: `${installerAssetName}.blockmap`, filePath: blockmapPath },
    { name: "latest.yml", filePath: latestPath },
    { name: archiveName, filePath: archivePath },
    { name: manifestName, filePath: manifestPath },
  ];
  assert.equal(new Set(descriptors.map((entry) => entry.name)).size, descriptors.length, "Release asset names must be unique.");
  return Promise.all(descriptors.map(async (entry) => {
    const stat = await fs.stat(entry.filePath);
    assert.ok(stat.isFile() && stat.size > 0, `${entry.filePath} must be a non-empty file.`);
    return {
      ...entry,
      size: stat.size,
      sha256: await sha256File(entry.filePath),
    };
  }));
}

async function digestRemoteAsset(asset, { token, fetchImpl }) {
  const response = await fetchImpl(asset.url, {
    headers: githubHeaders(token, "application/octet-stream"),
    redirect: "follow",
  });
  if (!response.ok) throw await responseError(response, `GitHub release asset ${asset.name}`);
  if (!response.body) throw new Error(`GitHub release asset ${asset.name} returned no response body.`);
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    digest.update(chunk);
  }
  return { size, sha256: digest.digest("hex") };
}

export async function verifyGitHubDraftRelease({
  owner,
  repo,
  tag,
  token,
  expectedAssets,
  fetchImpl = globalThis.fetch,
}) {
  if (!token?.trim()) throw new Error("GH_TOKEN is required to verify a draft GitHub Release.");
  await verifyPublicGitHubRepository({ owner, repo, token, fetchImpl });
  const release = await findUniqueGitHubDraftRelease({ owner, repo, tag, token, fetchImpl });

  const expectedNames = expectedAssets.map((asset) => asset.name).sort();
  const remoteNames = release.assets.map((asset) => asset?.name).sort();
  assert.deepEqual(remoteNames, expectedNames, `GitHub draft ${tag} must contain exactly the verified update assets.`);

  for (const expected of expectedAssets) {
    const remote = release.assets.find((asset) => asset.name === expected.name);
    assert.ok(remote && Number.isInteger(remote.id) && typeof remote.url === "string", `GitHub draft is missing a valid ${expected.name} asset.`);
    assert.equal(remote.size, expected.size, `GitHub asset ${expected.name} size does not match the local artifact.`);
    const downloaded = await digestRemoteAsset(remote, { token, fetchImpl });
    assert.equal(downloaded.size, expected.size, `Downloaded GitHub asset ${expected.name} size does not match the local artifact.`);
    assert.equal(downloaded.sha256, expected.sha256, `GitHub asset ${expected.name} SHA-256 does not match the local artifact.`);
  }
  return release;
}

export async function uploadGitHubReleaseAssets({
  owner,
  repo,
  tag,
  token,
  assets,
  release: suppliedRelease,
  fetchImpl = globalThis.fetch,
}) {
  if (!token?.trim()) throw new Error("GH_TOKEN is required to upload GitHub Release assets.");
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("At least one GitHub Release asset must be uploaded.");
  const release = suppliedRelease
    ? assertGitHubDraftRelease(suppliedRelease, tag, { requireUploadTarget: true })
    : await findUniqueGitHubDraftRelease({ owner, repo, tag, token, fetchImpl });
  const remoteAssetsByName = new Map(release.assets.map((asset) => [asset?.name, asset]));
  const baseUploadUrl = release.upload_url.replace(/\{[^}]*\}$/, "");
  const parsedBaseUploadUrl = new URL(baseUploadUrl);
  if (parsedBaseUploadUrl.protocol !== "https:" || parsedBaseUploadUrl.hostname.toLowerCase() !== "uploads.github.com") {
    throw new Error(`GitHub draft Release ${tag} returned an unexpected upload host.`);
  }

  for (const asset of assets) {
    const name = releaseAssetName(asset?.name, "GitHub Release asset name");
    const stat = await fs.stat(asset.filePath);
    if (!stat.isFile() || stat.size !== asset.size || stat.size < 1) {
      throw new Error(`GitHub Release asset ${name} does not match its generated local file.`);
    }
    const existing = remoteAssetsByName.get(name);
    if (existing !== undefined) {
      assert.ok(
        existing
          && Number.isInteger(existing.id)
          && typeof existing.url === "string"
          && Number.isSafeInteger(existing.size),
        `GitHub draft Release ${tag} contains an invalid existing ${name} asset.`,
      );
      assert.equal(existing.size, stat.size, `GitHub draft Release ${tag} existing ${name} size does not match the local artifact.`);
      const [remoteDigest, localSha256] = await Promise.all([
        digestRemoteAsset(existing, { token, fetchImpl }),
        sha256File(asset.filePath),
      ]);
      assert.equal(remoteDigest.size, stat.size, `GitHub draft Release ${tag} existing ${name} download size does not match the local artifact.`);
      assert.equal(remoteDigest.sha256, localSha256, `GitHub draft Release ${tag} existing ${name} SHA-256 does not match the local artifact.`);
      continue;
    }
    const uploadUrl = new URL(parsedBaseUploadUrl);
    uploadUrl.searchParams.set("name", name);
    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
      },
      body: await fs.readFile(asset.filePath),
      redirect: "follow",
    });
    if (!response.ok) throw await responseError(response, `GitHub upload ${name}`);
    const uploaded = await response.json();
    if (uploaded?.name !== name || uploaded?.size !== stat.size) {
      throw new Error(`GitHub did not confirm the expected uploaded Release asset ${name}.`);
    }
    remoteAssetsByName.set(name, uploaded);
  }
  return release;
}

export async function promoteGitHubDraftRelease({
  owner,
  repo,
  releaseId,
  tag,
  token,
  releaseName,
  releaseNotes,
  fetchImpl = globalThis.fetch,
}) {
  assert.equal(typeof releaseName, "string", "GitHub Release name must be a string.");
  assert.ok(releaseName.trim(), "GitHub Release name must not be empty.");
  assert.equal(typeof releaseNotes, "string", "GitHub Release Notes must be a string.");
  assert.ok(releaseNotes.trim(), "GitHub Release Notes must not be empty.");
  const promoted = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${releaseId}`,
    {
      token,
      fetchImpl,
      method: "PATCH",
      body: {
        name: releaseName.trim(),
        body: releaseNotes.trim(),
        draft: false,
        prerelease: false,
        make_latest: "true",
      },
      label: `GitHub Release promotion ${tag}`,
    },
  );
  if (promoted.id !== releaseId || promoted.tag_name !== tag || promoted.draft !== false || promoted.prerelease !== false) {
    throw new Error(`GitHub did not confirm stable publication of ${tag}.`);
  }
  return promoted;
}
