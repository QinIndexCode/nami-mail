import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createZipUpdateInstallerScript, launchZipUpdateInstaller } from "../src/zip-update-installer.mts";

const execFileAsync = promisify(execFile);

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isTransientWindowsHandleError(error: unknown): boolean {
  if (process.platform !== "win32" || typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY";
}

async function removeFixtureDirectoryAfterWindowsHandleRelease(directory: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let retryDelay = 25;
  while (true) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientWindowsHandleError(error) || Date.now() >= deadline) throw error;
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 250);
    }
  }
}

async function waitForFileSignal(
  filePath: string,
  child: ChildProcess,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      // The lock holder has not created its ready signal yet.
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${description} exited before it signaled readiness (code ${child.exitCode}, signal ${child.signalCode}).`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description} to signal readiness.`);
    }
    await sleep(25);
  }
}

function waitForChildExit(child: ChildProcess, description: string, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: number | null | Error) => void, value: number | null | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      callback(value);
    };
    const onExit = (code: number | null) => finish(resolve, code);
    const onError = (error: Error) => finish(reject, error);
    const timeout = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for ${description} to exit.`));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) finish(resolve, child.exitCode);
  });
}

async function stopLockHolder(child: ChildProcess, releasePath: string): Promise<number | null> {
  await fs.writeFile(releasePath, "", "utf8").catch(() => undefined);
  try {
    return await waitForChildExit(child, "the Windows installer lock holder");
  } catch {
    child.kill();
    await waitForChildExit(child, "forced Windows installer lock-holder cleanup", 2_000).catch(() => undefined);
    return child.exitCode;
  }
}

test("the ZIP installer helper binds verified archive bytes to one extracted installer stream and records recoverable failures", () => {
  const script = createZipUpdateInstallerScript();
  assert.match(script, /Add-Type -AssemblyName System\.IO\.Compression/);
  assert.match(script, /\[IO\.File\]::Open\(\$ArchivePath, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, \[IO\.FileShare\]::Read\)/);
  assert.match(script, /Get-StreamSha512 \$archiveStream/);
  assert.match(script, /\$archiveStream\.Position = 0/);
  assert.match(script, /\[IO\.Compression\.ZipArchive\]::new\(\$archiveStream, \[IO\.Compression\.ZipArchiveMode\]::Read, \$true\)/);
  assert.doesNotMatch(script, /ReadAllBytes\(\$ArchivePath\)/);
  assert.doesNotMatch(script, /ZipFile\]::OpenRead\(\$ArchivePath\)/);
  assert.match(script, /\$archive\.Entries\.Count -ne 1/);
  assert.match(script, /\$entry\.FullName -cne \$InstallerName/);
  assert.match(script, /\$installerOutput = \[IO\.File\]::Open\(\$installerPath, \[IO\.FileMode\]::CreateNew, \[IO\.FileAccess\]::ReadWrite, \[IO\.FileShare\]::Read\)/);
  assert.match(script, /\$installerOutput\.Flush\(\$true\)/);
  assert.match(script, /\$expectedInstallerHash = Get-StreamSha512 \$installerOutput/);
  assert.match(script, /\$installerLock = \[IO\.File\]::Open\(\$installerPath, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, \[IO\.FileShare\]::Read\)/);
  assert.match(script, /Get-StreamSha512 \$installerLock\) -cne \$expectedInstallerHash/);
  assert.ok(
    script.indexOf("$installerOutput.Dispose()") < script.indexOf("$installerLock = [IO.File]::Open($installerPath"),
    "The final read lock must be opened only after the trusted writer hash is sealed.",
  );
  assert.match(script, /Assert-ValidSignature/);
  assert.match(script, /if \(\$installer\.ExitCode -ne 0\) \{ throw "Nami Mail installer exited with code \$\(\$installer\.ExitCode\)\." \}/);
  assert.match(script, /\$installationSucceeded = \$true/);
  assert.match(script, /function Remove-TransientFile/);
  assert.match(script, /function Remove-TransientDirectory/);
  assert.match(script, /\$archiveRemoved = Remove-TransientFile \$ArchivePath/);
  assert.match(script, /\$helperRemoved = if \(\[string\]::IsNullOrWhiteSpace\(\$PSCommandPath\)\) \{ \$true \} else \{ Remove-TransientFile \$PSCommandPath \}/);
  assert.match(script, /\$stage = 'cleanup'/);
  assert.match(script, /\[string\]\$TargetVersion/);
  assert.match(script, /\[string\]\$ResultPath/);
  assert.match(script, /function Write-InstallFailure/);
  assert.match(script, /\[IO\.File\]::Replace\(\$temporaryPath, \$DestinationPath, \$null\)/);
  assert.match(script, /\$shouldRestartPreviousVersion = \$true/);
  assert.match(script, /if \(\$shouldRestartPreviousVersion\)/);
  assert.match(script, /\[string\]\$CurrentExecutableSha512/);
  assert.match(script, /\$currentExecutableLock = \[IO\.File\]::Open\(\$CurrentExecutablePath, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, \[IO\.FileShare\]::Read\)/);
  assert.match(script, /Get-StreamSha512 \$currentExecutableLock/);
  assert.doesNotMatch(script, /Write-Error \$_/);
  assert.match(script, /if \(\$installationSucceeded -and \(Test-Path -LiteralPath \$CurrentExecutablePath\)\)/);
  assert.doesNotMatch(script, /if \(Test-Path -LiteralPath \$CurrentExecutablePath\)/);
});

test("rejects an update archive outside its target version directory", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-installer-plan-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cacheDirectory = path.join(directory, "updates");
  await assert.rejects(
    launchZipUpdateInstaller({
      cacheDirectory,
      archivePath: path.join(cacheDirectory, "unexpected", "update.zip"),
      archiveSize: 1,
      archiveSha512: Buffer.alloc(64).toString("base64"),
      targetVersion: "1.2.3",
      installerName: "Nami-Mail-Setup.exe",
      currentExecutablePath: path.join(directory, "Nami Mail.exe"),
      trust: { kind: "ed25519" },
      parentProcessId: 1,
    }),
    /target version directory/,
  );
});

test("Windows detects replacement during handle transition and rejects writes while the final read lock is held", async (t) => {
  if (process.platform !== "win32") {
    t.skip("This lock behavior is specific to Windows file sharing.");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-installer-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executablePath = path.join(directory, "lock-check.exe");
  const sourceExecutablePath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
  await fs.copyFile(sourceExecutablePath, executablePath);
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  // This first phase deliberately releases the writer before opening the final
  // read lock, proving that a replacement in that transition changes the hash.
  await execFileAsync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "function Get-Hash([IO.Stream]$stream) { $algorithm = [Security.Cryptography.SHA512]::Create(); try { [Convert]::ToBase64String($algorithm.ComputeHash($stream)) } finally { $algorithm.Dispose() } }; $output = [IO.File]::Open($env:NAMI_LOCKED_INSTALLER, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read); try { $output.Flush($true); $output.Position = 0; $expected = Get-Hash $output } finally { $output.Dispose() }; [IO.File]::WriteAllBytes($env:NAMI_LOCKED_INSTALLER, [byte[]](1, 2, 3)); $replacement = [IO.File]::Open($env:NAMI_LOCKED_INSTALLER, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { if ((Get-Hash $replacement) -ceq $expected) { throw 'replacement was not detected' } } finally { $replacement.Dispose() }",
  ], {
    env: {
      ...process.env,
      NAMI_LOCKED_INSTALLER: executablePath,
    },
    windowsHide: true,
    timeout: 5_000,
  });

  await fs.copyFile(sourceExecutablePath, executablePath);
  const readyPath = path.join(directory, "lock-ready");
  const releasePath = path.join(directory, "lock-release");
  const lockHolder = spawn(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$installerLock = [IO.File]::Open($env:NAMI_LOCKED_INSTALLER, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [IO.File]::WriteAllText($env:NAMI_LOCK_READY, 'ready', [Text.UTF8Encoding]::new($false)); $deadline = [DateTime]::UtcNow.AddSeconds(8); while (-not (Test-Path -LiteralPath $env:NAMI_LOCK_RELEASE)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'lock holder timed out waiting for release' }; Start-Sleep -Milliseconds 25 } } finally { $installerLock.Dispose() }",
  ], {
    env: {
      ...process.env,
      NAMI_LOCKED_INSTALLER: executablePath,
      NAMI_LOCK_READY: readyPath,
      NAMI_LOCK_RELEASE: releasePath,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  let lockHolderStopped = false;
  try {
    await waitForFileSignal(readyPath, lockHolder, "the Windows installer lock holder");
    await assert.rejects(
      fs.writeFile(executablePath, Buffer.from([1, 2, 3])),
      (error: NodeJS.ErrnoException) => ["EACCES", "EBUSY", "EPERM"].includes(error.code ?? ""),
      "A separate process must not write the installer while the final read lock is held.",
    );

    const lockedExecutable = spawn(executablePath, [], { stdio: "ignore", windowsHide: true });
    assert.equal(await waitForChildExit(lockedExecutable, "the executable opened under the final read lock"), 0);

    assert.equal(await stopLockHolder(lockHolder, releasePath), 0);
    lockHolderStopped = true;
  } finally {
    if (!lockHolderStopped) await stopLockHolder(lockHolder, releasePath);
  }
});

test("Windows helper installs a verified ZIP payload and removes transient update files", async (t) => {
  if (process.platform !== "win32") {
    t.skip("The update helper is a Windows PowerShell script.");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-installer-success-"));
  let helper: ChildProcess | undefined;
  t.after(async () => {
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      helper.kill();
      await waitForChildExit(helper, "forced Windows update-helper cleanup", 2_000).catch(() => undefined);
    }
    // The helper restarts the current executable after it exits. Its process
    // can retain the source fixture's EXE handle briefly, even after the
    // helper's exit event. Retrying only transient Windows lock errors makes
    // cleanup wait for those real handles rather than masking other failures.
    await removeFixtureDirectoryAfterWindowsHandleRelease(directory);
  });
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const installerName = "Nami-Mail-Setup.exe";
  const sourceDirectory = path.join(directory, "release");
  const installerSource = path.join(sourceDirectory, installerName);
  const cacheDirectory = path.join(directory, "updates");
  const versionDirectory = path.join(cacheDirectory, "0.1.1");
  const archivePath = path.join(versionDirectory, "Nami-Mail-0.1.1-win-x64.zip");
  const workDirectory = path.join(versionDirectory, "install-work", "fixture");
  const resultPath = path.join(cacheDirectory, "install-result.json");
  const helperPath = path.join(versionDirectory, "helpers", "install-helper.ps1");
  const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const sourcePath = path.join(directory, "installer.cs");
  try {
    await fs.access(compiler);
  } catch {
    t.skip("The Windows .NET Framework C# compiler is unavailable for the helper success-path fixture.");
    return;
  }

  await fs.mkdir(sourceDirectory);
  await fs.mkdir(versionDirectory, { recursive: true });
  await fs.mkdir(path.dirname(helperPath), { recursive: true });
  await fs.writeFile(sourcePath, "public static class Program { [System.STAThread] public static void Main() {} }", "utf8");
  await execFileAsync(compiler, ["/nologo", "/target:winexe", `/out:${installerSource}`, sourcePath], {
    windowsHide: true,
    timeout: 15_000,
  });
  await execFileAsync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:NAMI_UPDATE_ZIP_SOURCE, $env:NAMI_UPDATE_ZIP_PATH)",
  ], {
    env: {
      ...process.env,
      NAMI_UPDATE_ZIP_SOURCE: sourceDirectory,
      NAMI_UPDATE_ZIP_PATH: archivePath,
    },
    windowsHide: true,
    timeout: 15_000,
  });
  const archive = await fs.readFile(archivePath);
  const archiveSha512 = createHash("sha512").update(archive).digest("base64");
  const archiveSize = archive.byteLength;
  const currentExecutableSha512 = createHash("sha512").update(await fs.readFile(installerSource)).digest("base64");
  const { stdout: archiveProbe } = await execFileAsync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$stream = [IO.File]::Open($env:NAMI_UPDATE_ARCHIVE_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); $algorithm = [Security.Cryptography.SHA512]::Create(); try { \"$($stream.Length)|$([Convert]::ToBase64String($algorithm.ComputeHash($stream)))\" } finally { $algorithm.Dispose(); $stream.Dispose() }",
  ], {
    env: { ...process.env, NAMI_UPDATE_ARCHIVE_PATH: archivePath },
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(archiveProbe.trim(), `${archiveSize}|${archiveSha512}`);
  await fs.writeFile(helperPath, createZipUpdateInstallerScript(), "utf8");

  helper = spawn(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-ParentProcessId",
    "2147483647",
    "-ArchivePath",
    archivePath,
    "-ArchiveSize",
    String(archiveSize),
    "-ArchiveSha512",
    archiveSha512,
    "-TargetVersion",
    "0.1.1",
    "-VersionDirectory",
    versionDirectory,
    "-InstallerName",
    installerName,
    "-CurrentExecutablePath",
    installerSource,
    "-CurrentExecutableSha512",
    currentExecutableSha512,
    "-WorkDirectory",
    workDirectory,
    "-ResultPath",
    resultPath,
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  let exitCode: number | null;
  try {
    exitCode = await waitForChildExit(helper, "the Windows update helper", 10_000);
  } catch (error) {
    if (helper.exitCode === null && helper.signalCode === null) {
      helper.kill();
      await waitForChildExit(helper, "forced Windows update-helper cleanup", 2_000).catch(() => undefined);
    }
    throw error;
  }
  assert.equal(exitCode, 0);

  await assert.rejects(fs.access(archivePath), /ENOENT/);
  await assert.rejects(fs.access(workDirectory), /ENOENT/);
  await assert.rejects(fs.access(resultPath), /ENOENT/);
  await assert.rejects(fs.access(helperPath), /ENOENT/);
  await assert.rejects(fs.access(versionDirectory), /ENOENT/);
});
