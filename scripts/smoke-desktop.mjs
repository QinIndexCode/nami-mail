import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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
const gracefulExitTimeoutMs = 10_000;
const forcedExitTimeoutMs = 10_000;

async function waitForResult(resultPath, processHandle) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error("Electron exited before writing its smoke result.");
    }
    try {
      return JSON.parse(await fs.readFile(resultPath, "utf8"));
    } catch {
      // Electron needs a short moment to create the renderer and inspect its DOM.
    }
    await delay(200);
  }
  throw new Error("Electron did not write a smoke result within 45 seconds.");
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

try {
  await fs.access(electronExecutable);
  const resultPath = path.join(temporaryUserData, "smoke-result.json");
  desktopProcess = spawn(electronExecutable, desktopArguments, {
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

  const renderer = await waitForResult(resultPath, desktopProcess);
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
    [["desktop", "1"], ["desktopSmoke", "1"]],
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
  assert.equal(renderer.simulatedWebFrameVisible, false, "The desktop renderer must not include the Web macOS demonstration frame.");
  assert.equal(renderer.desktopWallpaper?.present, true, "The desktop workspace must render the configured wallpaper layer.");
  assert.equal(renderer.desktopWallpaper?.coversWorkspace, true, "The wallpaper layer must cover the full desktop workspace.");
  assert.ok(Math.abs((renderer.desktopWallpaper?.opacity ?? 0) - 0.68) < 0.02, "The default wallpaper must reach its configured visible opacity.");
  assert.ok(renderer.desktopWallpaper?.sidebarPanelOpacity < 0.8, "The sidebar must remain translucent so wallpaper is visible across the desktop workspace.");
  assert.ok(renderer.desktopWallpaper?.messagePanelOpacity < 0.8, "The message list must remain translucent so wallpaper is visible across the desktop workspace.");
  assert.ok(renderer.desktopWallpaper?.readerPanelOpacity < 0.8, "The reader must remain translucent so wallpaper is visible inside the desktop workspace.");
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
  const rendererResponse = await fetch(renderer.rendererUrl);
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
    else throw cleanupFailure;
  }
}
