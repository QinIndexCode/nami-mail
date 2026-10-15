import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { syncSiteVersion } from "../sync-site-version.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

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

test("syncSiteVersion({ checkOnly: true }) succeeds when repo is in sync", () => {
  const result = syncSiteVersion({ repoRoot, checkOnly: true });
  assert.equal(result.updated, false);
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(result.version, pkg.version);
});

test("syncSiteVersion correctly detects drift and replaces stale versions", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nami-sync-version-test-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const mockPkg = { name: "nami-test", version: "1.5.0" };
  writeFileSync(join(tempDir, "package.json"), JSON.stringify(mockPkg), "utf8");

  const siteDir = join(tempDir, "site");
  mkdirSync(siteDir);
  const sampleHtml = `<div class="hero-meta">\n  <span class="meta-tag">v0.1.0-alpha</span>\n</div>`;
  writeFileSync(join(siteDir, "index.html"), sampleHtml, "utf8");

  // checkOnly: true should throw with informative message
  assert.throws(
    () => syncSiteVersion({ repoRoot: tempDir, checkOnly: true }),
    /out of sync with package\.json: found <span class="meta-tag">v0\.1\.0-alpha<\/span>, expected <span class="meta-tag">v1\.5\.0<\/span>/,
  );

  // normal sync should update file
  const syncResult = syncSiteVersion({ repoRoot: tempDir, checkOnly: false });
  assert.equal(syncResult.updated, true);
  assert.equal(syncResult.version, "1.5.0");

  const updatedHtml = readFileSync(join(siteDir, "index.html"), "utf8");
  assert.ok(updatedHtml.includes(`<span class="meta-tag">v1.5.0</span>`));

  // second run should report no updates needed
  const idempotentResult = syncSiteVersion({ repoRoot: tempDir, checkOnly: false });
  assert.equal(idempotentResult.updated, false);

  // and checkOnly should now succeed
  const checkResult = syncSiteVersion({ repoRoot: tempDir, checkOnly: true });
  assert.equal(checkResult.updated, false);
});

test("syncSiteVersion throws helpful error when version tag is missing", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nami-sync-version-test-missing-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
  const siteDir = join(tempDir, "site");
  mkdirSync(siteDir);
  writeFileSync(join(siteDir, "index.html"), "<div>no meta tag here</div>", "utf8");

  assert.throws(
    () => syncSiteVersion({ repoRoot: tempDir, checkOnly: false }),
    /site\/index\.html is missing a <span class="meta-tag">v\.\.\.<\/span> hero version tag/,
  );
});
