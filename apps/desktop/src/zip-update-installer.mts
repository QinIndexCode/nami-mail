import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { updateInstallResultPath } from "./update-install-result.mjs";

const execFileAsync = promisify(execFile);
const thumbprintPattern = /^[A-F0-9]{40}$/;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type TrustedWindowsSigner = {
  publisher: string;
  thumbprint: string;
};

export type ZipUpdateInstallerTrust =
  | { kind: "authenticode"; signer: TrustedWindowsSigner }
  | { kind: "ed25519" };

export type ZipUpdateInstallerPlan = {
  cacheDirectory: string;
  archivePath: string;
  archiveSize: number;
  archiveSha512: string;
  targetVersion: string;
  installerName: string;
  currentExecutablePath: string;
  trust: ZipUpdateInstallerTrust;
  parentProcessId: number;
};

type AuthenticodeResult = {
  Status?: unknown;
  Subject?: unknown;
  SimpleName?: unknown;
  Thumbprint?: unknown;
};

function powershellPath(): string {
  return path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function normalizeSigner(value: AuthenticodeResult): TrustedWindowsSigner | undefined {
  const publisher = typeof value.SimpleName === "string" && value.SimpleName.trim()
    ? value.SimpleName.trim()
    : typeof value.Subject === "string" && value.Subject.trim()
      ? value.Subject.trim()
      : "";
  const thumbprint = typeof value.Thumbprint === "string"
    ? value.Thumbprint.replaceAll(/\s/g, "").toUpperCase()
    : "";
  return value.Status === "Valid" && publisher && thumbprintPattern.test(thumbprint)
    ? { publisher, thumbprint }
    : undefined;
}

export async function readTrustedWindowsSigner(executablePath: string): Promise<TrustedWindowsSigner | undefined> {
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:NAMI_MAIL_SIGNATURE_TARGET",
    "$certificate = $signature.SignerCertificate",
    "$simpleName = if ($certificate) { $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }",
    "[PSCustomObject]@{ Status = [string]$signature.Status; Subject = if ($certificate) { $certificate.Subject } else { '' }; SimpleName = $simpleName; Thumbprint = if ($certificate) { $certificate.Thumbprint } else { '' } } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, NAMI_MAIL_SIGNATURE_TARGET: executablePath },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 32 * 1024,
    });
    return normalizeSigner(JSON.parse(stdout.trim()) as AuthenticodeResult);
  } catch {
    return undefined;
  }
}

function assertInstallerPlan(plan: ZipUpdateInstallerPlan): void {
  if (!Number.isInteger(plan.parentProcessId) || plan.parentProcessId < 1) throw new Error("The update parent process id is invalid.");
  if (!Number.isSafeInteger(plan.archiveSize) || plan.archiveSize < 1) throw new Error("The update archive size is invalid.");
  if (!base64Pattern.test(plan.archiveSha512) || Buffer.from(plan.archiveSha512, "base64").byteLength !== 64) {
    throw new Error("The update archive SHA-512 digest is invalid.");
  }
  if (!stableVersionPattern.test(plan.targetVersion)) throw new Error("The update target version is invalid.");
  if (plan.trust.kind === "authenticode" && (!thumbprintPattern.test(plan.trust.signer.thumbprint) || !plan.trust.signer.publisher.trim())) {
    throw new Error("The trusted update signer is invalid.");
  }
  if (!/^[^\\/:*?"<>|\r\n]+\.exe$/i.test(plan.installerName)) throw new Error("The update installer name is invalid.");
  if (!path.isAbsolute(plan.archivePath) || !path.isAbsolute(plan.currentExecutablePath) || !path.isAbsolute(plan.cacheDirectory)) {
    throw new Error("The update installer requires absolute local paths.");
  }
  const archiveRelative = path.relative(plan.cacheDirectory, plan.archivePath);
  if (!archiveRelative || archiveRelative.startsWith("..") || path.isAbsolute(archiveRelative)) {
    throw new Error("The update archive must remain inside the update cache.");
  }
  const versionDirectory = path.resolve(plan.cacheDirectory, plan.targetVersion);
  const archiveDirectory = path.resolve(path.dirname(plan.archivePath));
  const sameVersionDirectory = process.platform === "win32"
    ? archiveDirectory.toLowerCase() === versionDirectory.toLowerCase()
    : archiveDirectory === versionDirectory;
  if (!sameVersionDirectory) {
    throw new Error("The update archive must remain inside its target version directory.");
  }
}

async function sha512File(filePath: string): Promise<string> {
  const digest = createHash("sha512");
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return digest.digest("base64");
}

export function createZipUpdateInstallerScript(): string {
  // The helper never expands arbitrary paths from the archive. It holds an
  // exclusive-to-writers handle while hashing and reading the ZIP, then holds
  // the extracted installer while it performs the final integrity checks and
  // starts the process. This rejects ordinary replacement attempts between
  // extraction and process creation. Windows path-based process creation still
  // cannot make an absolute guarantee against a same-user attacker that races
  // a rename after the final check.
  return String.raw`param(
  [int]$ParentProcessId,
  [string]$ArchivePath,
  [Int64]$ArchiveSize,
  [string]$ArchiveSha512,
  [string]$TargetVersion,
  [string]$VersionDirectory,
  [string]$InstallerName,
  [string]$CurrentExecutablePath,
  [string]$CurrentExecutableSha512,
  [string]$ExpectedSignerThumbprint,
  [string]$WorkDirectory,
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$installerOutput = $null
$installerLock = $null
$currentExecutableLock = $null
$installationSucceeded = $false
$shouldRestartPreviousVersion = $false
$stage = 'wait'

function Assert-ValidSignature([string]$FilePath, [string]$ExpectedThumbprint) {
  $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "Authenticode validation failed for $FilePath."
  }
  $thumbprint = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
  if ($thumbprint -cne $ExpectedThumbprint) {
    throw "Unexpected Authenticode signer for $FilePath."
  }
}

function Get-StreamSha512([IO.Stream]$Stream) {
  $algorithm = [Security.Cryptography.SHA512]::Create()
  try { return [Convert]::ToBase64String($algorithm.ComputeHash($Stream)) }
  finally { $algorithm.Dispose() }
}

function Remove-TransientFile([string]$FilePath) {
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    if (-not (Test-Path -LiteralPath $FilePath)) { return $true }
    try { [IO.File]::Delete($FilePath) } catch {}
    if (-not (Test-Path -LiteralPath $FilePath)) { return $true }
    Start-Sleep -Milliseconds (100 * ($attempt + 1))
  }
  return -not (Test-Path -LiteralPath $FilePath)
}

function Remove-TransientDirectory([string]$DirectoryPath) {
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    if (-not (Test-Path -LiteralPath $DirectoryPath)) { return $true }
    try { [IO.Directory]::Delete($DirectoryPath, $true) } catch {}
    if (-not (Test-Path -LiteralPath $DirectoryPath)) { return $true }
    Start-Sleep -Milliseconds (100 * ($attempt + 1))
  }
  return -not (Test-Path -LiteralPath $DirectoryPath)
}

function Write-InstallFailure([string]$Version, [string]$FailureStage, [string]$DestinationPath) {
  $directory = [IO.Path]::GetDirectoryName($DestinationPath)
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporaryPath = [IO.Path]::Combine($directory, ".install-result-$([Guid]::NewGuid().ToString('N')).tmp")
  $record = [ordered]@{
    schemaVersion = 1
    version = $Version
    stage = $FailureStage
    occurredAt = [DateTime]::UtcNow.ToString('o')
  }
  try {
    [IO.File]::WriteAllText($temporaryPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($DestinationPath)) {
      [IO.File]::Replace($temporaryPath, $DestinationPath, $null)
    } else {
      [IO.File]::Move($temporaryPath, $DestinationPath)
    }
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  Add-Type -AssemblyName System.IO.Compression
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Nami Mail did not exit before update installation.' }
    Start-Sleep -Milliseconds 200
  }

  $stage = 'verify-installer'
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)) {
    Assert-ValidSignature $CurrentExecutablePath $ExpectedSignerThumbprint
  }
  [IO.Directory]::CreateDirectory($WorkDirectory) | Out-Null
  # Do not re-open ArchivePath after hashing it: another same-user process
  # could otherwise replace the ZIP between integrity verification and unzip.
  $stage = 'verify-archive'
  $archiveStream = [IO.File]::Open($ArchivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($archiveStream.Length -ne $ArchiveSize) {
      throw 'Downloaded update ZIP size does not match its verified metadata.'
    }
    $sha512 = Get-StreamSha512 $archiveStream
    if ($sha512 -cne $ArchiveSha512) {
      throw 'Downloaded update ZIP integrity check failed before installation.'
    }
    $archiveStream.Position = 0
    $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
      $stage = 'extract'
      if ($archive.Entries.Count -ne 1) { throw 'Update ZIP must contain exactly one installer.' }
      $entry = $archive.Entries[0]
      if ($entry.FullName -cne $InstallerName -or $entry.FullName.Contains('/') -or $entry.FullName.Contains('\')) {
        throw 'Update ZIP does not contain the expected root-level installer.'
      }
      $installerPath = [IO.Path]::Combine($WorkDirectory, $InstallerName)
      $input = $entry.Open()
      try {
        # The writer blocks replacement while extraction completes. Hash its
        # flushed bytes before it closes; the later read lock must match this
        # digest before process creation can continue.
        $installerOutput = [IO.File]::Open($installerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        $input.CopyTo($installerOutput)
        $installerOutput.Flush($true)
        $installerOutput.Position = 0
        $expectedInstallerHash = Get-StreamSha512 $installerOutput
      } finally { $input.Dispose() }
    } finally { $archive.Dispose() }
  } finally { $archiveStream.Dispose() }

  if (-not $installerOutput -or [string]::IsNullOrWhiteSpace($expectedInstallerHash)) {
    throw 'Update installer extraction did not produce a trusted executable.'
  }
  $stage = 'verify-installer'
  $installerOutput.Dispose()
  $installerOutput = $null
  # Re-open under a read lock and require the bytes to equal the ZIP-derived
  # digest before signature verification or process creation can continue.
  $installerLock = [IO.File]::Open($installerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ((Get-StreamSha512 $installerLock) -cne $expectedInstallerHash) {
    throw 'The extracted installer changed before it could be started.'
  }

  if (-not [string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)) {
    Assert-ValidSignature $installerPath $ExpectedSignerThumbprint
  }
  $stage = 'install'
  $installer = Start-Process -FilePath $installerPath -ArgumentList @('/S') -PassThru -Wait
  if ($installer.ExitCode -ne 0) { throw "Nami Mail installer exited with code $($installer.ExitCode)." }
  Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue
  $installationSucceeded = $true
} catch {
  try { Write-InstallFailure $TargetVersion $stage $ResultPath } catch {}
  $shouldRestartPreviousVersion = $true
} finally {
  if ($installerOutput) { $installerOutput.Dispose() }
  if ($installerLock) { $installerLock.Dispose() }
  $archiveRemoved = Remove-TransientFile $ArchivePath
  $workDirectoryRemoved = Remove-TransientDirectory $WorkDirectory
  # The helper lives under the version-scoped cache. Remove it when possible;
  # startup recovery removes that version directory if this final step is locked.
  $helperRemoved = if ([string]::IsNullOrWhiteSpace($PSCommandPath)) { $true } else { Remove-TransientFile $PSCommandPath }
  $versionDirectoryRemoved = if ($helperRemoved) { Remove-TransientDirectory $VersionDirectory } else { $false }
  if ($installationSucceeded -and (-not $archiveRemoved -or -not $workDirectoryRemoved -or -not $helperRemoved -or -not $versionDirectoryRemoved)) {
    $stage = 'cleanup'
    try { Write-InstallFailure $TargetVersion $stage $ResultPath } catch {}
  }
}

if ($shouldRestartPreviousVersion) {
  $stage = 'restart'
  try {
    # The parent process has exited, so hold the previous executable while
    # checking its pre-exit hash and creating its process.
    $currentExecutableLock = [IO.File]::Open($CurrentExecutablePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      if ((Get-StreamSha512 $currentExecutableLock) -cne $CurrentExecutableSha512) {
        throw 'The previous Nami Mail executable changed before restart.'
      }
      if (-not [string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)) {
        Assert-ValidSignature $CurrentExecutablePath $ExpectedSignerThumbprint
      }
      Start-Process -FilePath $CurrentExecutablePath
    } finally { $currentExecutableLock.Dispose() }
  } catch {
    try { Write-InstallFailure $TargetVersion $stage $ResultPath } catch {}
  }
} elseif ($installationSucceeded -and (Test-Path -LiteralPath $CurrentExecutablePath)) {
  Start-Process -FilePath $CurrentExecutablePath
}
exit 0
`;
}

export async function launchZipUpdateInstaller(plan: ZipUpdateInstallerPlan): Promise<boolean> {
  assertInstallerPlan(plan);
  const versionDirectory = path.join(plan.cacheDirectory, plan.targetVersion);
  const helpersDirectory = path.join(versionDirectory, "helpers");
  const helperPath = path.join(helpersDirectory, `install-${randomBytes(10).toString("hex")}.ps1`);
  const workDirectory = path.join(versionDirectory, "install-work", randomBytes(10).toString("hex"));
  const resultPath = updateInstallResultPath(plan.cacheDirectory);
  const currentExecutableSha512 = await sha512File(plan.currentExecutablePath);
  await fs.mkdir(helpersDirectory, { recursive: true });
  await fs.rm(resultPath, { force: true });
  await fs.writeFile(helperPath, createZipUpdateInstallerScript(), { encoding: "utf8", mode: 0o600 });

  try {
    const signerArguments = plan.trust.kind === "authenticode"
      ? ["-ExpectedSignerThumbprint", plan.trust.signer.thumbprint]
      : [];
    const child = spawn(powershellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-ParentProcessId",
      String(plan.parentProcessId),
      "-ArchivePath",
      plan.archivePath,
      "-ArchiveSize",
      String(plan.archiveSize),
      "-ArchiveSha512",
      plan.archiveSha512,
      "-TargetVersion",
      plan.targetVersion,
      "-VersionDirectory",
      versionDirectory,
      "-InstallerName",
      plan.installerName,
      "-CurrentExecutablePath",
      plan.currentExecutablePath,
      "-CurrentExecutableSha512",
      currentExecutableSha512,
      ...signerArguments,
      "-WorkDirectory",
      workDirectory,
      "-ResultPath",
      resultPath,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return true;
  } catch (error) {
    await fs.rm(helperPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
