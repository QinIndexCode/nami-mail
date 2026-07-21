import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedStableReleaseTag,
  parseGitHubRepository,
  promoteGitHubDraftRelease,
  resolveReleaseDirectory,
  resolveWindowsReleaseAssets,
  verifyGitHubDraftRelease,
} from "./release-policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseDirectory = resolveReleaseDirectory(projectRoot);
const repository = parseGitHubRepository(process.env.NAMI_MAIL_GITHUB_REPOSITORY);
const tag = expectedStableReleaseTag(packageManifest.version);
const workflowTag = process.env.GITHUB_REF_NAME?.trim();
const token = process.env.GH_TOKEN?.trim();
if (!workflowTag || workflowTag !== tag) {
  throw new Error(`GITHUB_REF_NAME must equal the stable package tag ${tag}.`);
}
if (!token) throw new Error("GH_TOKEN is required to verify and publish the GitHub Release.");

const expectedAssets = await resolveWindowsReleaseAssets({
  projectRoot,
  releaseDirectory,
  version: packageManifest.version,
});
const draft = await verifyGitHubDraftRelease({
  ...repository,
  tag,
  token,
  expectedAssets,
});
await promoteGitHubDraftRelease({
  ...repository,
  releaseId: draft.id,
  tag,
  token,
});

console.log(JSON.stringify({
  repository: `${repository.owner}/${repository.repo}`,
  tag,
  releaseId: draft.id,
  verifiedAssets: expectedAssets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  published: true,
}));
