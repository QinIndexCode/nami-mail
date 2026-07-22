import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(projectRoot, "apps", "server");
const vitestCli = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath)) throw new Error(`${description} is missing: ${filePath}`);
}

assertFile(vitestCli, "Vitest");

try {
  const test = spawnSync(process.execPath, [vitestCli, "run", ...process.argv.slice(2)], {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (test.error) throw test.error;
  process.exitCode = test.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
