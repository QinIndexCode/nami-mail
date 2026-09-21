import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// promote-github-release.mjs reads docs/releases/v<version>.md as the GitHub
// Release body. The file is authored per release, so a forgotten file used to
// surface only after the release job had signed, packaged, and uploaded its
// assets. This guard fails in seconds with an actionable message instead.
//
// This script runs before `npm ci` in the release workflow, so it must stay
// dependency-free: mirror the stable-version rule from release-policy.mjs
// rather than importing it (which would pull in js-yaml).
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = packageManifest.version?.trim();
if (!version || !stableVersionPattern.test(version)) {
  throw new Error(`GitHub stable releases require an exact x.y.z semantic version without prerelease or build metadata; received ${JSON.stringify(packageManifest.version)}.`);
}
const tag = `v${version}`;
const releaseNotesPath = path.join(projectRoot, "docs", "releases", `${tag}.md`);
let releaseNotes;
try {
  releaseNotes = await fs.readFile(releaseNotesPath, "utf8");
} catch {
  throw new Error(`Missing docs/releases/${tag}.md — promote-github-release.mjs requires the paired release notes. Create them before tagging.`);
}
if (!releaseNotes.trim()) {
  throw new Error(`docs/releases/${tag}.md is empty — promote-github-release.mjs requires non-empty release notes.`);
}
console.log(`release notes ok: docs/releases/${tag}.md`);
