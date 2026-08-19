// Regression checker: boots the desktop app with NAMI_CHIP_OVERLAP_PROBE=1
// (the sweep inside apps/desktop/src/desktop-smoke.mts), then prints the
// per-width chip-vs-rail geometry from the smoke result and exits non-zero if
// any sample overlapped, the workspace lost its positioning context, or the
// citations anchor would land under the rail. The sweep is env-gated, so the
// normal smoke run never executes it.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), "nami-chip-overlap-"));
const resultPath = path.join(temporaryUserData, "smoke-result.json");
const progressPath = path.join(temporaryUserData, "smoke-progress.json");

const child = spawn(electronExecutable, ["."], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NAMI_MAIL_USER_DATA_DIR: temporaryUserData,
    NAMI_MAIL_SMOKE: "1",
    NAMI_MAIL_SMOKE_EXIT_AFTER_READY_MS: "8000",
    NAMI_MAIL_SMOKE_RESULT_PATH: resultPath,
    NAMI_MAIL_SMOKE_PROGRESS_PATH: progressPath,
    NAMI_CHIP_OVERLAP_PROBE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let outputTail = "";
child.stdout?.on("data", (chunk) => {
  outputTail = `${outputTail}${String(chunk)}`.slice(-4096);
});
child.stderr?.on("data", (chunk) => {
  outputTail = `${outputTail}${String(chunk)}`.slice(-4096);
});

const deadline = Date.now() + 120_000;
let renderer;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    throw new Error(`Electron exited (code ${child.exitCode}) before writing the sweep result.\n${outputTail}`);
  }
  try {
    renderer = JSON.parse(await fs.readFile(resultPath, "utf8"));
    break;
  } catch {
    // The app needs a moment to boot and run the probes.
  }
  await delay(250);
}
if (!renderer) throw new Error(`No sweep result within ${deadline - Date.now()}ms.\n${outputTail}`);
if (renderer.error) console.warn(`app error: ${renderer.error}`);
const sweep = renderer.desktopChipOverlapSweep;
if (!sweep) {
  console.warn("The sweep did not run (NAMI_CHIP_OVERLAP_PROBE not honored?).");
  process.exit(2);
}

const subjects = new Set();
console.log("mode    | width | innerW | agent | chip x..right      | chip maxW | workspace x..right | rail x..right | clearance | overlap | wsPos | citesAnchor | pageOverflow");
let anyOverlap = false;
let positionMismatch = false;
let anchorViolation = false;
for (const sample of sweep.samples ?? []) {
  const chip = sample.chip;
  const rail = sample.rail;
  const workspace = sample.workspace;
  const overlap = sample.overlap;
  const subject = chip && chip.subject ? String(chip.subject) : "";
  if (subject) subjects.add(`${subject} (${chip.subjectLength})`);
  const chipSpan = chip ? `${chip.rect.x}..${chip.rect.right}` : "(no chip)";
  const chipMax = chip ? String(chip.maxWidth) : "-";
  const workspaceSpan = workspace ? `${workspace.x}..${workspace.right}${workspace.w !== Number(sample.innerWidth) - 56 ? ` [w=${workspace.w}]` : ""}` : "(none)";
  const railSpan = rail && rail.display !== "none" ? `${rail.rect.x}..${rail.rect.right}` : "(rail hidden)";
  const clearance = overlap ? String(overlap.clearancePx) : "-";
  const overlapped = overlap?.overlapping === true ? "OVERLAP!" : "clear";
  const wsPosition = String(sample.workspacePosition ?? "-");
  const citesAnchor = sample.citationsAnchor === null || sample.citationsAnchor === undefined ? "-" : String(sample.citationsAnchor);
  const pageOverflow = Number(sample.pageScrollWidth) > Number(sample.innerWidth) ? "YES" : "no";
  if (overlap?.overlapping === true) anyOverlap = true;
  if (sample.agentOpen && wsPosition !== "relative") positionMismatch = true;
  if (sample.agentOpen && Number.isInteger(sample.citationsAnchor) && Number(sample.citationsAnchor) <= 0) anchorViolation = true;
  console.log(
    `${String(sample.mode).padEnd(7)} | ${String(sample.width).padEnd(5)} | ${String(sample.innerWidth).padEnd(6)} | ${String(sample.agentOpen).padEnd(5)} | ${chipSpan.padEnd(18)} | ${chipMax.padEnd(9)} | ${workspaceSpan.padEnd(18)} | ${railSpan.padEnd(14)} | ${clearance.padEnd(9)} | ${overlapped.padEnd(7)} | ${wsPosition.padEnd(7)} | ${citesAnchor.padEnd(13)} | ${pageOverflow}`,
  );
}
if (subjects.size) console.log(`chip subjects: ${[...subjects].join(" | ")}`);
console.log(`overlappingCount=${sweep.overlappingCount ?? 0} ${sweep.overlappingWidths?.length ? `(${sweep.overlappingWidths.join(", ")})` : ""}`);
console.log(`positionMismatch=${positionMismatch} citationsAnchorViolation=${anchorViolation}`);
console.log(`desktopUrl=${sweep.desktopUrl}`);
console.log(`browserUrl=${sweep.browserUrl}`);

await fs.mkdir(path.join(projectRoot, "output"), { recursive: true });
await fs.writeFile(path.join(projectRoot, "output", "chip-overlap-sweep.json"), `${JSON.stringify(sweep, null, 2)}\n`, "utf8");
console.log("sweep json written to output/chip-overlap-sweep.json");
await fs.rm(temporaryUserData, { recursive: true, force: true }).catch(() => undefined);
process.exit(anyOverlap || positionMismatch || anchorViolation ? 1 : 0);