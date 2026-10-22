/**
 * Pins the release-cut checklist that `scripts/docs-release-review.mjs` prints.
 *
 * docs-claims answers "are the documents still true?"; this file proves the
 * second question — "which documents must be rewritten for this release?" —
 * against throwaway repositories, so the rules are checked independently of
 * the current checkout. The last test runs the review over the real repository
 * as a gate: a release can only be cut once its checklist is clean.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { formatReview, reviewRelease } from "../docs-release-review.mjs";

const VERSION = "1.2.3";
const repoRoot = join(import.meta.dirname, "..", "..");

const GIT_IDENTITY = ["-c", "user.email=release-review@example.com", "-c", "user.name=Release Review"];

function contractSource(name, count) {
  const entries = Array.from(
    { length: count },
    (_, index) => `  {\n    toolName: "tool.${index}",\n    cliWords: ["tool"],\n  },`,
  ).join("\n");
  return `export const ${name} = [\n${entries}\n] as const;\n`;
}

function writeRepoFile(root, relative, text) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");
}

const readmeFor = (version, { markerVersion = version, headingVersion = version } = {}) =>
  `<!-- shipped-as: v${version} -->\n` +
  `<!-- whats-new: v${markerVersion} -->\n` +
  `## What's New in ${headingVersion}\n\n` +
  "- shipped\n";

const changelogFor = (version, { unreleased = "- trunk change\n" } = {}) =>
  (unreleased === null ? "" : `## [Unreleased]\n\n${unreleased}\n`) +
  `## [${version}] - 2026-01-01\n\n- shipped\n`;

function releaseNoteFiles(version) {
  return {
    [`docs/releases/v${version}.md`]:
      `# Nami Mail ${version}\n\n` +
      `[中文说明](v${version}.zh-CN.md) | [English notes](v${version}.en.md)\n`,
    [`docs/releases/v${version}.zh-CN.md`]: `# v${version}\n\n- 说明\n`,
    [`docs/releases/v${version}.en.md`]: `# v${version}\n\n- notes\n`,
  };
}

/** The smallest document set the review treats as a clean release cut. */
function baseFiles(version) {
  return {
    "package.json": `${JSON.stringify({ name: "nami-release-review-test", version }, null, 2)}\n`,
    "packages/agent-contracts/src/external-mail.ts": contractSource("externalReadMailContracts", 9),
    "packages/agent-contracts/src/external-write-mail.ts": contractSource("externalWriteMailContracts", 7),
    "README.md": readmeFor(version),
    "README.zh-CN.md": readmeFor(version),
    "README.en.md": readmeFor(version),
    "docs/PRIVACY.zh-CN.md": `<!-- shipped-as: v${version} -->\n\n# 隐私\n`,
    "docs/releases/README.zh-CN.md": `# Release Notes\n\n- [v${version}](v${version}.zh-CN.md) 当前版本\n`,
    "docs/releases/README.en.md": `# Release Notes\n\n- [v${version}](v${version}.en.md) current release\n`,
    ...releaseNoteFiles(version),
    "CHANGELOG.zh-CN.md": changelogFor(version),
    "CHANGELOG.en.md": changelogFor(version),
  };
}

function initGit(root, { tag, extraCommits = 1 }) {
  const run = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run(["init", "-q"]);
  run(["add", "-A"]);
  run([...GIT_IDENTITY, "commit", "-q", "-m", "release fixture"]);
  run(["tag", tag]);
  for (let index = 1; index <= extraCommits; index += 1) {
    writeRepoFile(root, `docs/development/trunk-change-${index}.md`, `# trunk change ${index}\n`);
    run(["add", "-A"]);
    run([...GIT_IDENTITY, "commit", "-q", "-m", `trunk change ${index}`]);
  }
}

function makeRepo(t, { version = VERSION, omit = [], overrides = {}, git } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nami-release-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { ...baseFiles(version), ...overrides };
  for (const relative of omit) delete files[relative];
  for (const [relative, text] of Object.entries(files)) writeRepoFile(root, relative, text);
  if (git) initGit(root, git);
  return root;
}

const blockingText = (report) => report.blocking.join("\n");

test("a clean repository has nothing blocking and nothing to edit", (t) => {
  const root = makeRepo(t);
  const report = reviewRelease({ repoRoot: root });
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.edits, []);
  assert.equal(report.checks.length, 3);
  assert.equal(report.version, VERSION);
  assert.equal(formatReview(report).split("\n")[0], `[release] review for v${VERSION}`);
});

test("a missing English release-note file blocks the review", (t) => {
  const root = makeRepo(t, { omit: [`docs/releases/v${VERSION}.en.md`] });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 1);
  assert.match(blockingText(report), /docs\/releases\/v1\.2\.3\.en\.md is missing/);
  assert.match(blockingText(report), /create it from the previous version's trio/);
});

test("a README without a whats-new marker blocks the review", (t) => {
  const root = makeRepo(t, {
    overrides: { "README.zh-CN.md": `<!-- shipped-as: v${VERSION} -->\n## 1.2.3 新功能\n\n- x\n` },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 1);
  assert.match(blockingText(report), /README\.zh-CN\.md has no <!-- whats-new: v1\.2\.3 --> marker/);
});

test("a whats-new marker naming another version blocks the review", (t) => {
  const root = makeRepo(t, {
    overrides: { "README.en.md": readmeFor(VERSION, { markerVersion: "1.2.2" }) },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 1);
  assert.match(blockingText(report), /README\.en\.md anchors its whats-new block at v1\.2\.2/);
});

test("a changelog without an [Unreleased] section blocks the review", (t) => {
  const root = makeRepo(t, {
    overrides: { "CHANGELOG.en.md": changelogFor(VERSION, { unreleased: null }) },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 1);
  assert.match(blockingText(report), /CHANGELOG\.en\.md has no "## \[Unreleased\]" section/);
});

test("an empty [Unreleased] section blocks when commits sit past the tag", (t) => {
  const root = makeRepo(t, {
    overrides: {
      "CHANGELOG.zh-CN.md": changelogFor(VERSION, { unreleased: "" }),
      "CHANGELOG.en.md": changelogFor(VERSION, { unreleased: "" }),
    },
    git: { tag: `v${VERSION}`, extraCommits: 1 },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 2);
  assert.match(blockingText(report), /CHANGELOG\.zh-CN\.md's \[Unreleased\] section is empty while 1 commit/);
  assert.match(blockingText(report), /CHANGELOG\.en\.md's \[Unreleased\] section is empty while 1 commit/);
  assert.match(formatReview(report).split("\n")[0], /\(1 commit past v1\.2\.3\)$/);
});

test("a shipped-as marker newer than the package blocks the review", (t) => {
  const root = makeRepo(t, {
    overrides: { "docs/PRIVACY.zh-CN.md": "<!-- shipped-as: v1.3.0 -->\n\n# 隐私\n" },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 1);
  assert.match(blockingText(report), /docs\/PRIVACY\.zh-CN\.md says shipped-as v1\.3\.0, newer than package\.json's 1\.2\.3/);
});

test("a release index that does not list the current version blocks the review", (t) => {
  const root = makeRepo(t, {
    overrides: {
      "docs/releases/README.zh-CN.md": "# Release Notes\n\n- [v1.2.2](v1.2.2.zh-CN.md) 上一版本\n",
    },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.equal(report.blocking.length, 1);
  assert.match(blockingText(report), /docs\/releases\/README\.zh-CN\.md does not list v1\.2\.3/);
});

test("an old shipped-as marker is queued as an edit with the version arrow", (t) => {
  const root = makeRepo(t, {
    overrides: { "docs/CALENDAR.zh-CN.md": "<!-- shipped-as: v1.2.2 -->\n\n# 日历\n" },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.edits, ["docs/CALENDAR.zh-CN.md (shipped-as v1.2.2 → v1.2.3)"]);
  assert.match(formatReview(report), /docs\/CALENDAR\.zh-CN\.md \(shipped-as v1\.2\.2 → v1\.2\.3\)/);
});

test("unresolved claim problems are listed as an edit, not a block", (t) => {
  const staleBuildStatus = "> **当前构建状态：可用。** 0.4.0 安装包随附十六个工具：九个只读 + 七个写。\n\n";
  const root = makeRepo(t, {
    overrides: { "README.md": readmeFor(VERSION).replace("## What's New in", `${staleBuildStatus}## What's New in`) },
  });
  const report = reviewRelease({ repoRoot: root });
  assert.deepEqual(report.blocking, []);
  assert.equal(report.edits.length, 1);
  assert.match(report.edits[0], /findClaimProblems\(\) reports 1 unresolved claim\(s\); run `npm run docs:claims`/);
});

test("formatReview prints all three section headers even for an empty report", () => {
  const text = formatReview({ version: VERSION, blocking: [], edits: [], checks: [] });
  assert.match(text, /^\[release\] review for v1\.2\.3$/m);
  assert.match(text, /^BLOCK \(0\)$/m);
  assert.match(text, /^EDIT \(0\)$/m);
  assert.match(text, /^CHECK \(0\)$/m);
  assert.match(text, /^\[release\] no blocking items; 0 edit\(s\) queued for the version cut$/m);
});

test("formatReview labels every item and its blocking footer", () => {
  const text = formatReview({
    version: VERSION,
    blocking: ["docs/releases/v1.2.3.en.md is missing"],
    edits: ["README.md (shipped-as v1.2.2 → v1.2.3)"],
    checks: ["latest tag is v1.2.3"],
  });
  assert.match(text, /^BLOCK \(1\)\n {2}- docs\/releases\/v1\.2\.3\.en\.md is missing$/m);
  assert.match(text, /^EDIT \(1\)\n {2}- README\.md \(shipped-as v1\.2\.2 → v1\.2\.3\)$/m);
  assert.match(text, /^CHECK \(1\)\n {2}- latest tag is v1\.2\.3$/m);
  assert.match(text, /^\[release\] 1 blocking item\(s\); run npm run sync:version after they are resolved$/m);
});

test("an empty repository is reported as blocking findings, not a crash", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nami-release-review-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = reviewRelease({ repoRoot: root });
  assert.ok(report.blocking.length >= 6, "every missing release surface must be reported");
  assert.match(blockingText(report), /package\.json is missing or has no usable version/);
  assert.match(blockingText(report), /docs\/releases\/v0\.0\.0\.md is missing/);
  assert.equal(typeof formatReview(report), "string");
});

test("the checked-in repository has no blocking release problems", () => {
  const report = reviewRelease({ repoRoot });
  assert.deepEqual(report.blocking, []);
  assert.equal(report.checks.length, 3);
});
