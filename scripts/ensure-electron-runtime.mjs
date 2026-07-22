import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronRoot = path.join(projectRoot, "node_modules", "electron");
const electronExecutable = path.join(
  electronRoot,
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const installScript = path.join(electronRoot, "install.js");

async function executableExists() {
  try {
    return (await fs.stat(electronExecutable)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Electron runtime download exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

if (!(await executableExists())) {
  await fs.access(installScript);
  await run(process.execPath, [installScript]);
}

assert.equal(await executableExists(), true, `Electron runtime is missing: ${electronExecutable}`);
console.log(JSON.stringify({ electronExecutable: path.relative(projectRoot, electronExecutable) }));
