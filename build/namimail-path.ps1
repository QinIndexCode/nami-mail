[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("register", "unregister")]
  [string] $Action,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $CliPath
)

$ErrorActionPreference = "Stop"
$cliPath = $CliPath.TrimEnd('\')

$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
if ($null -eq $environmentKey) {
  throw "The current-user Environment registry key is unavailable."
}

try {
  $currentPath = $environmentKey.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $hasCurrentPath = $null -ne $currentPath
  $valueKind = if ($hasCurrentPath) { $environmentKey.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::String }
  if ($valueKind -ne [Microsoft.Win32.RegistryValueKind]::String -and $valueKind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
    throw "The current-user Path value has an unsupported registry type: $valueKind."
  }

  $segments = [System.Collections.Generic.List[string]]::new()
  if ($hasCurrentPath -and -not [string]::IsNullOrEmpty([string] $currentPath)) {
    foreach ($segment in ([string] $currentPath).Split(';')) {
      if (-not [string]::Equals($segment, $cliPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void] $segments.Add($segment)
      }
    }
  }
  if ($Action -eq "register") {
    [void] $segments.Add($cliPath)
  }

  $nextPath = [string]::Join(";", $segments)
  if ($nextPath.Length -eq 0) {
    $environmentKey.DeleteValue("Path", $false)
  } else {
    $environmentKey.SetValue("Path", $nextPath, $valueKind)
  }
} finally {
  $environmentKey.Dispose()
}

if (-not ("NamiMail.NativeEnvironment" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace NamiMail {
  public static class NativeEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd,
      uint message,
      UIntPtr wParam,
      string lParam,
      uint flags,
      uint timeout,
      out IntPtr result
    );
  }
}
'@
}

$broadcastResult = [IntPtr]::Zero
[void] [NamiMail.NativeEnvironment]::SendMessageTimeout(
  [IntPtr] 0xffff,
  0x001a,
  [UIntPtr]::Zero,
  "Environment",
  0x0002,
  5000,
  [ref] $broadcastResult
)

Write-Output ("{0}:{1}" -f $Action, $cliPath)
