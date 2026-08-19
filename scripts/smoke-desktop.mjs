import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { redactSmokeDiagnosticText } from "./smoke-diagnostics.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const bundledElectronExecutable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const configuredExecutable = process.env.NAMI_MAIL_DESKTOP_EXECUTABLE?.trim();
const electronExecutable = configuredExecutable ? path.resolve(configuredExecutable) : bundledElectronExecutable;
const desktopWorkingDirectory = configuredExecutable ? path.dirname(electronExecutable) : projectRoot;
const desktopArguments = configuredExecutable ? [] : ["."];
const temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), "nami-mail-desktop-"));
const smokeGoogleOAuthClientId = "desktop-smoke-google-client";
const smokeMicrosoftOAuthClientId = "desktop-smoke-microsoft-client";
const smokeMicrosoftTenant = "smoke-tenant";
const smokeOAuthFlowTtlSeconds = 90;
await fs.writeFile(
  path.join(temporaryUserData, "nami-mail.env"),
  [
    `NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID=${smokeGoogleOAuthClientId}`,
    `NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID=${smokeMicrosoftOAuthClientId}`,
    `NAMI_MAIL_MICROSOFT_TENANT=${smokeMicrosoftTenant}`,
    `NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS=${smokeOAuthFlowTtlSeconds}`,
    "",
  ].join("\n"),
  "utf8",
);
const desktopEnvironment = { ...process.env };
for (const name of [
  "NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID",
  "NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID",
  "NAMI_MAIL_MICROSOFT_TENANT",
  "NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS",
]) {
  delete desktopEnvironment[name];
}
const execFileAsync = promisify(execFile);
const reportPath = path.join(projectRoot, "output", "desktop-smoke.json");
const diagnosticReportPath = path.join(projectRoot, "output", "desktop-smoke-diagnostic.json");
// The app quits on its own 8s after the smoke result is written, then shuts
// the local server down under its own 8s bound; allow both plus margin.
const gracefulExitTimeoutMs = 25_000;
const forcedExitTimeoutMs = 10_000;
const smokeResultTimeoutMs = 90_000;
const smokeResultPollIntervalMs = 200;
const capturedOutputTailLimit = 4_096;
const rendererFetchTimeoutMs = 10_000;

function appendOutputTail(existing, chunk) {
  const combined = `${existing}${redactSmokeDiagnosticText(String(chunk).replaceAll("\0", ""))}`;
  return combined.length > capturedOutputTailLimit ? combined.slice(-capturedOutputTailLimit) : combined;
}

function createProcessOutputCapture(processHandle) {
  let stdoutTail = "";
  let stderrTail = "";
  let launchError;
  processHandle.stdout?.on("data", (chunk) => {
    stdoutTail = appendOutputTail(stdoutTail, chunk);
  });
  processHandle.stderr?.on("data", (chunk) => {
    stderrTail = appendOutputTail(stderrTail, chunk);
  });
  processHandle.once("error", (error) => {
    launchError = redactSmokeDiagnosticText(error instanceof Error ? error.message : String(error));
  });
  return {
    snapshot() {
      return {
        stdoutTail: stdoutTail.trim(),
        stderrTail: stderrTail.trim(),
        launchError,
      };
    },
  };
}

async function readSmokeProgress(progressPath) {
  try {
    const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
    if (!progress || typeof progress !== "object" || typeof progress.stage !== "string") return undefined;
    return {
      stage: progress.stage.slice(0, 160),
      checkedAt: typeof progress.checkedAt === "string" ? progress.checkedAt.slice(0, 64) : undefined,
    };
  } catch {
    return undefined;
  }
}

async function describeDesktopProcess(progressPath, processHandle, outputCapture) {
  const progress = await readSmokeProgress(progressPath);
  const { stdoutTail, stderrTail, launchError } = outputCapture?.snapshot() ?? {};
  const details = [
    `lastStage=${progress?.stage ?? "unavailable"}`,
    `stageAt=${progress?.checkedAt ?? "unavailable"}`,
    `pid=${processHandle?.pid ?? "unavailable"}`,
    `exitCode=${processHandle?.exitCode ?? "running"}`,
    `signal=${processHandle?.signalCode ?? "none"}`,
  ];
  if (launchError) details.push(`launchError=${JSON.stringify(redactSmokeDiagnosticText(launchError))}`);
  if (stderrTail) details.push(`stderrTail=${JSON.stringify(redactSmokeDiagnosticText(stderrTail))}`);
  if (stdoutTail) details.push(`stdoutTail=${JSON.stringify(redactSmokeDiagnosticText(stdoutTail))}`);
  return details.join("; ");
}

async function writeDesktopSmokeDiagnostic(error, progressPath, processHandle, outputCapture) {
  const progress = await readSmokeProgress(progressPath);
  const { stdoutTail, stderrTail, launchError } = outputCapture?.snapshot() ?? {};
  const message = redactSmokeDiagnosticText(error instanceof Error ? error.message : String(error));
  const diagnostic = {
    checkedAt: new Date().toISOString(),
    error: message.slice(0, 8_000),
    lastStage: progress?.stage ?? "unavailable",
    lastStageAt: progress?.checkedAt ?? "unavailable",
    process: {
      pid: processHandle?.pid ?? null,
      exitCode: processHandle?.exitCode ?? null,
      signal: processHandle?.signalCode ?? null,
    },
    ...(launchError ? { launchError: redactSmokeDiagnosticText(launchError) } : {}),
    ...(stderrTail ? { stderrTail: redactSmokeDiagnosticText(stderrTail) } : {}),
    ...(stdoutTail ? { stdoutTail: redactSmokeDiagnosticText(stdoutTail) } : {}),
  };
  await fs.mkdir(path.dirname(diagnosticReportPath), { recursive: true });
  await fs.writeFile(diagnosticReportPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
}

async function fetchRenderer(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(rendererFetchTimeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Desktop renderer HTTP probe did not complete within ${rendererFetchTimeoutMs / 1_000} seconds: ${message}`);
  }
}

async function waitForResult(resultPath, progressPath, processHandle, outputCapture) {
  const deadline = Date.now() + smokeResultTimeoutMs;
  while (Date.now() < deadline) {
    const { launchError } = outputCapture.snapshot();
    if (launchError) {
      throw new Error(`Electron could not start before writing its smoke result. ${await describeDesktopProcess(progressPath, processHandle, outputCapture)}`);
    }
    if (processHandle.exitCode !== null) {
      throw new Error(`Electron exited before writing its smoke result. ${await describeDesktopProcess(progressPath, processHandle, outputCapture)}`);
    }
    try {
      return JSON.parse(await fs.readFile(resultPath, "utf8"));
    } catch {
      // Electron needs a short moment to create the renderer and inspect its DOM.
    }
    await delay(smokeResultPollIntervalMs);
  }
  throw new Error(
    `Electron did not write a smoke result within ${smokeResultTimeoutMs / 1_000} seconds. ${await describeDesktopProcess(progressPath, processHandle, outputCapture)}`,
  );
}

async function waitForSingleInstanceResult(resultPath, processHandle) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error("Primary Electron process exited during the single-instance probe.");
    try {
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      if (result.desktopSingleInstance?.activationCount >= 1) return result;
    } catch {
      // The primary process may be replacing its smoke result atomically.
    }
    await delay(100);
  }
  throw new Error("The primary Electron process did not receive the single-instance activation.");
}

function parseProcessIds(value) {
  if (!value.trim()) return [];
  const parsed = JSON.parse(value);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function runPowerShell(script, timeout) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout },
  );
  return stdout.trim();
}

async function waitForWindowsProcessIdsToExit(processIds, timeoutMs) {
  if (!processIds.length) return [];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$processIds = @(${processIds.join(",")})`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})`,
    "do { $alive = @(); foreach ($processId in $processIds) { try { [void][System.Diagnostics.Process]::GetProcessById($processId); $alive += $processId } catch [System.ArgumentException] {} }; if ($alive.Count -eq 0) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline)",
    "@($alive | Sort-Object -Unique) | ConvertTo-Json -Compress",
  ].join("; ");
  return parseProcessIds(await runPowerShell(script, timeoutMs + 2_000));
}

async function terminateWindowsProcesses(processIds) {
  if (!processIds.length) return [];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$processIds = @(${processIds.join(",")})`,
    "foreach ($processId in $processIds) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }",
    "@($processIds) | ConvertTo-Json -Compress",
  ].join("; ");
  return parseProcessIds(await runPowerShell(script, 10_000));
}

async function waitForDesktopProcessExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return true;
  await Promise.race([once(processHandle, "exit"), delay(timeoutMs)]);
  return processHandle.exitCode !== null;
}

async function stopDesktopProcess(processHandle, knownProcessIds) {
  if (process.platform === "win32" && processHandle.pid) {
    knownProcessIds.add(processHandle.pid);
    const initialIds = [...knownProcessIds];
    let alive = await waitForWindowsProcessIdsToExit(initialIds, gracefulExitTimeoutMs);
    if (!alive.length) return true;

    for (const pid of await terminateWindowsProcesses(alive)) knownProcessIds.add(pid);
    alive = await waitForWindowsProcessIdsToExit([...knownProcessIds], forcedExitTimeoutMs);
    return alive.length === 0;
  }

  if (processHandle.exitCode === null) processHandle.kill();
  if (await waitForDesktopProcessExit(processHandle, forcedExitTimeoutMs)) return true;
  processHandle.kill("SIGKILL");
  return waitForDesktopProcessExit(processHandle, forcedExitTimeoutMs);
}

function rememberDesktopProcess(processHandle, knownProcessIds) {
  if (process.platform !== "win32" || !processHandle.pid) return;
  knownProcessIds.add(processHandle.pid);
}

async function removeTemporaryUserData() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(temporaryUserData, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      await delay(250);
    }
  }
  return false;
}

let desktopProcess;
let secondDesktopProcess;
const desktopProcessIds = new Set();
let primaryFailure;
let desktopOutputCapture;
const resultPath = path.join(temporaryUserData, "smoke-result.json");
const progressPath = path.join(temporaryUserData, "smoke-progress.json");

try {
  await fs.rm(diagnosticReportPath, { force: true });
  await fs.access(electronExecutable);
  desktopProcess = spawn(electronExecutable, desktopArguments, {
    cwd: desktopWorkingDirectory,
    env: {
      ...desktopEnvironment,
      NAMI_MAIL_USER_DATA_DIR: temporaryUserData,
      NAMI_MAIL_SMOKE: "1",
      NAMI_MAIL_SMOKE_EXIT_AFTER_READY_MS: "8000",
      NAMI_MAIL_SMOKE_RESULT_PATH: resultPath,
      NAMI_MAIL_SMOKE_PROGRESS_PATH: progressPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  desktopOutputCapture = createProcessOutputCapture(desktopProcess);

  const renderer = await waitForResult(resultPath, progressPath, desktopProcess, desktopOutputCapture);
  rememberDesktopProcess(desktopProcess, desktopProcessIds);
  const report = {
    checkedAt: new Date().toISOString(),
    ...renderer,
    isolatedDataDirectory: false,
    contentSecurityPolicy: false,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  assert.equal(renderer.error, undefined, renderer.error ?? "Electron startup failed.");
  const rendererUrl = new URL(renderer.rendererUrl);
  assert.deepEqual(
    [...rendererUrl.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [["demo", "1"], ["desktop", "1"], ["desktopSmoke", "1"], ["platform", process.platform]],
    "The desktop renderer URL must not expose a local API capability.",
  );
  const runtimePort = Number.parseInt(rendererUrl.port, 10);
  assert.equal(rendererUrl.hostname, "127.0.0.1", "The desktop service must remain loopback-only.");
  assert.ok(Number.isInteger(runtimePort) && runtimePort > 0, "The desktop service must use an allocated loopback port.");
  if (process.platform === "win32") {
    assert.ok(runtimePort >= 49152 && runtimePort <= 65535, "The Windows desktop service must use an ephemeral, non-development port.");
  }
  assert.equal(renderer.title, "Nami Mail");
  const primaryServiceUrl = rendererUrl.origin;
  secondDesktopProcess = spawn(electronExecutable, [...desktopArguments, "--nami-single-instance-smoke"], {
    cwd: desktopWorkingDirectory,
    env: {
      ...desktopEnvironment,
      NAMI_MAIL_USER_DATA_DIR: temporaryUserData,
      NAMI_MAIL_SMOKE: "1",
      NAMI_MAIL_SMOKE_EXIT_AFTER_READY_MS: "8000",
      NAMI_MAIL_SMOKE_RESULT_PATH: resultPath,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  rememberDesktopProcess(secondDesktopProcess, desktopProcessIds);
  const secondInstanceExited = await waitForDesktopProcessExit(secondDesktopProcess, 5_000);
  assert.equal(secondInstanceExited, true, "The second Electron launch must hand off and exit instead of opening another app instance.");
  const rendererAfterSingleInstance = await waitForSingleInstanceResult(resultPath, desktopProcess);
  assert.equal(rendererAfterSingleInstance.desktopSingleInstance?.activationCount, 1, "The primary app must receive exactly one second-instance activation.");
  assert.equal(rendererAfterSingleInstance.desktopSingleInstance?.restored, true, "A second launch must restore the existing Nami Mail window.");
  assert.equal(rendererAfterSingleInstance.desktopSingleInstance?.serviceUrl, primaryServiceUrl, "A second launch must reuse the primary local service.");
  report.desktopSingleInstance = rendererAfterSingleInstance.desktopSingleInstance;
  assert.equal(renderer.desktopWindowBar, true, "The desktop renderer must draw the app-owned window bar.");
  assert.equal(renderer.desktopWindowBarBlend?.matchesSidebar, true, "The window bar must share the sidebar's translucent surface instead of drawing an opaque strip.");
  assert.equal(renderer.desktopWindowBarBlend?.hasBottomSeparator, false, "The window bar must not be framed as a standalone strip by a bottom border.");
  assert.equal(renderer.desktopWindowBarLayout?.barPosition, "absolute", "The window bar must float over the columns as the frameless drag strip.");
  assert.equal(renderer.desktopWindowBarLayout?.shellTop, 0, "The mail shell must reach the window's top edge.");
  assert.equal(renderer.desktopWindowBarLayout?.sidebarTop, 0, "The sidebar must reach the window's top edge.");
  const sidebarHeight = renderer.desktopWindowBarLayout?.sidebarHeight;
  if (sidebarHeight != null && renderer.desktopWindowBarLayout?.shellBottom != null) {
    assert.ok(
      Math.abs(sidebarHeight - renderer.desktopWindowBarLayout.shellBottom) < 1,
      `The sidebar must span both grid rows (${sidebarHeight}px vs shell ${renderer.desktopWindowBarLayout.shellBottom}px).`,
    );
  }
  assert.equal(renderer.desktopWindowBarLayout?.columnHeaderTop, 0, "The column header must reach the window's top edge.");
  assert.equal(renderer.desktopWindowBarLayout?.searchWrapDragRegion, "no-drag", "Interactive elements beneath the floating bar must stay clickable.");
  assert.equal(renderer.desktopWindowBarLayout?.searchClearOfControls, true, "The header search control must not overlap the window controls.");
  assert.equal(renderer.desktopWindowBarLayout?.searchClearOfControlsList, true, "The header filter controls must not overlap the window controls.");
  assert.equal(renderer.desktopWindowBarLayout?.railButtonClearOfControls, true, "The icon rail must not overlap the window controls.");
  assert.ok((renderer.desktopWindowBarLayout?.railButtonTop ?? 0) >= 78, "The icon rail's first button must sit below the floating window bar.");
  assert.equal(renderer.desktopWindowBarLayout?.columnHeaderHeight, 66, "The column header must keep its compact height so its content moves up.");
  assert.ok((renderer.desktopWindowBarLayout?.columnActiveTop ?? 0) < 42, "The header's first row must sit inside the floating bar zone after the move-up.");
  assert.ok(
    (renderer.desktopWindowBarLayout?.barHeight ?? 0) < (renderer.desktopWindowBarLayout?.columnActiveTop ?? 0),
    "The drag strip must sit above the header's first row so the moved-up header stays clickable.",
  );
  const railBorderLeftColor = renderer.desktopWindowBarLayout?.railBorderLeftColor ?? "";
  assert.notEqual(railBorderLeftColor, "rgba(0, 0, 0, 0)", "The rail's edge line must draw below the header, not stop at the floating controls.");
  assert.equal(renderer.desktopWindowBarLayout?.railBackgroundColor, "rgba(0, 0, 0, 0)", "The rail must stay transparent over the wallpaper like the other panels.");
  assert.ok(
    Math.abs((renderer.desktopWindowBarLayout?.railTop ?? -1) - (renderer.desktopWindowBarLayout?.columnHeaderHeight ?? -1)) < 1,
    "The rail must start at the column header's bottom edge without a computed offset.",
  );
  const headerRight = renderer.desktopWindowBarLayout?.headerRight;
  const windowWidth = renderer.desktopWindowBarLayout?.windowWidth;
  if (headerRight != null && windowWidth != null) {
    assert.ok(
      Math.abs(headerRight - windowWidth) < 1,
      `The header row must end exactly at the window's right edge (header right ${headerRight}px vs window ${windowWidth}px).`,
    );
  }
  assert.ok(
    (renderer.desktopWindowBarLayout?.documentWidth ?? 0) <= (renderer.desktopWindowBarLayout?.windowWidth ?? 0),
    "The document must never overflow the window horizontally.",
  );
  const junctionGap = renderer.desktopWindowBarLayout?.junctionGap;
  if (junctionGap != null) {
    assert.ok(Math.abs(junctionGap) < 1, `The rail must sit flush under the header with no gap (junction gap ${junctionGap}px).`);
  }
  if (renderer.desktopWindowBarLayout?.agentHeaderActionsClearOfControls != null) {
    assert.equal(renderer.desktopWindowBarLayout.agentHeaderActionsClearOfControls, true, "The agent header actions must not overlap the window controls.");
  }
  const windowControlsCenter = renderer.desktopWindowBarLayout?.controlsCenter;
  if (windowControlsCenter != null) {
    assert.ok(
      Math.abs(windowControlsCenter - (renderer.desktopWindowBarLayout?.columnRowCenter ?? -1)) < 2,
      "The window controls must center on the same line as the header icons.",
    );
    assert.ok(
      Math.abs(windowControlsCenter - (renderer.desktopWindowBarLayout?.sidebarBrandCenter ?? -1)) < 2,
      "The window controls must center on the same line as the sidebar brand icon.",
    );
  }
  const headerControlsGap = renderer.desktopWindowBarLayout?.headerActionsGapToControls;
  if (headerControlsGap != null) {
    assert.ok(headerControlsGap >= 10 && headerControlsGap <= 14, `The header must sit one icon gap away from the window controls (got ${headerControlsGap}px).`);
  }
  assert.equal(renderer.desktopWindowControls, true, "The frameless window bar must carry its own controls (or the macOS traffic-light slot).");
  assert.equal(renderer.desktopWallpaper?.present, true, "The desktop workspace must render the configured wallpaper layer.");
  assert.equal(renderer.desktopWallpaper?.coversWorkspace, true, "The wallpaper layer must cover the full desktop workspace.");
  assert.ok(Math.abs((renderer.desktopWallpaper?.opacity ?? 0) - 0.68) < 0.02, "The default wallpaper must reach its configured visible opacity.");
  assert.ok(renderer.desktopWallpaper?.sidebarPanelOpacity < 0.8, "The sidebar must remain translucent so wallpaper is visible across the desktop workspace.");
  assert.ok(renderer.desktopWallpaper?.messagePanelOpacity < 0.8, "The message list must remain translucent so wallpaper is visible across the desktop workspace.");
  assert.ok(renderer.desktopWallpaper?.readerPanelOpacity < 0.8, "The reader must remain translucent so wallpaper is visible inside the desktop workspace.");
  // -- Agent workspace visibility (regression: the workspace used to render
  // inside the hidden mail-workspace div and came up as an empty 0x0 frame).
  assert.equal(renderer.desktopDeepDiagnostic?.agent?.launchButtonPresent, true, "The Agent launch button must be present in the workspace.");
  assert.equal(renderer.desktopDeepDiagnostic?.agent?.agentRevealed, true, "The Agent workspace must be visible after opening.");
  const agentRect = renderer.desktopDeepDiagnostic?.agent?.agentRect;
  if (agentRect != null) {
    const windowWidth = renderer.desktopWindowBarLayout?.windowWidth;
    if (windowWidth != null) {
      assert.ok(
        Math.abs(agentRect.w - (windowWidth - 56)) < 2,
        `The Agent workspace must fill the shell beside the 56px rail (${agentRect.w}px vs ${windowWidth - 56}px).`,
      );
    }
    assert.ok(agentRect.w > 800 && agentRect.h > 500, `The Agent workspace must have real geometry after opening (${agentRect.w}x${agentRect.h}).`);
  }
  const agentChildren = renderer.desktopDeepDiagnostic?.agent?.agentChildren ?? [];
  assert.ok(agentChildren.length >= 2, "The Agent workspace must contain its conversation sidebar and main panel.");
  assert.ok(agentChildren.every((c) => c.w > 0 && c.h > 0), "The Agent panels must not be zero-sized.");
  const agentShellChild = (renderer.desktopDeepDiagnostic?.agent?.shellChildren ?? []).find(
    (c) => typeof c.className === "string" && c.className.includes("agent-workspace"),
  );
  assert.ok(
    agentShellChild !== undefined && agentShellChild.display !== "none" && agentShellChild.h > 500,
    "The Agent workspace must be a direct shell child rendered at full height.",
  );
  const railAfterOpen = renderer.desktopDeepDiagnostic?.agent?.railAfterOpen;
  if (railAfterOpen != null) {
    assert.equal(railAfterOpen.gridColumn, "2", "The rail must move to the second column when the Agent workspace is open.");
    assert.equal(railAfterOpen.gridRow, "2", "The rail must stay on the second row below the floating bar when the Agent workspace is open.");
    assert.ok(railAfterOpen.rect.h > 500, "The rail must keep its full height beside the Agent workspace.");
  }
  const contextChip = renderer.desktopDeepDiagnostic?.agent?.agentContextChip;
  if (contextChip != null) {
    assert.equal(contextChip.tag, "BUTTON", "The reference mail chip must be a clickable button.");
    assert.ok(contextChip.ariaLabel.length > 0, "The reference mail chip must carry an accessible label.");
    assert.ok(contextChip.railClearance > 0, `The reference mail chip must stay clear of the icon rail (clearance ${contextChip.railClearance}px).`);
    assert.ok(contextChip.panelClearance > 0, `The reference mail chip must stay inside the agent main panel (clearance ${contextChip.panelClearance}px).`);
  }
  const workspacePosition = renderer.desktopDeepDiagnostic?.agent?.workspacePosition;
  if (workspacePosition != null) {
    assert.equal(workspacePosition, "relative", "The Agent workspace must stay a positioned ancestor for its absolutely-positioned children (citations sidebar).");
  }
  const citationsAnchorClearance = renderer.desktopDeepDiagnostic?.agent?.citationsAnchorClearance ?? null;
  if (citationsAnchorClearance != null) {
    assert.ok(citationsAnchorClearance > 0, `A right:14px citation anchor inside the workspace must clear the rail (clearance ${citationsAnchorClearance}px).`);
  }
  // -- Main-thread responsiveness (regression: reported jank on the mail and
  // Agent screens). Hidden smoke windows throttle rAF but not timers, so the
  // timer-gap metric still catches event-loop stalls.
  assert.equal(renderer.desktopDeepDiagnostic?.idle?.longtasks?.length ?? 0, 0, "The idle mail workspace must not run long tasks on the main thread.");
  assert.ok((renderer.desktopDeepDiagnostic?.idle?.timerMaxGapMs ?? 0) < 200, "The idle renderer event loop must stay responsive (max timer gap < 200ms).");
  assert.ok((renderer.desktopDeepDiagnostic?.agent?.afterOpenPerf?.longtasks?.length ?? 99) <= 1, "Opening the Agent workspace must not flood the main thread with long tasks.");
  // -- Mail-list scroll cost (regression: reported jank when scrolling the
  // message list). Each forced layout cycle is one scroll frame's main-thread
  // cost; staying far below the 16.7ms budget keeps scrolling responsive.
  const scrollProbe = renderer.desktopDeepDiagnostic?.scroll;
  if (scrollProbe != null && scrollProbe.note === undefined) {
    assert.ok(scrollProbe.rowCount > 0, "The smoke mail list must carry demo rows for the scroll probe.");
    assert.ok(
      Math.max(...(scrollProbe.frameCostMs ?? [])) < 12,
      `Scroll frames must stay far below the frame budget (max ${Math.max(...(scrollProbe.frameCostMs ?? []))}ms vs 16.7ms budget).`,
    );
  }
  // -- Startup window: the first paint must not regress (measured 1618ms
  // before the window/broker parallelism; 1041ms after; the report carries
  // the exact timeline for the record).
  const windowLoadedStage = (renderer.desktopStartupTimeline ?? []).find((stage) => stage.stage === "window-loaded");
  assert.ok(
    windowLoadedStage !== undefined && windowLoadedStage.elapsedMs < 1150,
    `The window must reach its loaded state during startup (${windowLoadedStage?.elapsedMs ?? "missing"}ms vs 1150ms baseline).`,
  );
  assert.equal(renderer.desktopSettingsUi?.settingsOpened, true, renderer.desktopSettingsUi?.error ?? "The settings dialog did not open.");
  assert.equal(renderer.desktopSettingsUi?.brandName, "Nami Mail", "The sidebar must use the full product name.");
  assert.equal(renderer.desktopSettingsUi?.lightBrandMarkLoaded, true, "The light-theme brand mark must load.");
  assert.equal(renderer.desktopSettingsUi?.darkBrandMarkLoaded, true, "The dark-theme brand mark must load.");
  assert.equal(renderer.desktopSettingsUi?.settingsBackdropFilter, "none", "The settings backdrop must not blur the workspace.");
  assert.match(renderer.desktopSettingsUi?.settingsBackdropColor ?? "", /^rgba\(.+,\s*0\.\d+\)$/, "The settings backdrop must be semi-transparent.");
  assert.equal(renderer.desktopSettingsUi?.confirmationBackdropFilter, "none", "Settings confirmations must not blur the settings dialog.");
  assert.match(renderer.desktopSettingsUi?.confirmationBackdropColor ?? "", /^rgba\(.+,\s*0\.\d+\)$/, "Settings confirmations must use a semi-transparent backdrop.");
  assert.equal(renderer.desktopSettingsUi?.alertUsesAppUi, true, "An oversized wallpaper must open an in-app alert dialog.");
  assert.equal(renderer.desktopSettingsUi?.alertBackdropFilter, "none", "Nested alerts must not blur the settings dialog.");
  assert.match(renderer.desktopSettingsUi?.alertBackdropColor ?? "", /^rgba\(.+,\s*0\.\d+\)$/, "Nested alerts must use a semi-transparent backdrop.");
  assert.match(renderer.desktopSettingsUi?.alertMessage ?? "", /50 MB/, "The oversized wallpaper alert must explain the configured limit.");
  assert.equal(renderer.desktopSettingsUi?.nativeDialogCalls, 0, "The oversized wallpaper path must not call a browser-native dialog.");
  assert.equal(renderer.desktopSettingsUi?.errorToastAbsent, true, "The oversized wallpaper error must not be hidden in a toast.");
  assert.equal(renderer.desktopSettingsUi?.focusTrapped, true, "Keyboard focus must remain inside the oversized wallpaper alert.");
  assert.equal(renderer.desktopSettingsUi?.alertDismissedWithEscape, true, "Escape must dismiss the oversized wallpaper alert.");
  assert.equal(renderer.desktopSettingsUi?.settingsStillOpenAfterEscape, true, "Dismissal must return to the settings dialog instead of closing it.");
  assert.equal(renderer.desktopSettingsUi?.focusRestoredToUpload, true, "Dismissal must restore focus to the wallpaper upload control.");
  assert.equal(renderer.desktopSettingsUi?.displayTextUnselectable, true, "Application display text must not be selectable.");
  assert.equal(renderer.desktopSettingsUi?.editableTextSelectable, true, "Editable controls must keep normal text selection.");
  assert.equal(renderer.desktopSettingsUi?.updateStatusPresent, true, "Desktop settings must render the software update status.");
  assert.match(renderer.desktopSettingsUi?.updateStatusText ?? "", new RegExp(`当前版本.*v${packageManifest.version.replace(/\./g, "\\.")}.*自动更新`, "s"), "Desktop settings must explain the current update state.");
  assert.equal(renderer.desktopSettingsUi?.updateActionCount, 0, "A disabled update channel must not expose a misleading check button.");
  assert.equal(renderer.desktopSettingsSync?.error, undefined, renderer.desktopSettingsSync?.error ?? "Desktop settings synchronization failed.");
  assert.equal(renderer.desktopSettingsSync?.initialCloseBehavior, "ask", "A fresh settings dialog must show the ask behavior.");
  assert.equal(renderer.desktopSettingsSync?.updatedCloseBehavior, "tray", "A native close preference write must refresh an open settings dialog.");
  assert.equal(renderer.desktopSettingsSync?.restoredCloseBehavior, "ask", "Restoring the desktop window must refresh settings from the local service.");
  assert.equal(renderer.desktopClosePrompt?.error, undefined, renderer.desktopClosePrompt?.error ?? "Desktop close prompt smoke failed.");
  assert.equal(renderer.desktopClosePrompt?.initialCloseBehavior, "ask", "A fresh desktop profile must ask how to close its first window.");
  assert.equal(renderer.desktopClosePrompt?.cancel.eventPrevented, true, "Canceling the native close prompt must keep the window close event prevented.");
  assert.equal(renderer.desktopClosePrompt?.cancel.simulatedNativeDialogCalls, 1, "Canceling must invoke the native close prompt once.");
  assert.equal(renderer.desktopClosePrompt?.cancel.closeBehavior, "ask", "Canceling the native close prompt must not change the close preference.");
  assert.equal(renderer.desktopClosePrompt?.cancel.quitRequested, false, "Canceling the native close prompt must not request application shutdown.");
  assert.equal(renderer.desktopClosePrompt?.minimizeAndRemember.eventPrevented, true, "Minimize-to-tray must use the close event handler.");
  assert.equal(renderer.desktopClosePrompt?.minimizeAndRemember.simulatedNativeDialogCalls, 1, "Minimize-to-tray must invoke the native close prompt once.");
  assert.equal(renderer.desktopClosePrompt?.minimizeAndRemember.closeBehavior, "tray", "Remembering minimize-to-tray must persist the tray close preference.");
  assert.equal(renderer.desktopClosePrompt?.minimizeAndRemember.trayCreated, true, "Minimize-to-tray must create a tray entry.");
  assert.equal(renderer.desktopClosePrompt?.minimizeAndRemember.windowHidden, true, "Minimize-to-tray must hide the main window.");
  assert.equal(renderer.desktopClosePrompt?.minimizeAndRemember.quitRequested, false, "Minimize-to-tray must not request application shutdown.");
  assert.equal(renderer.desktopClosePrompt?.quitAndRemember.eventPrevented, true, "Quit must use the close event handler.");
  assert.equal(renderer.desktopClosePrompt?.quitAndRemember.simulatedNativeDialogCalls, 1, "Quit must invoke the native close prompt once.");
  assert.equal(renderer.desktopClosePrompt?.quitAndRemember.closeBehavior, "quit", "Remembering quit must persist the quit close preference.");
  assert.equal(renderer.desktopClosePrompt?.quitAndRemember.quitRequested, true, "The quit selection must request application shutdown.");
  assert.equal(renderer.desktopClosePrompt?.finalCloseBehavior, "ask", "The close prompt smoke must restore its isolated profile to ask before bounded shutdown.");
  assert.equal(renderer.desktopLifecycle?.error, undefined, renderer.desktopLifecycle?.error ?? "Desktop lifecycle smoke failed.");
  assert.equal(renderer.desktopLifecycle?.appUserModelId, configuredExecutable ? "com.nami.mail" : "com.nami.mail.dev");
  assert.equal(renderer.desktopLifecycle?.closeBehavior, "ask", "A fresh desktop profile must ask how to close the window.");
  assert.ok(renderer.desktopLifecycle?.iconWidth >= 16 && renderer.desktopLifecycle?.iconHeight >= 16, "The desktop icon must be loadable.");
  assert.equal(renderer.desktopLifecycle?.trayCreated, true, "The system tray entry must be creatable before the window can be hidden.");
  assert.equal(renderer.desktopUpdate?.phase, "unavailable", "Desktop smoke must not contact the live GitHub update channel.");
  assert.equal(renderer.desktopUpdate?.currentVersion, packageManifest.version, "The updater must report the packaged application version.");
  assert.equal(renderer.desktopUpdate?.reason, "disabled", "The updater must explain why live checks are disabled during smoke.");
  assert.equal(renderer.desktopApiAvailable, true);
  assert.equal(renderer.desktopNotificationTest?.invoked, true, renderer.desktopNotificationTest?.error ?? "Desktop notification bridge was not invoked.");
  assert.equal(typeof renderer.desktopNotificationTest?.shown, "boolean");
  const localApiSmoke = renderer.desktopLocalApiSmoke;
  assert.equal(localApiSmoke?.error, undefined, localApiSmoke?.error ?? "Desktop local API smoke did not run.");
  assert.equal(localApiSmoke?.googleAvailable, true, "Desktop user-data OAuth configuration must enable Google login.");
  assert.equal(localApiSmoke?.microsoftAvailable, true, "Desktop user-data OAuth configuration must enable Microsoft login.");
  const cacheProtection = renderer.desktopCacheProtection;
  assert.equal(cacheProtection?.cleanup?.httpCacheCleared, true, "Desktop startup must clear historical renderer HTTP cache before loading mail UI.");
  assert.deepEqual(
    cacheProtection?.cleanup?.storageTypesCleared,
    ["cachestorage", "serviceworkers"],
    "Desktop startup must clear only legacy mail-capable CacheStorage and Service Worker data.",
  );
  assert.equal(cacheProtection?.localApiPolicyInstalled, true, "Desktop must install the exact-origin local API no-store policy.");
  assert.equal(cacheProtection?.responseNoStoreObserved, true, "Desktop local API responses must be observed with Cache-Control: no-store.");
  assert.match(cacheProtection?.responseCacheControl ?? "", /(?:^|,)\s*no-store\s*(?:,|$)/i);
  report.desktopOAuthConfiguration = {
    googleAvailable: localApiSmoke.googleAvailable,
    microsoftAvailable: localApiSmoke.microsoftAvailable,
    googleRedirectUri: localApiSmoke.googleRedirectUri,
    microsoftRedirectUri: localApiSmoke.microsoftRedirectUri,
  };
  const oauthStartedAt = Date.now();
  assert.equal(localApiSmoke.googleClientId, smokeGoogleOAuthClientId);
  assert.equal(localApiSmoke.microsoftClientId, smokeMicrosoftOAuthClientId);
  assert.equal(localApiSmoke.microsoftAuthorizationPathname, `/${smokeMicrosoftTenant}/oauth2/v2.0/authorize`);
  for (const [provider, expiresAt] of [["Google", localApiSmoke.googleExpiresAt], ["Microsoft", localApiSmoke.microsoftExpiresAt]]) {
    const remainingSeconds = (Date.parse(expiresAt) - oauthStartedAt) / 1_000;
    assert.ok(
      remainingSeconds >= smokeOAuthFlowTtlSeconds - 15 && remainingSeconds <= smokeOAuthFlowTtlSeconds + 5,
      `${provider} OAuth expiry must use the user-data TTL configuration.`,
    );
  }
  assert.equal(localApiSmoke.googleRedirectUri, `http://127.0.0.1:${runtimePort}/api/oauth/google/callback`);
  assert.equal(localApiSmoke.microsoftRedirectUri, `http://localhost:${runtimePort}/api/oauth/microsoft/callback`);
  const rendererResponse = await fetchRenderer(renderer.rendererUrl);
  assert.match(rendererResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  report.contentSecurityPolicy = true;
  await fs.access(path.join(temporaryUserData, "data", "nami-mail.db"));
  await fs.access(path.join(temporaryUserData, "data", "master.key.dpapi"));
  await assert.rejects(
    fs.access(path.join(temporaryUserData, "data", "master.key")),
    { code: "ENOENT" },
    "Desktop startup must not leave a plaintext master key in userData.",
  );

  report.isolatedDataDirectory = true;
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const exitedGracefully = await waitForDesktopProcessExit(desktopProcess, gracefulExitTimeoutMs);
  assert.equal(exitedGracefully, true, "Electron must finish its own bounded shutdown without smoke cleanup terminating it.");
  report.gracefulExit = true;
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} catch (error) {
  primaryFailure = error;
  await writeDesktopSmokeDiagnostic(error, progressPath, desktopProcess, desktopOutputCapture).catch((diagnosticError) => {
    const message = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    process.stderr.write(`Desktop smoke could not write its diagnostic: ${message}\n`);
  });
  throw error;
} finally {
  let cleanupFailure;
  try {
    const stopped = desktopProcess
      ? await stopDesktopProcess(desktopProcess, desktopProcessIds)
      : true;
    const cleaned = stopped && await removeTemporaryUserData();
    if (!stopped || !cleaned) {
      cleanupFailure = new Error(
        `Desktop smoke cleanup did not complete: processStopped=${stopped}, userDataRemoved=${cleaned}, trackedPids=${[...desktopProcessIds].join(",")}.`,
      );
    }
  } catch (error) {
    cleanupFailure = error;
  }
  if (cleanupFailure) {
    if (primaryFailure) process.stderr.write(`Desktop smoke cleanup failed: ${cleanupFailure.message}\n`);
    else {
      await writeDesktopSmokeDiagnostic(cleanupFailure, progressPath, desktopProcess, desktopOutputCapture).catch((diagnosticError) => {
        const message = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
      process.stderr.write(`Desktop smoke could not write its diagnostic: ${message}\n`);
      });
      // Cleanup errors only surface when the smoke itself did not already fail.
      // eslint-disable-next-line no-unsafe-finally
      throw cleanupFailure;
    }
  }
}
