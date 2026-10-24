#!/usr/bin/env node
/**
 * The release-cut work list: which documents must be rewritten for a release.
 *
 * `scripts/docs-claims.mjs` answers "do the documents still tell the truth?".
 * It cannot answer the second release question: which pages describe the
 * *previous* version and therefore have to be rewritten when the version is
 * cut. This module is that second answer. One command, three sections:
 *
 *   BLOCK — the release cannot be cut until these are fixed;
 *   EDIT  — the pages that describe the old version, one line per file;
 *   CHECK — links and headings a human should confirm.
 *
 * The release-note trio (`v<version>.md`, `.zh-CN.md`, `.en.md`), the three
 * README `whats-new` anchors, both CHANGELOG `[Unreleased]` sections and the
 * release indexes are conventions the repository already follows; this script
 * turns them into a checklist instead of tribal knowledge.
 *
 * Usage:
 *   node scripts/docs-release-review.mjs
 *
 * Exit code 1 when there is at least one blocking item, 0 otherwise. The
 * review itself never writes a file and never throws: a missing document is a
 * finding, not a crash.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as docsClaims from "./docs-claims.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const moduleRepoRoot = resolve(scriptsDir, "..");

/**
 * docs-claims.mjs owns the repository root today but does not export it yet;
 * prefer the export the moment it appears so the two entry points agree.
 */
const defaultRepoRoot = docsClaims.defaultRepoRoot ?? moduleRepoRoot;

const RELEASE_READMES = ["README.md", "README.zh-CN.md", "README.en.md"];
const CHANGELOGS = ["CHANGELOG.zh-CN.md", "CHANGELOG.en.md"];
const RELEASE_INDEXES = ["docs/releases/README.zh-CN.md", "docs/releases/README.en.md"];

const SHIPPED_AS = /<!--\s*shipped-as:\s*v?(\d+\.\d+\.\d+)\s*-->/;
const WHATS_NEW = /<!--\s*whats-new:\s*v?(\d+\.\d+\.\d+)\s*-->/;
const VERSION = /\d+\.\d+\.\d+/;
const UNRELEASED = /^##\s+\[Unreleased\][^\n]*$/m;

/** Reads a document, or returns null when a fixture simply does not have it. */
function readText(repoRoot, relative) {
  try {
    return readFileSync(join(repoRoot, relative), "utf8");
  } catch {
    return null;
  }
}

function compareVersions(left, right) {
  const parse = (value) => value.split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Marks the version boundary in a regex ("0.5.1" must not match "0.5.10"). */
function versionPattern(version) {
  return version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pages that state which release they describe.
 *
 * docs-claims.mjs is the single source of truth for this list but does not
 * export it at the time of writing, so read the literal out of its source
 * instead of keeping a second copy that could drift. The export wins as soon
 * as it exists.
 */
let scopedDocumentsCache;
function scopedDocuments() {
  if (scopedDocumentsCache !== undefined) return scopedDocumentsCache;
  if (Array.isArray(docsClaims.SCOPED_DOCUMENTS)) {
    scopedDocumentsCache = docsClaims.SCOPED_DOCUMENTS;
    return scopedDocumentsCache;
  }
  try {
    const source = readFileSync(join(scriptsDir, "docs-claims.mjs"), "utf8");
    const literal = source.match(/const SCOPED_DOCUMENTS\s*=\s*\[([\s\S]*?)\];/);
    const documents = literal
      ? [...literal[1].matchAll(/"([^"\n]+\.md)"/g)].map((match) => match[1])
      : [];
    if (documents.length > 0) {
      scopedDocumentsCache = documents;
      return scopedDocumentsCache;
    }
  } catch {
    // Fall through: without the list the scoped checks simply report nothing.
  }
  scopedDocumentsCache = [];
  return scopedDocumentsCache;
}

/** The version under review, read through docs-claims so both scripts agree. */
function readVersion(repoRoot, blocking) {
  try {
    return docsClaims.readFacts({ repoRoot }).version;
  } catch {
    // The review does not need the tool counts; the package version alone is
    // enough, and a fixture without contracts can still be reviewed.
    const text = readText(repoRoot, "package.json");
    if (text !== null) {
      try {
        const version = JSON.parse(text).version;
        if (typeof version === "string" && VERSION.test(version)) return version;
      } catch {
        // Fall through to the blocking finding below.
      }
    }
    blocking.push(
      "package.json is missing or has no usable version; the review needs the version that is being cut — restore it before releasing.",
    );
    return "0.0.0";
  }
}

/** The latest tag and how many commits sit past it, or nothing without git. */
function gitContext(repoRoot) {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!tag) return { tag: undefined, commitsPastTag: undefined };
    const count = Number(
      execFileSync("git", ["rev-list", "--count", `${tag}..HEAD`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    return {
      tag,
      commitsPastTag: Number.isFinite(count) ? count : undefined,
    };
  } catch {
    // No git (a fixture, a tarball): the changelog emptiness and tag checks
    // are skipped instead of failing the review.
    return { tag: undefined, commitsPastTag: undefined };
  }
}

// --- blocking findings -----------------------------------------------------

/** 1. The release-note trio exists for every version. */
function releaseNoteProblems(repoRoot, version) {
  const problem = "the release ships an entry page plus Chinese and English notes — create it from the previous version's trio and write the notes.";
  return [`v${version}.md`, `v${version}.zh-CN.md`, `v${version}.en.md`]
    .map((name) => `docs/releases/${name}`)
    .filter((document) => !existsSync(join(repoRoot, document)))
    .map((document) => `${document} is missing; ${problem}`);
}

/** 2. Every README anchors its whats-new block to the version being cut. */
function whatsNewMarkerProblems(repoRoot, version) {
  const problems = [];
  for (const readme of RELEASE_READMES) {
    const text = readText(repoRoot, readme);
    if (text === null) {
      problems.push(`${readme} is missing; the README carries the whats-new anchor — restore it before releasing.`);
      continue;
    }
    const marker = text.match(WHATS_NEW);
    if (!marker) {
      problems.push(
        `${readme} has no <!-- whats-new: v${version} --> marker; add it above the release heading so the whats-new block is anchored to this version.`,
      );
      continue;
    }
    if (compareVersions(marker[1], version) !== 0) {
      problems.push(
        `${readme} anchors its whats-new block at v${marker[1]}, but package.json says ${version}; update the marker and the heading when cutting the release.`,
      );
    }
  }
  return problems;
}

/** 3. Both changelogs home unreleased work and fill it when trunk moved on. */
function changelogProblems(repoRoot, commitsPastTag) {
  const problems = [];
  for (const changelog of CHANGELOGS) {
    const text = readText(repoRoot, changelog);
    if (text === null) {
      problems.push(`${changelog} is missing; the changelog is the only home for unreleased changes — restore it before releasing.`);
      continue;
    }
    const heading = text.match(UNRELEASED);
    if (!heading) {
      problems.push(
        `${changelog} has no "## [Unreleased]" section; add it at the top so changes past the latest tag have a home.`,
      );
      continue;
    }
    if (commitsPastTag !== undefined && commitsPastTag > 0) {
      const body = text.slice(heading.index + heading[0].length).split(/^##\s+/m)[0];
      if (!/^\s*[-*]\s+\S/m.test(body)) {
        problems.push(
          `${changelog}'s [Unreleased] section is empty while ${commitsPastTag} commit(s) sit past the latest tag; write the release notes there first.`,
        );
      }
    }
  }
  return problems;
}

/** 4. No page describes a release newer than the package version. */
function newerShippedAsProblems(repoRoot, version) {
  const problems = [];
  for (const document of scopedDocuments()) {
    const text = readText(repoRoot, document);
    if (text === null) continue;
    const marker = text.match(SHIPPED_AS);
    if (!marker || compareVersions(marker[1], version) <= 0) continue;
    problems.push(
      `${document} says shipped-as v${marker[1]}, newer than package.json's ${version}; bump the package version or correct the marker before releasing.`,
    );
  }
  return problems;
}

/** 5. The release indexes list the version being cut. */
function releaseIndexProblems(repoRoot, version) {
  const problems = [];
  for (const index of RELEASE_INDEXES) {
    const text = readText(repoRoot, index);
    if (text === null) {
      problems.push(`${index} is missing; the release index is how readers find the notes — restore it and list v${version}.`);
      continue;
    }
    const listed = new RegExp(`v${versionPattern(version)}(?![\\d.])`).test(text);
    if (!listed) {
      problems.push(
        `${index} does not list v${version}; add the release bullet with a link to the matching language notes.`,
      );
    }
  }
  return problems;
}

// --- edits (the version-cut work list) -------------------------------------

/** 6. Every page still describing an older release must be rewritten. */
function staleShippedAsEdits(repoRoot, version) {
  const edits = [];
  for (const document of scopedDocuments()) {
    const text = readText(repoRoot, document);
    if (text === null) continue;
    const marker = text.match(SHIPPED_AS);
    if (!marker || compareVersions(marker[1], version) >= 0) continue;
    edits.push(`${document} (shipped-as v${marker[1]} → v${version})`);
  }
  return edits;
}

/** 7. Claim drift is not a blocker, but it must be repaired before rewriting. */
function claimEdits(repoRoot) {
  try {
    const problems = docsClaims.findClaimProblems({ repoRoot });
    if (problems.length === 0) return [];
    return [
      `findClaimProblems() reports ${problems.length} unresolved claim(s); run \`npm run docs:claims\` before rewriting the scoped pages.`,
    ];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [`findClaimProblems() could not run (${detail}); run \`npm run docs:claims\` after fixing the checkout.`];
  }
}

// --- manual checks ---------------------------------------------------------

/** 8. The whats-new heading names the same version as the marker/package. */
function whatsNewHeadingCheck(repoRoot, version) {
  const parts = [];
  let agree = true;
  for (const readme of RELEASE_READMES) {
    const text = readText(repoRoot, readme);
    if (text === null) {
      parts.push(`${readme}: missing`);
      agree = false;
      continue;
    }
    const marker = text.match(WHATS_NEW);
    if (!marker) {
      parts.push(`${readme}: no whats-new marker`);
      agree = false;
      continue;
    }
    const heading = text.slice(marker.index + marker[0].length).match(/^\s*##\s+([^\n]+)$/m);
    const found = heading?.[1].match(VERSION)?.[0];
    if (!found) {
      parts.push(`${readme}: no version in the whats-new heading`);
      agree = false;
      continue;
    }
    parts.push(`${readme}: ${found}`);
    if (compareVersions(found, version) !== 0) agree = false;
  }
  const verdict = agree
    ? `all match package ${version}`
    : `confirm each heading matches package ${version}`;
  return { text: `whats-new headings — ${parts.join("; ")} (${verdict})`, agree };
}

/** 9. The entry page links the Chinese and English notes, and they resolve. */
function releaseEntryLinkCheck(repoRoot, version) {
  const entry = `docs/releases/v${version}.md`;
  const text = readText(repoRoot, entry);
  if (text === null) return `${entry} is missing — the Chinese/English notes links cannot be verified`;
  const targets = new Map();
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    for (const suffix of [`v${version}.zh-CN.md`, `v${version}.en.md`]) {
      if (target.split(/[?#]/)[0].split(/[\\/]/).pop() === suffix) targets.set(suffix, target);
    }
  }
  const describe = (suffix) => {
    const target = targets.get(suffix);
    if (!target) return `${suffix} not linked`;
    const cleaned = target.split(/[?#]/)[0];
    const local = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)
      ? `docs/releases/${cleaned.split(/[\\/]/).pop()}`
      : join("docs/releases", cleaned).split("\\").join("/");
    return existsSync(join(repoRoot, local))
      ? `${suffix} → ${local} (exists)`
      : `${suffix} → ${local} (BROKEN: file missing)`;
  };
  const chinese = describe(`v${version}.zh-CN.md`);
  const english = describe(`v${version}.en.md`);
  const linked = chinese.includes("exists") && english.includes("exists");
  return `${entry} notes links — ${chinese}; ${english}${linked ? "" : " — fix the entry page links before releasing"}`;
}

/** 10. The tag/version relation: is the version even bumped yet? */
function tagCheck(version, git) {
  if (!git.tag) return "no git tag available — the tag/version comparison was skipped (expected for a fixture)";
  const tagVersion = git.tag.replace(/^v/, "");
  const relation = compareVersions(tagVersion, version);
  if (relation === 0) {
    return `latest tag ${git.tag} already equals package ${version} — the version has not been bumped yet; run \`npm run sync:version\` before cutting the release`;
  }
  if (relation < 0) {
    return `package ${version} is ahead of latest tag ${git.tag} — confirm the tag is cut only after the notes, changelogs and markers land`;
  }
  return `package ${version} is behind latest tag ${git.tag} — investigate the version source before releasing`;
}

// --- public API ------------------------------------------------------------

/**
 * Reviews the release cut without touching the filesystem.
 *
 * Returns exactly `{ version, blocking, edits, checks }`. The git context the
 * header needs (latest tag and commits past it) is attached as a
 * non-enumerable `gitContext` so the documented object shape stays the four
 * public keys.
 */
export function reviewRelease({ repoRoot = defaultRepoRoot } = {}) {
  const blocking = [];
  const edits = [];
  const checks = [];
  let version = "0.0.0";
  let git = { tag: undefined, commitsPastTag: undefined };
  try {
    version = readVersion(repoRoot, blocking);
    git = gitContext(repoRoot);
    blocking.push(...releaseNoteProblems(repoRoot, version));
    blocking.push(...whatsNewMarkerProblems(repoRoot, version));
    blocking.push(...changelogProblems(repoRoot, git.commitsPastTag));
    blocking.push(...newerShippedAsProblems(repoRoot, version));
    blocking.push(...releaseIndexProblems(repoRoot, version));

    edits.push(...staleShippedAsEdits(repoRoot, version));
    edits.push(...claimEdits(repoRoot));

    checks.push(whatsNewHeadingCheck(repoRoot, version).text);
    checks.push(releaseEntryLinkCheck(repoRoot, version));
    checks.push(tagCheck(version, git));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    blocking.push(`the release review hit an unexpected error (${detail}); fix the checkout and re-run the review.`);
  }
  const report = { version, blocking, edits, checks };
  Object.defineProperty(report, "gitContext", { value: git, enumerable: false });
  return report;
}

/** Renders a review as the multi-line printout; pure, no console output. */
export function formatReview(report) {
  const version = String(report?.version ?? "0.0.0");
  const blocking = Array.isArray(report?.blocking) ? report.blocking : [];
  const edits = Array.isArray(report?.edits) ? report.edits : [];
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const git = report?.gitContext;
  const context =
    git && git.tag && Number.isFinite(git.commitsPastTag)
      ? ` (${git.commitsPastTag} commit${git.commitsPastTag === 1 ? "" : "s"} past ${git.tag})`
      : "";

  const lines = [
    `[release] review for v${version}${context}`,
    "",
    `BLOCK (${blocking.length})`,
    ...blocking.map((item) => `  - ${item}`),
    "",
    `EDIT (${edits.length})`,
    ...edits.map((item) => `  - ${item}`),
    "",
    `CHECK (${checks.length})`,
    ...checks.map((item) => `  - ${item}`),
    "",
  ];
  lines.push(
    blocking.length > 0
      ? `[release] ${blocking.length} blocking item(s); run npm run sync:version after they are resolved`
      : `[release] no blocking items; ${edits.length} edit(s) queued for the version cut`,
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const report = reviewRelease();
    console.log(formatReview(report));
    process.exitCode = report.blocking.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`docs-release-review: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
