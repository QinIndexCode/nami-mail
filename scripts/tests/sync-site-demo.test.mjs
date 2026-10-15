import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..");

test("package.json exposes sync:demo, sync:version and build:site commands", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["sync:demo"], "node scripts/sync-site-demo.mjs");
  assert.equal(pkg.scripts["sync:version"], "node scripts/sync-site-version.mjs");
  assert.equal(pkg.scripts["sync:version:check"], "node scripts/sync-site-version.mjs --check");
  assert.equal(pkg.scripts["build:site"], "node scripts/build-site.mjs");
});

test("package-win.mjs invokes sync-site-demo.mjs during release packaging", () => {
  const packageWin = readFileSync(join(repoRoot, "scripts", "package-win.mjs"), "utf8");
  assert.ok(
    packageWin.includes("sync-site-demo.mjs"),
    "Release packaging must synchronize the site demo with latest frontend",
  );
});

test("sync-site-demo.mjs script is available and valid", async () => {
  const scriptPath = join(repoRoot, "scripts", "sync-site-demo.mjs");
  assert.ok(existsSync(scriptPath), "scripts/sync-site-demo.mjs must exist");
  const module = await import(new URL(`file://${scriptPath.replace(/\\/g, "/")}`).href);
  assert.equal(typeof module.syncSiteDemo, "function");
});

test("demo directory contains the generated sandbox entry wrapper", () => {
  const entryPath = join(repoRoot, "site", "demo", "site-demo-entry.js");
  if (existsSync(entryPath)) {
    const content = readFileSync(entryPath, "utf8");
    assert.ok(content.includes('["demo", "1"]'), "Demo entry must force demo=1");
    assert.ok(content.includes('["preview", "site"]'), "Demo entry must force preview=site");
    assert.ok(content.includes("document.documentElement.lang"), "Demo entry must set language");
    assert.ok(content.includes("document.documentElement.dataset.theme"), "Demo entry must set theme");
  }
});
