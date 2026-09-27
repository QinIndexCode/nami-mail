import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..");
const scriptsDir = join(repoRoot, "scripts");
const testsDir = join(scriptsDir, "tests");
const testsPrefix = `tests${sep}`;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

test("every script test lives in scripts/tests/ so CI discovers it", () => {
  // CI runs `node --test "scripts/tests/*.test.mjs"`, so a test filed anywhere
  // else under scripts/ would silently never run. `attic/` is exempt: archived
  // scripts are kept for reference and are intentionally not executed.
  const strays = walk(scriptsDir)
    .map((file) => file.slice(scriptsDir.length + 1))
    .filter((file) => !file.startsWith(testsPrefix));
  assert.deepEqual(strays, []);
});

test("both validation workflows run the script tests by glob", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const workflow of ["validate.yml", "release-windows.yml"]) {
    const text = await readFile(join(repoRoot, ".github", "workflows", workflow), "utf8");
    assert.match(
      text,
      /node --test "scripts\/tests\/\*\.test\.mjs"/,
      `${workflow} must run the script tests by glob`,
    );
    assert.doesNotMatch(
      text,
      /node --test scripts\/[a-z-]+\.test\.mjs/,
      `${workflow} must not list individual script tests: file them in scripts/tests/ instead`,
    );
  }
});
