import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedStableReleaseTag } from "./release-policy.mjs";

// promote-github-release.mjs reads docs/releases/v<version>.md as the GitHub
// Release body. The file is authored per release, so a forgotten file used to
// surface only after the release job had signed, packaged, and uploaded its
// assets. This guard fails in seconds with an actionable message instead.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const tag = expectedStableReleaseTag(packageManifest.version);
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
