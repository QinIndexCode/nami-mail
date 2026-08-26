import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveInstallerSmokeBaseDirectory } from "./installer-smoke-location.mjs";
import { resolveReleaseDirectory } from "./release-policy.mjs";
import { writeSmokeDiagnostic } from "./smoke-diagnostics.mjs";

if (process.platform !== "win32") {
  throw new Error("The installer smoke test can only run on Windows.");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(projectRoot, "output", "installer-smoke.json");
const diagnosticReportPath = path.join(projectRoot, "output", "installer-smoke-diagnostic.json");
let installerSmokeStage = "initializing";

async function writeInstallerSmokeDiagnostic(error) {
  await writeSmokeDiagnostic({
    filePath: diagnosticReportPath,
    stage: installerSmokeStage,
    error,
  });
}

async function main() {
  await fs.rm(diagnosticReportPath, { force: true });
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseDirectory = resolveReleaseDirectory(projectRoot);
const appId = packageManifest.build?.appId;
const productName = packageManifest.build?.productName;
const cliLauncherSourcePath = path.join(projectRoot, "build", "namimail.cmd");
const cliPathHelperPath = path.join(projectRoot, "build", "namimail-path.ps1");
const agentPipeSourcePath = path.join(projectRoot, "apps", "desktop", "resources", "nami-agent-pipe.ps1");
const expectedInstallerName = `Nami Mail Setup ${packageManifest.version}.exe`;
const expectedInstallerOverride = process.env.NAMI_MAIL_EXPECTED_INSTALLER?.trim();
const packageStartedAt = Number.parseInt(process.env.NAMI_MAIL_PACKAGE_STARTED_AT ?? "", 10);
const execFileAsync = promisify(execFile);
// build/installer.nsh `customInit` refuses a silent downgrade (and any
// /allusers machine-wide invocation) with SetErrorLevel 3.
const nsisDowngradeBlockedExitCode = 3;
// The nested desktop smoke owns a 90-second diagnostic deadline and bounded
// cleanup. Keep this supervisor beyond that window so its failure is preserved.
const installedDesktopSmokeSupervisorTimeoutMs = 150_000;
const powerShellProbeTimeoutMs = 15_000;

assert.equal(typeof appId, "string", "package.json build.appId is required for installer safety checks.");
assert.equal(typeof productName, "string", "package.json build.productName is required for installer safety checks.");
assert.equal(productName, "Nami Mail", "The installer data-deletion target must match Electron's production userData name.");

// electron-builder NSIS derives the uninstall registry key from
// UUID.v5(appId, the fixed electron-builder namespace UUID) — not from the
// appId itself — so the smoke must probe for that GUID key as well.
const expectedUninstallKey = electronBuilderUninstallKey(appId);

await fs.access(cliLauncherSourcePath);
await fs.access(cliPathHelperPath);
await fs.access(agentPipeSourcePath);

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveInstaller() {
  const target = path.resolve(expectedInstallerOverride ?? path.join(releaseDirectory, expectedInstallerName));
  assert.equal(
    path.relative(releaseDirectory, target),
    expectedInstallerName,
    `Installer smoke must use ${path.join("release", expectedInstallerName)}.`,
  );
  return target;
}

function powerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

// Mirrors app-builder-lib NsisTarget.buildInstaller: the NSIS uninstall
// registry key is UUID.v5(appId, the electron-builder namespace UUID
// "50e065bc-3134-11e6-9bab-38c9862bdaf3").
function electronBuilderUninstallKey(appId) {
  const namespace = Buffer.from("50e065bc-3134-11e6-9bab-38c9862bdaf3".replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespace).update(appId, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x50; // RFC 4122 version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  return digest.subarray(0, 16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function assertUninstallRecordKey(key) {
  assert.ok(
    key === appId || key === expectedUninstallKey,
    `The uninstall record key ${JSON.stringify(key)} must be the appId (${appId}) or the electron-builder NSIS GUID key (${expectedUninstallKey}).`,
  );
}

const powerShellExecutable = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

async function currentUserPathRecord() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
    "if ($null -eq $key) { throw 'The current-user Environment registry key is unavailable.' }",
    "try { $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $exists = $null -ne $value; [pscustomobject]@{ exists = $exists; value = if ($exists) { [string]$value } else { $null }; kind = if ($exists) { [string]$key.GetValueKind('Path') } else { $null } } | ConvertTo-Json -Compress } finally { $key.Dispose() }",
  ].join("; ");
  const { stdout } = await execFileAsync(powerShellExecutable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: powerShellProbeTimeoutMs,
    windowsHide: true,
  });
  const record = JSON.parse(stdout.trim());
  assert.equal(typeof record?.exists, "boolean", "The current-user Path record is invalid.");
  assert.ok(record.value === null || typeof record.value === "string", "The current-user Path value is invalid.");
  assert.ok(record.kind === null || typeof record.kind === "string", "The current-user Path registry type is invalid.");
  return record;
}

function cliPathOccurrences(pathRecord, installPath) {
  if (!pathRecord.exists || typeof pathRecord.value !== "string") return 0;
  const expected = installPath.toLowerCase();
  return pathRecord.value
    .split(";")
    .filter((segment) => segment.toLowerCase() === expected)
    .length;
}

function assertCliPathRegistered(pathRecord, installPath) {
  assert.equal(cliPathOccurrences(pathRecord, installPath), 1, "The current-user Path must include exactly one Nami Mail installation directory.");
}

function assertCliPathRemoved(pathRecord, installPath) {
  assert.equal(cliPathOccurrences(pathRecord, installPath), 0, "Nami Mail uninstall must remove only its exact installation directory from the current-user Path.");
}

async function removeCliPathFallback(installPath) {
  await execFileAsync(powerShellExecutable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cliPathHelperPath, "-Action", "unregister", "-CliPath", installPath], {
    timeout: powerShellProbeTimeoutMs,
    windowsHide: true,
  });
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function smokeInstalledCli(launcher, pathRecord, version) {
  assert.equal(pathRecord.exists, true, "Nami Mail installation did not register a current-user Path value.");
  assert.equal(typeof pathRecord.value, "string", "Nami Mail installation registered an invalid current-user Path value.");
  const commandEnvironment = { ...process.env };
  for (const key of Object.keys(commandEnvironment)) {
    if (key.toLowerCase() === "path") delete commandEnvironment[key];
  }
  commandEnvironment.Path = pathRecord.value;
  const commandProcessor = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const { stdout, stderr } = await execFileAsync(
    commandProcessor,
    ["/d", "/s", "/c", "where namimail.cmd && namimail --version"],
    {
      cwd: path.dirname(path.dirname(launcher)),
      env: commandEnvironment,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  const outputLines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(outputLines.length >= 2, `Installed CLI smoke produced incomplete output.${stderr ? ` ${stderr.trim()}` : ""}`);
  assert.equal(path.resolve(outputLines[0]), path.resolve(launcher), "The registered Path did not resolve namimail to the installed launcher.");
  assert.match(stdout, new RegExp(`\\b${escapeRegularExpression(version)}\\b`), "The installed CLI --version output did not report package.json version.");
  return {
    launcher: "namimail.cmd",
    version,
  };
}

const smokeMcpProtocolVersion = "2025-03-26";

async function smokeInstalledMcp(launcher, pathRecord) {
  assert.equal(pathRecord.exists, true, "Nami Mail installation did not register a current-user Path value.");
  assert.equal(typeof pathRecord.value, "string", "Nami Mail installation registered an invalid current-user Path value.");
  const commandEnvironment = { ...process.env };
  for (const key of Object.keys(commandEnvironment)) {
    if (key.toLowerCase() === "path") delete commandEnvironment[key];
  }
  commandEnvironment.Path = pathRecord.value;
  const commandProcessor = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const initializeRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: smokeMcpProtocolVersion } });
  const initializedNotification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const toolsListRequest = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const child = spawn(commandProcessor, ["/d", "/s", "/c", "namimail mcp start"], {
    cwd: path.dirname(path.dirname(launcher)),
    env: commandEnvironment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutLines = [];
  let stderrText = "";
  let stdoutPending = "";
  child.stdout.on("data", (chunk) => {
    stdoutPending += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutPending.indexOf("\n")) !== -1) {
      const line = stdoutPending.slice(0, newlineIndex).trim();
      stdoutPending = stdoutPending.slice(newlineIndex + 1);
      if (line) stdoutLines.push(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  child.stdin.write(`${initializeRequest}\n`);
  child.stdin.write(`${initializedNotification}\n`);
  child.stdin.write(`${toolsListRequest}\n`);
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("MCP stdio smoke timed out waiting for the child process to exit."));
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  if (stdoutPending.trim()) stdoutLines.push(stdoutPending.trim());
  assert.equal(exitCode, 0, `MCP stdio smoke exited with ${exitCode}.${stderrText ? ` ${stderrText.trim()}` : ""}`);
  assert.ok(stdoutLines.length >= 2, `MCP stdio smoke produced incomplete output.${stderrText ? ` ${stderrText.trim()}` : ""}`);
  const responses = stdoutLines.map((line) => JSON.parse(line));
  const initializeResponse = responses.find((candidate) => candidate?.id === 1 && candidate.result);
  assert.ok(initializeResponse, "MCP initialize did not return a result.");
  assert.equal(initializeResponse.result.protocolVersion, smokeMcpProtocolVersion, "MCP initialize did not echo the supported protocol version.");
  assert.equal(initializeResponse.result.serverInfo?.name, "NamiMail", "MCP initialize serverInfo name must be NamiMail.");
  const toolsListResponse = responses.find((candidate) => candidate?.id === 2 && candidate.result);
  assert.ok(toolsListResponse, "MCP tools/list did not return a result.");
  assert.ok(Array.isArray(toolsListResponse.result.tools), "MCP tools/list must return a tools array.");
  // The External Mail v1 surface exposes eight read-only tools (accounts,
  // folders, messages, summarize, message get, batch get, threads,
  // attachments) plus seven write tools (draft create/update/delete, move,
  // set-flag, send, reply); the desktop agent-mcp unit test pins the same
  // fifteen-name contract.
  const tools = toolsListResponse.result.tools;
  const readTools = tools.filter((tool) => tool?.annotations?.readOnlyHint === true);
  const writeTools = tools.filter((tool) => tool?.annotations?.readOnlyHint === false);
  assert.equal(tools.length, 15, "MCP tools/list must return exactly fifteen External Mail v1 tools.");
  assert.equal(readTools.length, 8, "MCP tools/list must return exactly eight read-only tools.");
  assert.equal(writeTools.length, 7, "MCP tools/list must return exactly seven write tools.");
  assert.equal(
    writeTools.find((tool) => tool?.name === "namimail_draft_delete")?.annotations?.destructiveHint,
    true,
    "The MCP draft-delete write tool must declare destructiveHint.",
  );
  return {
    protocolVersion: smokeMcpProtocolVersion,
    toolCount: toolsListResponse.result.tools.length,
    exitCode,
  };
}

async function existingNamiMailInstallations() {
  const keyCandidates = [appId, expectedUninstallKey];
  const keyCandidatesExpression = keyCandidates.map((candidate) => `'${powerShellLiteral(candidate)}'`).join(", ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$keyCandidates = @(${keyCandidatesExpression})`,
    "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')",
    "$namiInstallations = foreach ($root in $roots) { if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root | ForEach-Object { $properties = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; if (($keyCandidates -contains $_.PSChildName) -and $properties.DisplayName -like '" + powerShellLiteral(productName) + "*') { [pscustomobject]@{ Key = $_.PSChildName; RegistryPath = $_.PSPath; DisplayName = $properties.DisplayName; DisplayVersion = $properties.DisplayVersion; Publisher = $properties.Publisher; InstallLocation = $properties.InstallLocation; UninstallString = $properties.UninstallString } } } } }",
    "@($namiInstallations) | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: powerShellProbeTimeoutMs,
    windowsHide: true,
  });
  const value = stdout.trim();
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function setInstalledVersion(installation, version) {
  assert.equal(typeof installation?.RegistryPath, "string", "The test installation registry path is unavailable.");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Set-ItemProperty -LiteralPath '${powerShellLiteral(installation.RegistryPath)}' -Name DisplayVersion -Value '${powerShellLiteral(version)}'`,
    `(Get-ItemProperty -LiteralPath '${powerShellLiteral(installation.RegistryPath)}').DisplayVersion`,
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: powerShellProbeTimeoutMs,
    windowsHide: true,
  });
  assert.equal(stdout.trim(), version, "The installer smoke could not stage its isolated version branch.");
}

async function assertIsolatedInstallationVersion(expectedVersion, expectedUninstaller) {
  const installations = await existingNamiMailInstallations();
  assert.equal(installations.length, 1, "The isolated installation must keep exactly one Nami Mail uninstall record.");
  assertUninstallRecordKey(installations[0].Key);
  assert.equal(installations[0].DisplayVersion, expectedVersion, "The uninstall record did not return to the packaged version.");
  assert.equal(
    path.resolve(registeredUninstallExecutablePath(installations[0])),
    path.resolve(expectedUninstaller),
    "The installer modified an uninstall record outside its isolated directory.",
  );
  return installations[0];
}

function registeredUninstallExecutablePath(installation) {
  assert.equal(typeof installation?.UninstallString, "string", "The test installation uninstall command is unavailable.");
  const match = installation.UninstallString.match(/"([^"]+\.exe)"/i);
  assert.ok(match?.[1], "The test installation uninstall command must reference the NSIS uninstaller executable.");
  return match[1];
}

async function expectInstallerExitCode(installer, args, expectedExitCode) {
  try {
    await execFileAsync(installer, args, {
      cwd: projectRoot,
      timeout: 120_000,
      windowsHide: true,
    });
  } catch (error) {
    assert.equal(error?.code, expectedExitCode, `Installer exited with ${String(error?.code)} instead of ${expectedExitCode}.`);
    return;
  }
  assert.fail(`Installer unexpectedly succeeded; expected exit code ${expectedExitCode}.`);
}

// The NSIS uninstaller removes the installed payload synchronously and then
// schedules its own final cleanup, so give the async directory check a
// generous window on slow runners.
async function waitForAbsent(target) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (!await exists(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !await exists(target);
}

async function runningNamiMailPids() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$pids = @([System.Diagnostics.Process]::GetProcessesByName('Nami Mail') | ForEach-Object { [int]$_.Id } | Sort-Object)",
    "ConvertTo-Json -InputObject $pids -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: powerShellProbeTimeoutMs,
    windowsHide: true,
  });
  const value = stdout.trim();
  if (!value) return [];
  const parsed = JSON.parse(value);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((pid) => String(pid)).sort();
}

async function waitForNamiMailPids(expectedPids, description) {
  const deadline = Date.now() + 20_000;
  let currentPids = await runningNamiMailPids();
  while (JSON.stringify(currentPids) !== JSON.stringify(expectedPids) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    currentPids = await runningNamiMailPids();
  }
  assert.deepEqual(currentPids, expectedPids, `${description} left Nami Mail processes running.`);
}

async function smokeInstalledExecutable(executable) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(projectRoot, "scripts", "smoke-desktop.mjs")],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NAMI_MAIL_DESKTOP_EXECUTABLE: executable,
      },
      timeout: installedDesktopSmokeSupervisorTimeoutMs,
      windowsHide: true,
    },
  );
  assert.ok(stdout.trim(), `Installed desktop smoke produced no output.${stderr ? ` ${stderr.trim()}` : ""}`);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Installed desktop smoke did not return JSON: ${stdout.trim()}`);
  }
  assert.equal(result.title, "Nami Mail");
  assert.equal(result.desktopApiAvailable, true);
  assert.equal(result.isolatedDataDirectory, true);
  assert.equal(result.contentSecurityPolicy, true);
  return result;
}

async function runUninstaller(uninstallerExecutable) {
  // /S silences the uninstaller. Without _?=, NSIS copies the uninstaller to
  // $TEMP before running, so that copy can delete the original executable and
  // the whole installation directory; with _?= the in-place uninstaller can
  // never remove itself and its directory would survive. The smoke has already
  // asserted there is exactly one isolated Nami Mail uninstall record, so the
  // registry-resolved $INSTDIR is guaranteed to be this test installation.
  await execFileAsync(uninstallerExecutable, ["/S"], {
    cwd: projectRoot,
    timeout: 180_000,
    windowsHide: true,
  });
}

const installerSmokeBaseDirectory = resolveInstallerSmokeBaseDirectory(projectRoot);
await fs.mkdir(installerSmokeBaseDirectory, { recursive: true });
const temporaryRoot = await fs.mkdtemp(path.join(installerSmokeBaseDirectory, "nami-mail-installer-"));
installerSmokeStage = "prepared";
const installDirectory = path.join(temporaryRoot, "app");
let uninstaller;
let installationCreated = false;
let uninstallVerified = false;
let sameVersionSilentReinstall = false;
let lowerVersionSilentUpgrade = false;
let higherVersionSilentDowngradeBlocked = false;
let explicitSilentDowngrade = false;
let cliPathRegistered = false;
let cliPathRemoved = false;
let cliVersionSmoke;
let mcpSmoke;
let pathBeforeInstall;

try {
  const installer = await resolveInstaller();
  const installerStat = await fs.stat(installer);
  assert.ok(installerStat.size > 1_000_000, "Windows installer is unexpectedly small.");
  if (Number.isFinite(packageStartedAt)) {
    assert.ok(
      installerStat.mtimeMs >= packageStartedAt,
      `Installer predates this package run: ${new Date(installerStat.mtimeMs).toISOString()}`,
    );
  }
  const existingInstallations = await existingNamiMailInstallations();
  assert.equal(
    existingInstallations.length,
    0,
    `Refusing installer smoke because an existing ${appId} installation was found: ${JSON.stringify(existingInstallations)}`,
  );
  const processesBefore = await runningNamiMailPids();
  assert.equal(processesBefore.length, 0, "Refusing installer smoke while another Nami Mail process is running.");
  pathBeforeInstall = await currentUserPathRecord();

  // The NSIS assisted installer accepts the standard silent flag; /D= is a
  // trailing final argument (same convention as NSIS).
  installerSmokeStage = "initial-install";
  await execFileAsync(installer, ["/S", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 180_000,
    windowsHide: true,
  });
  installationCreated = true;

  const installedExecutable = path.join(installDirectory, "Nami Mail.exe");
  const installedCliLauncher = path.join(installDirectory, "namimail.cmd");
  const installedCliPathHelper = path.join(installDirectory, "namimail-path.ps1");
  const installedAgentPipe = path.join(installDirectory, "resources", "nami-agent-pipe.ps1");
  await fs.access(installedExecutable);
  await fs.access(installedCliLauncher);
  await fs.access(installedCliPathHelper);
  await fs.access(installedAgentPipe);
  assert.deepEqual(
    await fs.readFile(installedCliLauncher),
    await fs.readFile(cliLauncherSourcePath),
    "The installed CLI launcher must match the source build/namimail.cmd.",
  );
  assert.deepEqual(
    await fs.readFile(installedAgentPipe),
    await fs.readFile(agentPipeSourcePath),
    "The installed Agent named-pipe helper must match the desktop resource source.",
  );
  // electron-builder NSIS generates a fixed uninstaller named
  // "Uninstall ${productName}.exe" next to the installed executable.
  uninstaller = path.join(installDirectory, "Uninstall Nami Mail.exe");
  await fs.access(uninstaller);
  const pathAfterInitialInstall = await currentUserPathRecord();
  assertCliPathRegistered(pathAfterInitialInstall, installDirectory);
  cliPathRegistered = true;
  installerSmokeStage = "installed-cli-smoke";
  cliVersionSmoke = await smokeInstalledCli(installedCliLauncher, pathAfterInitialInstall, packageManifest.version);
  await waitForNamiMailPids(processesBefore, "Installed CLI smoke");
  installerSmokeStage = "installed-mcp-smoke";
  mcpSmoke = await smokeInstalledMcp(installedCliLauncher, pathAfterInitialInstall);
  await waitForNamiMailPids(processesBefore, "Installed MCP smoke");
  const testInstallations = await existingNamiMailInstallations();
  assert.equal(testInstallations.length, 1, "The isolated installation must create exactly one Nami Mail uninstall record.");
  assertUninstallRecordKey(testInstallations[0].Key);
  assert.match(testInstallations[0].DisplayName ?? "", /^Nami Mail(?:\s|$)/, "The uninstall record must identify Nami Mail.");
  assert.equal(testInstallations[0].Publisher, packageManifest.author, "The uninstall record publisher must match package.json.");
  assert.equal(
    path.resolve(registeredUninstallExecutablePath(testInstallations[0])),
    path.resolve(uninstaller),
    "The version-branch test must only modify the uninstall record for its isolated Nami Mail installation.",
  );

  installerSmokeStage = "version-branches";
  await setInstalledVersion(testInstallations[0], "99.0.0");
  await expectInstallerExitCode(installer, ["/S", `/D=${installDirectory}`], nsisDowngradeBlockedExitCode);
  const blockedInstallations = await existingNamiMailInstallations();
  assert.equal(blockedInstallations.length, 1);
  assert.equal(blockedInstallations[0].DisplayVersion, "99.0.0", "A blocked downgrade must not rewrite the installation record.");
  higherVersionSilentDowngradeBlocked = true;

  await setInstalledVersion(testInstallations[0], "0.0.1");
  await execFileAsync(installer, ["/S", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 180_000,
    windowsHide: true,
  });
  await assertIsolatedInstallationVersion(packageManifest.version, uninstaller);
  lowerVersionSilentUpgrade = true;

  const upgradedInstallations = await existingNamiMailInstallations();
  assert.equal(upgradedInstallations.length, 1);
  await setInstalledVersion(upgradedInstallations[0], "99.0.0");
  await execFileAsync(installer, ["/S", "--nami-allow-downgrade", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 180_000,
    windowsHide: true,
  });
  await assertIsolatedInstallationVersion(packageManifest.version, uninstaller);
  explicitSilentDowngrade = true;

  // NSIS silent reinstalls are idempotent: the same-version reinstall must
  // perform a real overwrite and restore the packaged executable.
  const pristineExecutableBytes = (await fs.stat(installedExecutable)).size;
  await fs.writeFile(installedExecutable, "nami-installer-smoke-corruption", "utf8");
  assert.ok((await fs.stat(installedExecutable)).size < pristineExecutableBytes);
  await execFileAsync(installer, ["/S", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 180_000,
    windowsHide: true,
  });
  await assertIsolatedInstallationVersion(packageManifest.version, uninstaller);
  assert.equal((await fs.stat(installedExecutable)).size, pristineExecutableBytes, "Same-version reinstall did not restore the packaged executable.");
  sameVersionSilentReinstall = true;

  // The reinstall regenerated the NSIS uninstaller; verify it is present.
  await fs.access(uninstaller);
  await fs.access(installedExecutable);
  const pathAfterReinstall = await currentUserPathRecord();
  assertCliPathRegistered(pathAfterReinstall, installDirectory);

  installerSmokeStage = "installed-desktop-smoke";
  const desktopSmoke = await smokeInstalledExecutable(installedExecutable);
  installerSmokeStage = "uninstall";
  await runUninstaller(uninstaller);
  assert.equal(await waitForAbsent(installDirectory), true, "The NSIS uninstaller did not remove the test installation directory.");
  await waitForNamiMailPids(processesBefore, "Installer smoke");
  assert.deepEqual(await existingNamiMailInstallations(), [], "The NSIS uninstall left a Nami Mail uninstall record behind.");
  const pathAfterUninstall = await currentUserPathRecord();
  assertCliPathRemoved(pathAfterUninstall, installDirectory);
  assert.deepEqual(pathAfterUninstall, pathBeforeInstall, "Nami Mail uninstall did not restore the original current-user Path record.");
  cliPathRemoved = true;
  uninstallVerified = true;

  const report = {
    checkedAt: new Date().toISOString(),
    installer: path.relative(projectRoot, installer),
    installerBytes: installerStat.size,
    installedExecutable: "Nami Mail.exe",
    desktopSmoke,
    cliVersionSmoke,
    mcpSmoke,
    cliPathRegistered,
    cliPathRemoved,
    sameVersionSilentReinstall,
    lowerVersionSilentUpgrade,
    higherVersionSilentDowngradeBlocked,
    explicitSilentDowngrade,
    downgradeBlockedExitCode: nsisDowngradeBlockedExitCode,
    uninstalled: true,
    noNewNamiMailProcesses: true,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} finally {
  if (!installationCreated && await exists(installDirectory)) {
    const entries = await fs.readdir(installDirectory).catch(() => []);
    if (entries.includes("Uninstall Nami Mail.exe")) {
      uninstaller = path.join(installDirectory, "Uninstall Nami Mail.exe");
    }
    installationCreated = entries.length > 0;
  }
  if (installationCreated && !uninstallVerified && uninstaller && await exists(uninstaller)) {
    try {
      await runUninstaller(uninstaller);
      uninstallVerified = await waitForAbsent(installDirectory);
    } catch {
      uninstallVerified = false;
    }
  }
  try {
    await removeCliPathFallback(installDirectory);
  } catch (error) {
    process.stderr.write(`Installer smoke could not remove its CLI PATH entry: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (uninstallVerified || !installationCreated) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    await fs.rmdir(installerSmokeBaseDirectory).catch((error) => {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
    });
  } else {
    process.stderr.write(`Installer smoke retained its temporary directory for inspection: ${temporaryRoot}\n`);
  }
}
}

try {
  await main();
} catch (error) {
  await writeInstallerSmokeDiagnostic(error).catch((diagnosticError) => {
    const message = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    process.stderr.write(`Installer smoke could not write its diagnostic: ${message}\n`);
  });
  throw error;
}
