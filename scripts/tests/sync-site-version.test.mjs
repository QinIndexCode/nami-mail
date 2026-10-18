import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  findVersionReferenceProblems,
  syncSiteVersion,
  verifyVersionReferences,
  whatsNewMarker,
} from "../sync-site-version.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

function makeTempRepo(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRepoFile(dir, relativePath, content) {
  const fullPath = join(dir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

/** A minimal fixture whose published documents all describe `version`. */
function writeCoherentReleaseDocs(dir, version) {
  writeRepoFile(dir, "package.json", JSON.stringify({ name: "nami-test", version }));
  const readmes = [
    ["README.md", "en"],
    ["README.en.md", "en"],
    ["README.zh-CN.md", "zh-CN"],
  ];
  for (const [file, lang] of readmes) {
    writeRepoFile(
      dir,
      file,
      `${whatsNewMarker(version)}\n## What's New in ${version}\n\nSee docs/releases/v${version}.${lang}.md.\n`
    );
  }
  for (const lang of ["en", "zh-CN"]) {
    writeRepoFile(dir, `docs/releases/v${version}.${lang}.md`, `# Nami Mail ${version}\n`);
    writeRepoFile(dir, `docs/releases/README.${lang}.md`, `- [v${version}](v${version}.${lang}.md) is the current release.\n`);
    writeRepoFile(dir, `docs/RELEASING.${lang}.md`, `Current release notes: releases/v${version}.md\n`);
  }
}

test("package.json exposes sync:version and sync:version:check commands", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["sync:version"], "node scripts/sync-site-version.mjs");
  assert.equal(pkg.scripts["sync:version:check"], "node scripts/sync-site-version.mjs --check");
});

test("site/index.html hero version tag matches package.json version exactly", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const html = readFileSync(join(repoRoot, "site", "index.html"), "utf8");
  const match = html.match(/<span class="meta-tag">v([^<]+)<\/span>/);
  assert.ok(match, "site/index.html must contain a <span class=\"meta-tag\">v...</span> hero badge");
  assert.equal(match[1], pkg.version, "site/index.html hero version badge must match package.json version");
});

test("the repository's published documents describe its current version", () => {
  assert.deepEqual(findVersionReferenceProblems({ repoRoot }), []);
});

test("syncSiteVersion({ checkOnly: true }) succeeds when repo is in sync", () => {
  const result = syncSiteVersion({ repoRoot, checkOnly: true });
  assert.equal(result.updated, false);
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(result.version, pkg.version);
});

test("syncSiteVersion detects drift and rewrites every repairable surface", (t) => {
  const tempDir = makeTempRepo(t, "nami-sync-version-test-");
  writeRepoFile(tempDir, "package.json", JSON.stringify({ name: "nami-test", version: "1.5.0" }));
  writeRepoFile(tempDir, "site/index.html", `<div class="hero-meta">\n  <span class="meta-tag">v0.1.0-alpha</span>\n</div>`);
  writeRepoFile(tempDir, "docs/cli/examples.en.md", '```json\n{"name":"NamiMail","version":"0.1.0-alpha"}\n```\n');
  writeRepoFile(tempDir, "docs/cli/examples.zh-CN.md", '```json\n{"name":"NamiMail","version":"0.1.0-alpha"}\n```\n');
  writeRepoFile(tempDir, "docs/cli/output-schema.en.md", '{\n  "meta": {\n    "version": "0.1.0-alpha"\n  }\n}\n');
  writeRepoFile(tempDir, "docs/cli/output-schema.zh-CN.md", '{\n  "meta": {\n    "version": "0.1.0-alpha"\n  }\n}\n');

  // checkOnly reports the drift and leaves the files untouched.
  assert.throws(
    () => syncSiteVersion({ repoRoot: tempDir, checkOnly: true }),
    (error) => {
      assert.match(error.message, /out of sync with package\.json \(v1\.5\.0\)/);
      assert.match(
        error.message,
        /site\/index\.html: found <span class="meta-tag">v0\.1\.0-alpha<\/span>, expected <span class="meta-tag">v1\.5\.0<\/span>/
      );
      assert.match(error.message, /docs\/cli\/examples\.zh-CN\.md: found \{"name":"NamiMail","version":"0\.1\.0-alpha"\}/);
      assert.match(error.message, /docs\/cli\/output-schema\.en\.md: found "version": "0\.1\.0-alpha"/);
      assert.match(error.message, /npm run sync:version/);
      return true;
    }
  );
  assert.ok(readFileSync(join(tempDir, "site", "index.html"), "utf8").includes("v0.1.0-alpha"));

  const syncResult = syncSiteVersion({ repoRoot: tempDir, checkOnly: false });
  assert.equal(syncResult.updated, true);
  assert.equal(syncResult.version, "1.5.0");
  assert.deepEqual(syncResult.updatedFiles, [
    "site/index.html",
    "docs/cli/examples.en.md",
    "docs/cli/examples.zh-CN.md",
    "docs/cli/output-schema.en.md",
    "docs/cli/output-schema.zh-CN.md",
  ]);
  assert.ok(readFileSync(join(tempDir, "site", "index.html"), "utf8").includes(`<span class="meta-tag">v1.5.0</span>`));
  assert.ok(readFileSync(join(tempDir, "docs", "cli", "examples.zh-CN.md"), "utf8").includes(`"version":"1.5.0"`));
  assert.ok(readFileSync(join(tempDir, "docs", "cli", "output-schema.en.md"), "utf8").includes(`"version": "1.5.0"`));

  // second run should report no updates needed
  assert.equal(syncSiteVersion({ repoRoot: tempDir, checkOnly: false }).updated, false);

  // and checkOnly should now succeed
  assert.equal(syncSiteVersion({ repoRoot: tempDir, checkOnly: true }).updated, false);
});

test("syncSiteVersion throws helpful errors when a present surface lost its version literal", (t) => {
  const tempDir = makeTempRepo(t, "nami-sync-version-test-missing-");
  writeRepoFile(tempDir, "package.json", JSON.stringify({ version: "1.0.0" }));

  writeRepoFile(tempDir, "site/index.html", "<div>no meta tag here</div>");
  assert.throws(
    () => syncSiteVersion({ repoRoot: tempDir, checkOnly: false }),
    /site\/index\.html is missing a <span class="meta-tag">v\.\.\.<\/span> hero version tag/
  );

  writeRepoFile(tempDir, "site/index.html", `<span class="meta-tag">v1.0.0</span>`);
  writeRepoFile(tempDir, "docs/cli/examples.zh-CN.md", '```json\n{"name":"NamiMail"}\n```\n');
  assert.throws(
    () => syncSiteVersion({ repoRoot: tempDir, checkOnly: false }),
    /docs\/cli\/examples\.zh-CN\.md is missing the \{"name":"NamiMail","version":"\.\.\."\} sample output/
  );
});

test("verifyVersionReferences accepts a repository that describes its current release", (t) => {
  const tempDir = makeTempRepo(t, "nami-version-refs-ok-");
  writeCoherentReleaseDocs(tempDir, "2.0.0");

  assert.deepEqual(findVersionReferenceProblems({ repoRoot: tempDir }), []);
  assert.doesNotThrow(() => verifyVersionReferences({ repoRoot: tempDir }));
});

test("verifyVersionReferences reports a README that still describes the previous release", (t) => {
  const tempDir = makeTempRepo(t, "nami-version-refs-stale-");
  writeCoherentReleaseDocs(tempDir, "0.6.0");
  writeRepoFile(tempDir, "README.md", `${whatsNewMarker("0.5.1")}\n## What's New in 0.5.1\n\nSee docs/releases/v0.5.1.en.md.\n`);

  const problems = findVersionReferenceProblems({ repoRoot: tempDir });
  assert.ok(
    problems.some((problem) => problem.includes('README.md: add "<!-- whats-new: v0.6.0 -->"')),
    problems.join("\n")
  );
  assert.ok(
    problems.some((problem) => problem.includes("README.md: the v0.6.0 section must link docs/releases/v0.6.0.en.md")),
    problems.join("\n")
  );
  assert.throws(() => verifyVersionReferences({ repoRoot: tempDir }), /do not describe the current release/);
});

test("verifyVersionReferences reports release notes missing for the current version", (t) => {
  const tempDir = makeTempRepo(t, "nami-version-refs-notes-");
  writeCoherentReleaseDocs(tempDir, "0.6.0");
  rmSync(join(tempDir, "docs", "releases", "v0.6.0.zh-CN.md"));

  const problems = findVersionReferenceProblems({ repoRoot: tempDir });
  assert.ok(
    problems.some((problem) => problem.includes("docs/releases/v0.6.0.zh-CN.md is missing")),
    problems.join("\n")
  );
});

test("verifyVersionReferences reports a release index that skips the current release", (t) => {
  const tempDir = makeTempRepo(t, "nami-version-refs-index-");
  writeCoherentReleaseDocs(tempDir, "0.6.0");
  writeRepoFile(tempDir, "docs/releases/README.en.md", "- [v0.5.1](v0.5.1.en.md) is the previous release.\n");

  const problems = findVersionReferenceProblems({ repoRoot: tempDir });
  assert.ok(
    problems.some((problem) =>
      problem.includes("docs/releases/README.en.md: add a bullet for the current release linking (v0.6.0.en.md)")
    ),
    problems.join("\n")
  );
});
