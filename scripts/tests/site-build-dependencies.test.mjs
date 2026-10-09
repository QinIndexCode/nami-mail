import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const repoRoot = join(import.meta.dirname, "..", "..");
const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));

const nativeToolPaths = [
  ...["rolldown", "lightningcss", "esbuild"].map((name) => `node_modules/${name}`),
  ...Object.entries(lock.packages)
    .filter(([path, entry]) => path.endsWith("/typescript") && entry.optionalDependencies)
    .map(([path]) => path),
];

for (const path of nativeToolPaths) {
  test(`${path} locks every declared platform binding for clean cross-platform installs`, () => {
    const tool = lock.packages[path];
    assert.ok(tool?.optionalDependencies, `${path} must declare its native bindings`);
    for (const [binding, version] of Object.entries(tool.optionalDependencies)) {
      const entry = lock.packages[`node_modules/${binding}`];
      assert.ok(entry, `Missing locked package: ${binding}; npm ci would omit this platform binding`);
      assert.equal(entry.version, version, `${binding} must match ${path}'s version`);
    }
  });
}

test("the required PR check includes the same Linux install and site build as Pages", () => {
  const workflow = yaml.load(readFileSync(join(repoRoot, ".github/workflows/validate.yml"), "utf8"));
  const pages = yaml.load(readFileSync(join(repoRoot, ".github/workflows/pages.yml"), "utf8"));
  const site = workflow.jobs.site;
  assert.ok(site, "PR validation must exercise the Linux Pages build before merging");
  assert.equal(site["runs-on"], pages.jobs.deploy["runs-on"]);
  assert.equal(site.permissions.contents, "read");
  assert.equal("environment" in site, false);
  assert.equal(site.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["persist-credentials"], false);
  assert.equal(
    site.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with["node-version"],
    pages.jobs.deploy.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with["node-version"],
  );
  assert.deepEqual(site.steps.map((step) => step.run).filter(Boolean), [
    "npm ci --ignore-scripts",
    "node scripts/build-site.mjs",
  ]);
  for (const step of site.steps) {
    assert.doesNotMatch(JSON.stringify(step), /\$\{\{\s*secrets\./i);
  }
  assert.equal(workflow.jobs.validate.needs, "site");
  assert.equal(workflow.jobs.validate.if, "${{ always() }}", "A failed dependency must not skip the required check");
  const gate = workflow.jobs.validate.steps[0];
  assert.equal(gate.if, "${{ needs.site.result != 'success' }}");
  assert.equal(gate.run, "exit 1", "Failed, skipped, or cancelled Linux builds must fail the required check");
});
