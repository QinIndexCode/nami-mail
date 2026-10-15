#!/usr/bin/env node
/**
 * Synchronize the official website hero version badge (site/index.html)
 * with the current version declared in package.json.
 *
 * Supports --check mode to fail in CI if the version badge has drifted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function syncSiteVersion({ repoRoot = defaultRepoRoot, checkOnly = false } = {}) {
  const packageJsonPath = join(repoRoot, "package.json");
  const packageManifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = packageManifest.version?.trim();
  if (!version) {
    throw new Error("package.json is missing a valid version string");
  }

  const indexPath = join(repoRoot, "site", "index.html");
  const html = readFileSync(indexPath, "utf8");
  const versionPattern = /<span class="meta-tag">v[^<]+<\/span>/;
  const match = html.match(versionPattern);
  if (!match) {
    throw new Error("site/index.html is missing a <span class=\"meta-tag\">v...</span> hero version tag");
  }

  const targetBadge = `<span class="meta-tag">v${version}</span>`;
  const isUpToDate = match[0] === targetBadge;

  if (checkOnly) {
    if (!isUpToDate) {
      throw new Error(
        `site/index.html hero version tag is out of sync with package.json: found ${match[0]}, expected ${targetBadge}. Run "node scripts/sync-site-version.mjs" or "npm run build:site" to synchronize.`
      );
    }
    return { version, updated: false };
  }

  if (!isUpToDate) {
    const updated = html.replace(versionPattern, targetBadge);
    writeFileSync(indexPath, updated, "utf8");
    console.log(`[sync-site-version] Updated site/index.html hero version tag -> v${version}`);
    return { version, updated: true };
  }

  return { version, updated: false };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const checkOnly = process.argv.includes("--check");
    const result = syncSiteVersion({ checkOnly });
    if (!checkOnly) {
      if (!result.updated) {
        console.log(`[sync-site-version] site/index.html is already up to date (v${result.version})`);
      }
    } else {
      console.log(`[sync-site-version] site/index.html version check passed (v${result.version})`);
    }
  } catch (error) {
    console.error(`sync-site-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
