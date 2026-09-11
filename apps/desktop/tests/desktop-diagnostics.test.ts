import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopDiagnostics,
  formatConsoleArgs,
  isDesktopStartupLogDisabled,
  runtimeLogMaxLines,
  serializeRuntimeError,
  startupLogMaxLines,
} from "../src/desktop-diagnostics.mts";

async function temporaryProfile(t: test.TestContext): Promise<string> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "nami-desktop-diagnostics-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  return profile;
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await fs.readFile(filePath, "utf8");
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("writes the summary file and the append-only stage log", async (t) => {
  const profile = await temporaryProfile(t);
  const diagnostics = new DesktopDiagnostics();
  diagnostics.initialize(profile);

  diagnostics.recordStartupTiming("boot-start", 12);
  diagnostics.appendStartupLog("main-window-create-start", 40, "renderer");

  const summary = JSON.parse(await fs.readFile(path.join(profile, "startup-timings.json"), "utf8")) as {
    startedAt: string;
    timings: Array<{ stage: string; elapsedMs: number }>;
  };
  assert.equal(summary.timings.length, 1);
  assert.deepEqual(summary.timings[0], { stage: "boot-start", elapsedMs: 12 });
  assert.ok(Number.isFinite(Date.parse(summary.startedAt)));

  const lines = await readJsonLines(path.join(profile, "startup-log.jsonl"));
  // The stage log keeps every recorded stage, including the ones that only
  // ever went to the per-launch summary before.
  assert.deepEqual(lines.map((line) => [line.stage, line.ms, line.pid]), [
    ["boot-start", 12, "main"],
    ["main-window-create-start", 40, "renderer"],
  ]);
});

test("bounds both logs to their trailing window", async (t) => {
  const profile = await temporaryProfile(t);
  const diagnostics = new DesktopDiagnostics();
  diagnostics.initialize(profile);

  // One over each bound, so the head must be dropped and the tail kept.
  for (let index = 0; index < startupLogMaxLines + 1; index += 1) {
    diagnostics.appendStartupLog(`stage-${index}`, index);
  }
  diagnostics.pruneStartupLog();
  const startupLines = await readJsonLines(path.join(profile, "startup-log.jsonl"));
  assert.equal(startupLines.length, startupLogMaxLines);
  assert.equal(startupLines[0]?.stage, "stage-1");

  for (let index = 0; index < runtimeLogMaxLines + 5; index += 1) {
    diagnostics.appendRuntimeLog("event", { index });
  }
  // The runtime log is bounded at boot, not on every append.
  diagnostics.initialize(profile);
  const runtimeLines = await readJsonLines(path.join(profile, "runtime-log.jsonl"));
  assert.equal(runtimeLines.length, runtimeLogMaxLines);
  assert.equal(runtimeLines.at(-1)?.index, runtimeLogMaxLines + 4);
});

test("truncates long runtime messages and never writes an empty one", async (t) => {
  const profile = await temporaryProfile(t);
  const diagnostics = new DesktopDiagnostics();
  diagnostics.initialize(profile);
  diagnostics.appendRuntimeLog("uncaught-exception", { message: "x".repeat(4000), stack: "y".repeat(4000) });

  const [line] = await readJsonLines(path.join(profile, "runtime-log.jsonl"));
  assert.equal((line?.message as string).length, 512);
  assert.equal((line?.stack as string).length, 512);
  assert.equal(line?.event, "uncaught-exception");
});

test("stays inert before initialize and when the kill switch is set", async (t) => {
  const profile = await temporaryProfile(t);
  const uninitialized = new DesktopDiagnostics();
  // No paths yet: appending must not create files anywhere.
  uninitialized.appendStartupLog("too-early", 1);
  uninitialized.appendRuntimeLog("too-early");
  uninitialized.recordStartupTiming("too-early", 1);
  assert.deepEqual(await fs.readdir(profile), []);

  const previous = process.env.NAMI_MAIL_NO_STARTUP_LOG;
  process.env.NAMI_MAIL_NO_STARTUP_LOG = "1";
  try {
    assert.equal(isDesktopStartupLogDisabled(), true);
    uninitialized.initialize(profile);
    uninitialized.appendStartupLog("suppressed", 1);
    uninitialized.appendRuntimeLog("suppressed");
    await assert.rejects(fs.access(path.join(profile, "startup-log.jsonl")));
    await assert.rejects(fs.access(path.join(profile, "runtime-log.jsonl")));
  } finally {
    if (previous === undefined) delete process.env.NAMI_MAIL_NO_STARTUP_LOG;
    else process.env.NAMI_MAIL_NO_STARTUP_LOG = previous;
  }
});

test("formats console arguments and errors for the runtime log", () => {
  assert.equal(formatConsoleArgs(["translation failed", new Error("socket closed"), { code: 42 }]), "translation failed socket closed {\"code\":42}");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatConsoleArgs([circular]), "[object Object]");
  const serialized = serializeRuntimeError(new Error("boom"));
  assert.equal(serialized.message, "boom");
  assert.match(String(serialized.stack), /^Error: boom/);
  assert.deepEqual(serializeRuntimeError("plain"), { message: "plain" });
});
