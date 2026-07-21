import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveReleaseDirectory } from "./release-policy.mjs";

if (process.platform !== "win32") {
  throw new Error("The NSIS installer smoke test can only run on Windows.");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(projectRoot, "output", "installer-smoke.json");
const packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseDirectory = resolveReleaseDirectory(projectRoot);
const appId = packageManifest.build?.appId;
const productName = packageManifest.build?.productName;
const nsisOptions = packageManifest.build?.nsis;
const nsisInclude = nsisOptions?.include;
const installerLifecycleSourcePath = path.join(projectRoot, "build", "installer.nsh");
const electronBuilderNsisNamespace = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
const expectedInstallerName = `Nami Mail Setup ${packageManifest.version}.exe`;
const expectedInstallerOverride = process.env.NAMI_MAIL_EXPECTED_INSTALLER?.trim();
const packageStartedAt = Number.parseInt(process.env.NAMI_MAIL_PACKAGE_STARTED_AT ?? "", 10);
const execFileAsync = promisify(execFile);

assert.equal(typeof appId, "string", "package.json build.appId is required for installer safety checks.");
assert.equal(typeof productName, "string", "package.json build.productName is required for installer safety checks.");
assert.equal(productName, "Nami Mail", "The installer data-deletion target must match Electron's production userData name.");
assert.equal(nsisInclude, "build/installer.nsh", "NSIS lifecycle safeguards must be enabled through build.nsis.include.");
assert.equal(nsisOptions?.oneClick, false, "The installer must retain the assisted directory-selection flow.");
assert.equal(nsisOptions?.perMachine, false, "Nami Mail must not be packaged as a machine-wide installer.");
assert.equal(nsisOptions?.allowElevation, false, "The assisted installer must not offer elevation to another Windows account.");
assert.deepEqual(nsisOptions?.installerLanguages, ["zh_CN"], "The Windows installer must use the product's Simplified Chinese language.");
assert.equal(nsisOptions?.language, 2052, "The Windows installer default language must be Simplified Chinese (LCID 2052).");
assert.equal(
  Boolean(process.env.NAMI_MAIL_INSTALLER_EXECUTABLE?.trim()),
  false,
  "NAMI_MAIL_INSTALLER_EXECUTABLE is not accepted. Installer smoke always uses the exact package artifact.",
);

const installerLifecycleSource = await fs.readFile(installerLifecycleSourcePath, "utf8");
for (const expected of [
  '!include "WordFunc.nsh"',
  "!macro customInit",
  "!macro customInstallMode",
  'StrCpy $isForceCurrentInstall "1"',
  '"/allusers"',
  "DisplayVersion",
  "HKEY_CURRENT_USER",
  "HKEY_LOCAL_MACHINE",
  "--nami-allow-downgrade",
  "已安装较新的 Nami Mail",
  "!macro customUnInstall",
  "--nami-delete-data",
  "是否同时永久删除当前 Windows 用户的 Nami Mail 本地数据",
  "SetShellVarContext current",
  "!undef APP_PACKAGE_NAME",
]) {
  assert.ok(installerLifecycleSource.includes(expected), `NSIS lifecycle safeguard is missing: ${expected}`);
}
const dataDeletionMacro = installerLifecycleSource.match(/!macro namiDeleteCurrentUserData\r?\n([\s\S]*?)!macroend/);
assert.ok(dataDeletionMacro, "NSIS data deletion must stay in the dedicated current-user macro.");
const dataDeletionSource = dataDeletionMacro[1];
assert.match(
  dataDeletionSource,
  /SetShellVarContext current[\s\S]*?StrCpy \$R0 "\$APPDATA\\\$\{PRODUCT_FILENAME\}"[\s\S]*?RMDir \/r "\$R0"/,
  "NSIS data deletion must resolve the current user's Nami Mail directory before removing it.",
);
assert.ok(
  dataDeletionSource.includes('IfFileExists "$R0\\*.*" 0 +2') && dataDeletionSource.includes("SetErrorLevel 5"),
  "NSIS data deletion must report a nonzero error when local data remains after removal.",
);
assert.equal(
  dataDeletionSource.includes("APP_PACKAGE_NAME"),
  false,
  "Nami Mail must not use an npm-package-name directory as a data-deletion target.",
);
assert.equal(
  installerLifecycleSource.includes('RMDir /r "$APPDATA\\${APP_PACKAGE_NAME}"'),
  false,
  "Nami Mail must not delete a broad npm-package-name app-data directory during uninstall.",
);

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

function uuidBytes(value) {
  const compact = value.replaceAll("-", "");
  assert.match(compact, /^[0-9a-f]{32}$/i, "The electron-builder UUID namespace is invalid.");
  return Buffer.from(compact, "hex");
}

function electronBuilderUninstallKey(applicationId) {
  const digest = createHash("sha1")
    .update(uuidBytes(electronBuilderNsisNamespace))
    .update(Buffer.from(applicationId, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const value = digest.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const expectedUninstallKey = electronBuilderUninstallKey(appId);

async function existingNamiMailInstallations() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')",
    "$namiInstallations = foreach ($root in $roots) { if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root | ForEach-Object { $properties = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; if ($_.PSChildName -eq '" + powerShellLiteral(expectedUninstallKey) + "' -or ($_.PSChildName -eq '" + powerShellLiteral(appId) + "' -and $properties.DisplayName -like '" + powerShellLiteral(productName) + "*')) { [pscustomobject]@{ Key = $_.PSChildName; RegistryPath = $_.PSPath; DisplayName = $properties.DisplayName; DisplayVersion = $properties.DisplayVersion; Publisher = $properties.Publisher; InstallLocation = $properties.InstallLocation; UninstallString = $properties.UninstallString } } } } }",
    "@($namiInstallations) | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
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
    windowsHide: true,
  });
  assert.equal(stdout.trim(), version, "The installer smoke could not stage its isolated version branch.");
}

async function assertIsolatedInstallationVersion(expectedVersion, expectedUninstaller) {
  const installations = await existingNamiMailInstallations();
  assert.equal(installations.length, 1, "The isolated installation must keep exactly one Nami Mail uninstall record.");
  assert.equal(installations[0].Key, expectedUninstallKey, "The uninstall record must use electron-builder's appId-derived key.");
  assert.equal(installations[0].DisplayVersion, expectedVersion, "The uninstall record did not return to the packaged version.");
  assert.equal(
    path.resolve(registeredUninstallerPath(installations[0])),
    path.resolve(expectedUninstaller),
    "The installer modified an uninstall record outside its isolated directory.",
  );
  return installations[0];
}

function registeredUninstallerPath(installation) {
  assert.equal(typeof installation?.UninstallString, "string", "The test installation uninstall command is unavailable.");
  const match = installation.UninstallString.match(/^\s*"([^"]+)"(?:\s|$)/);
  assert.ok(match?.[1], "The test installation uninstall command must start with a quoted executable path.");
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

async function waitForAbsent(target) {
  const deadline = Date.now() + 15_000;
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
    windowsHide: true,
  });
  const value = stdout.trim();
  if (!value) return [];
  const parsed = JSON.parse(value);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((pid) => String(pid)).sort();
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
      timeout: 45_000,
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

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nami-mail-installer-"));
const installDirectory = path.join(temporaryRoot, "app");
let uninstaller;
let installationCreated = false;
let uninstallVerified = false;
let sameVersionSilentReinstall = false;
let lowerVersionSilentUpgrade = false;
let higherVersionSilentDowngradeBlocked = false;
let explicitSilentDowngrade = false;

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

  // NSIS accepts /D only as its final argument. The test directory is unique
  // for this invocation, so it cannot overwrite an existing installation.
  await execFileAsync(installer, ["/S", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 120_000,
    windowsHide: true,
  });
  installationCreated = true;

  const installedExecutable = path.join(installDirectory, "Nami Mail.exe");
  await fs.access(installedExecutable);
  const initialEntries = await fs.readdir(installDirectory);
  const initialUninstallerName = initialEntries.find((entry) => /^Uninstall .+\.exe$/i.test(entry));
  assert.ok(initialUninstallerName, "Installed application did not include an NSIS uninstaller.");
  uninstaller = path.join(installDirectory, initialUninstallerName);
  const testInstallations = await existingNamiMailInstallations();
  assert.equal(testInstallations.length, 1, "The isolated installation must create exactly one Nami Mail uninstall record.");
  assert.equal(testInstallations[0].Key, expectedUninstallKey, "The uninstall record must use electron-builder's appId-derived key.");
  assert.match(testInstallations[0].DisplayName ?? "", /^Nami Mail(?:\s|$)/, "The uninstall record must identify Nami Mail.");
  assert.equal(testInstallations[0].Publisher, packageManifest.author, "The uninstall record publisher must match package.json.");
  assert.equal(
    path.resolve(registeredUninstallerPath(testInstallations[0])),
    path.resolve(uninstaller),
    "The version-branch test must only modify the uninstall record for its isolated Nami Mail installation.",
  );

  await setInstalledVersion(testInstallations[0], "99.0.0");
  await expectInstallerExitCode(installer, ["/S", `/D=${installDirectory}`], 3);
  const blockedInstallations = await existingNamiMailInstallations();
  assert.equal(blockedInstallations.length, 1);
  assert.equal(blockedInstallations[0].DisplayVersion, "99.0.0", "A blocked downgrade must not rewrite the installation record.");
  higherVersionSilentDowngradeBlocked = true;

  await setInstalledVersion(testInstallations[0], "0.0.1");
  await execFileAsync(installer, ["/S", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 120_000,
    windowsHide: true,
  });
  await assertIsolatedInstallationVersion(packageManifest.version, uninstaller);
  lowerVersionSilentUpgrade = true;

  const upgradedInstallations = await existingNamiMailInstallations();
  assert.equal(upgradedInstallations.length, 1);
  await setInstalledVersion(upgradedInstallations[0], "99.0.0");
  await execFileAsync(installer, ["/S", "--nami-allow-downgrade", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 120_000,
    windowsHide: true,
  });
  await assertIsolatedInstallationVersion(packageManifest.version, uninstaller);
  explicitSilentDowngrade = true;

  // An assisted installer prompts in the same-version interactive case. Its
  // silent deployment path remains intentionally idempotent for managed
  // deployments, and must perform a real reinstall without requiring UI.
  const pristineExecutableBytes = (await fs.stat(installedExecutable)).size;
  await fs.writeFile(installedExecutable, "nami-installer-smoke-corruption", "utf8");
  assert.ok((await fs.stat(installedExecutable)).size < pristineExecutableBytes);
  await execFileAsync(installer, ["/S", `/D=${installDirectory}`], {
    cwd: projectRoot,
    timeout: 120_000,
    windowsHide: true,
  });
  await assertIsolatedInstallationVersion(packageManifest.version, uninstaller);
  assert.equal((await fs.stat(installedExecutable)).size, pristineExecutableBytes, "Same-version reinstall did not restore the packaged executable.");
  sameVersionSilentReinstall = true;

  await fs.access(installedExecutable);
  await fs.access(uninstaller);

  const desktopSmoke = await smokeInstalledExecutable(installedExecutable);
  await execFileAsync(uninstaller, ["/S"], {
    cwd: installDirectory,
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(await waitForAbsent(installDirectory), true, "NSIS uninstall did not remove the test installation directory.");
  assert.deepEqual(await runningNamiMailPids(), processesBefore, "Installer smoke left a Nami Mail process running.");
  assert.deepEqual(await existingNamiMailInstallations(), [], "NSIS uninstall left a Nami Mail uninstall record behind.");
  uninstallVerified = true;

  const report = {
    checkedAt: new Date().toISOString(),
    installer: path.relative(projectRoot, installer),
    installerBytes: installerStat.size,
    installedExecutable: "Nami Mail.exe",
    desktopSmoke,
    sameVersionSilentReinstall,
    lowerVersionSilentUpgrade,
    higherVersionSilentDowngradeBlocked,
    explicitSilentDowngrade,
    uninstalled: true,
    noNewNamiMailProcesses: true,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} finally {
  if (!installationCreated && await exists(installDirectory)) {
    const entries = await fs.readdir(installDirectory).catch(() => []);
    const partialUninstallerName = entries.find((entry) => /^Uninstall .+\.exe$/i.test(entry));
    if (partialUninstallerName) uninstaller = path.join(installDirectory, partialUninstallerName);
    installationCreated = entries.length > 0;
  }
  if (installationCreated && !uninstallVerified && uninstaller && await exists(uninstaller)) {
    try {
      await execFileAsync(uninstaller, ["/S"], { cwd: installDirectory, timeout: 120_000, windowsHide: true });
      uninstallVerified = await waitForAbsent(installDirectory);
    } catch {
      uninstallVerified = false;
    }
  }
  if (uninstallVerified || !installationCreated) await fs.rm(temporaryRoot, { recursive: true, force: true });
  else process.stderr.write(`Installer smoke retained its temporary directory for inspection: ${temporaryRoot}\n`);
}
