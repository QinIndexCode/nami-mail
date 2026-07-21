import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStableReleaseVersion,
  expectedStableReleaseTag,
  parseExpectedWindowsSigningIdentity,
  parseGitHubRepository,
  resolveReleaseDirectory,
  uploadGitHubReleaseAssets,
  verifyPublicGitHubRepository,
} from "./release-policy.mjs";
import {
  createGitHubZipUpdateAssets,
  readEd25519SigningKey,
  writeEd25519UpdateTrust,
} from "./github-update-assets.mjs";

if (process.platform !== "win32") {
  throw new Error("Windows NSIS packaging can only run on Windows.");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseDirectory = resolveReleaseDirectory(
  projectRoot,
  process.env.NAMI_MAIL_RELEASE_DIRECTORY?.trim() || path.join("release-artifacts", packageManifest.version),
);
const expectedInstaller = path.join(releaseDirectory, `Nami Mail Setup ${packageManifest.version}.exe`);
const githubMode = process.argv.includes("--github");
const publishRequested = process.argv.includes("--publish");
if (publishRequested && !githubMode) throw new Error("--publish requires --github.");

const githubRepository = githubMode
  ? parseGitHubRepository(process.env.NAMI_MAIL_GITHUB_REPOSITORY)
  : undefined;
const stableVersion = githubMode ? assertStableReleaseVersion(packageManifest.version) : undefined;
const hasAuthenticodeSigning = Boolean(process.env.CSC_LINK?.trim() || process.env.CSC_NAME?.trim());
const expectedSigningIdentity = githubMode && hasAuthenticodeSigning
  ? parseExpectedWindowsSigningIdentity(process.env)
  : undefined;
const ed25519SigningKey = githubMode ? readEd25519SigningKey(process.env) : undefined;
if (githubMode && !hasAuthenticodeSigning && !ed25519SigningKey) {
  throw new Error("GitHub ZIP update builds require either an Authenticode certificate or NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY.");
}
if (publishRequested) {
  if (!process.env.GH_TOKEN?.trim()) throw new Error("GH_TOKEN is required to publish a GitHub Release.");
  const releaseTag = process.env.GITHUB_REF_NAME?.trim();
  const expectedTag = expectedStableReleaseTag(stableVersion);
  if (!releaseTag || releaseTag !== expectedTag) {
    throw new Error(`GITHUB_REF_NAME must equal the stable package tag ${expectedTag}.`);
  }
}
if (githubMode) {
  await verifyPublicGitHubRepository({
    ...githubRepository,
    token: process.env.GH_TOKEN?.trim(),
  });
}

const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const electronBuilderCli = path.join(projectRoot, "node_modules", "electron-builder", "cli.js");
const trustConfigPath = path.join(projectRoot, "build", "nami-update-trust.json");
const originalTrustConfig = await fs.readFile(trustConfigPath).catch((error) => {
  if (error?.code === "ENOENT") return undefined;
  throw error;
});
const {
  NAMI_MAIL_INSTALLER_EXECUTABLE: _ignoredInstallerExecutable,
  NAMI_MAIL_EXPECTED_INSTALLER: _ignoredExpectedInstaller,
  NAMI_MAIL_PACKAGE_STARTED_AT: _ignoredPackageStartedAt,
  GH_TOKEN: _githubToken,
  GITHUB_TOKEN: _githubActionsToken,
  GITHUB_RELEASE_TOKEN: _githubReleaseToken,
  CSC_LINK: _certificateLink,
  CSC_NAME: _certificateName,
  CSC_KEY_PASSWORD: _certificatePassword,
  WIN_CSC_LINK: _windowsCertificateLink,
  WIN_CSC_KEY_PASSWORD: _windowsCertificatePassword,
  NAMI_MAIL_UPDATE_ED25519_PRIVATE_KEY: _updatePrivateKey,
  NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER: _expectedWindowsPublisher,
  NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT: _expectedWindowsCertificateThumbprint,
  ...cleanEnvironment
} = process.env;

function run(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

async function restoreTrustConfig() {
  if (originalTrustConfig) await fs.writeFile(trustConfigPath, originalTrustConfig);
  else await fs.rm(trustConfigPath, { force: true });
}

await fs.access(npmCli);
await fs.access(electronBuilderCli);
if (ed25519SigningKey) await writeEd25519UpdateTrust(trustConfigPath, ed25519SigningKey);

try {
  await run(process.execPath, [npmCli, "run", "build"], cleanEnvironment);
  await run(process.execPath, [npmCli, "run", "rebuild:electron"], cleanEnvironment);

  const packageStartedAt = Date.now();
  const builderArguments = [
    electronBuilderCli,
    "--win",
    "nsis",
    "--x64",
    "--publish",
    publishRequested ? "always" : "never",
    `--config.directories.output=${releaseDirectory}`,
  ];
  if (githubRepository) {
    builderArguments.push(
      "--config.publish.provider=github",
      `--config.publish.owner=${githubRepository.owner}`,
      `--config.publish.repo=${githubRepository.repo}`,
      "--config.publish.releaseType=draft",
    );
    if (expectedSigningIdentity) {
      builderArguments.push(
        "--config.win.signExecutable=true",
        "--config.win.verifyUpdateCodeSignature=true",
        `--config.win.signtoolOptions.publisherName=${expectedSigningIdentity.publisher}`,
      );
    }
  }
  const builderEnvironment = {
    ...cleanEnvironment,
    NAMI_MAIL_RELEASE_DIRECTORY: releaseDirectory,
    ...(publishRequested ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
    ...(hasAuthenticodeSigning ? {
      ...(process.env.CSC_LINK ? { CSC_LINK: process.env.CSC_LINK } : {}),
      ...(process.env.CSC_NAME ? { CSC_NAME: process.env.CSC_NAME } : {}),
      ...(process.env.CSC_KEY_PASSWORD ? { CSC_KEY_PASSWORD: process.env.CSC_KEY_PASSWORD } : {}),
    } : {}),
  };
  await run(process.execPath, builderArguments, builderEnvironment);
  const installerStat = await fs.stat(expectedInstaller);
  assert.ok(installerStat.size > 1_000_000, "Windows installer is unexpectedly small.");
  assert.ok(
    installerStat.mtimeMs >= packageStartedAt,
    `Expected installer was not regenerated by this package run: ${expectedInstaller}`,
  );

  const zipUpdateAssets = githubMode
    ? await createGitHubZipUpdateAssets({
      projectRoot,
      releaseDirectory,
      version: stableVersion,
      signingKey: ed25519SigningKey,
    })
    : [];
  if (publishRequested && zipUpdateAssets.length > 0) {
    await uploadGitHubReleaseAssets({
      ...githubRepository,
      tag: expectedStableReleaseTag(stableVersion),
      token: process.env.GH_TOKEN,
      assets: zipUpdateAssets,
    });
  }

  await run(process.execPath, [path.join(projectRoot, "scripts", "smoke-package.mjs")], {
    ...cleanEnvironment,
    NAMI_MAIL_RELEASE_DIRECTORY: releaseDirectory,
    NAMI_MAIL_EXPECTED_INSTALLER: expectedInstaller,
    NAMI_MAIL_PACKAGE_STARTED_AT: String(packageStartedAt),
    ...(githubRepository ? {
      NAMI_MAIL_EXPECT_GITHUB_UPDATE_OWNER: githubRepository.owner,
      NAMI_MAIL_EXPECT_GITHUB_UPDATE_REPO: githubRepository.repo,
      ...(expectedSigningIdentity ? {
        NAMI_MAIL_REQUIRE_SIGNED_UPDATE_ARTIFACTS: "1",
        NAMI_MAIL_EXPECTED_WINDOWS_PUBLISHER: expectedSigningIdentity.publisher,
        NAMI_MAIL_EXPECTED_WINDOWS_CERTIFICATE_THUMBPRINT: expectedSigningIdentity.thumbprint,
      } : {}),
      ...(ed25519SigningKey ? {
        NAMI_MAIL_EXPECT_ED25519_UPDATE_PUBLIC_KEY: ed25519SigningKey.publicKeyBase64,
      } : {}),
    } : {}),
  });
} finally {
  await restoreTrustConfig();
}
