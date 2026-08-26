[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
  [string]$PipeName,
  [ValidateRange(100, 60000)]
  [int]$RequestReadTimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$MaximumMessageLength = 1048576
$Utf8 = [System.Text.UTF8Encoding]::new($false)

function Write-ParentMessage {
  param([hashtable]$Message)
  [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function New-SidRestrictedPipeSecurity {
  $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $ownerSid) {
    throw 'The current Windows user SID is unavailable.'
  }
  $security = [System.IO.Pipes.PipeSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    [void]$security.RemoveAccessRuleAll($rule)
  }
  $rights = [System.IO.Pipes.PipeAccessRights]::ReadWrite
  $accessRule = [System.IO.Pipes.PipeAccessRule]::new(
    $ownerSid,
    $rights,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($accessRule)
  return @{ Security = $security; OwnerSid = $ownerSid.Value }
}

function New-SecurePipe {
  param([System.IO.Pipes.PipeSecurity]$Security)
  return [System.IO.Pipes.NamedPipeServerStream]::new(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,
    $MaximumMessageLength,
    $MaximumMessageLength,
    $Security
  )
}

function Test-SidRestrictedPipeSecurity {
  param(
    [System.IO.Pipes.PipeSecurity]$Security,
    [string]$ExpectedOwnerSid
  )
  $rules = @($Security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $Security.AreAccessRulesProtected -or $rules.Count -ne 1) {
    return $false
  }
  $rule = $rules[0]
  return $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
    -and $rule.IdentityReference.Value -eq $ExpectedOwnerSid `
    -and (($rule.PipeAccessRights -band [System.IO.Pipes.PipeAccessRights]::ReadWrite) -eq [System.IO.Pipes.PipeAccessRights]::ReadWrite)
}

function Read-ParentResponse {
  param([string]$ConnectionId)
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line.Length -gt $MaximumMessageLength) {
    return $null
  }
  try {
    $candidate = $line | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
  if ($candidate.type -ne 'response' -or $candidate.connectionId -ne $ConnectionId -or $candidate.payload -isnot [string]) {
    return $null
  }
  if ($candidate.payload.Length -gt $MaximumMessageLength) {
    return $null
  }
  return [string]$candidate.payload
}

function Read-PipeRequest {
  param([System.IO.StreamReader]$Reader)
  $task = $Reader.ReadLineAsync()
  if (-not $task.Wait($RequestReadTimeoutMilliseconds)) {
    return @{ TimedOut = $true; Payload = $null }
  }
  return @{ TimedOut = $false; Payload = $task.GetAwaiter().GetResult() }
}

$pipeSecurity = New-SidRestrictedPipeSecurity
if (-not (Test-SidRestrictedPipeSecurity -Security $pipeSecurity.Security -ExpectedOwnerSid $pipeSecurity.OwnerSid)) {
  throw 'The Agent pipe SID DACL could not be verified.'
}

$pipePath = "\\.\pipe\$PipeName"
$pipe = New-SecurePipe -Security $pipeSecurity.Security
Write-ParentMessage @{
  type = 'ready'
  pipeName = $PipeName
  path = $pipePath
  ownerSid = $pipeSecurity.OwnerSid
  daclProtected = $true
  ownerOnly = $true
  accessRuleCount = 1
}

while ($true) {
  $reader = $null
  $writer = $null
  try {
    $pipe.WaitForConnection()
    $reader = [System.IO.StreamReader]::new($pipe, $Utf8, $false, $MaximumMessageLength, $true)
    $writer = [System.IO.StreamWriter]::new($pipe, $Utf8, $MaximumMessageLength, $true)
    $writer.AutoFlush = $true
    $request = Read-PipeRequest -Reader $reader
    if ($request.TimedOut) {
      $writer.WriteLine('{"type":"response","error":"request-timeout"}')
      continue
    }
    $payload = $request.Payload
    if ($null -eq $payload -or $payload.Length -gt $MaximumMessageLength) {
      $writer.WriteLine('{"type":"response","error":"invalid-request"}')
      continue
    }
    $connectionId = [Guid]::NewGuid().ToString('N')
    Write-ParentMessage @{ type = 'request'; connectionId = $connectionId; payload = $payload }
    $responsePayload = Read-ParentResponse -ConnectionId $connectionId
    if ($null -eq $responsePayload) {
      $writer.WriteLine('{"type":"response","error":"broker-unavailable"}')
      continue
    }
    $writer.WriteLine($responsePayload)
  } catch {
    [Console]::Error.WriteLine("NamiMail Agent pipe failure: $($_.Exception.Message)")
  } finally {
    # A client can close immediately after reading a response. Releasing one
    # side of the stream must not prevent the single-instance pipe from being
    # recreated for the next local Agent request.
    if ($null -ne $writer) {
      try { $writer.Dispose() } catch {
        if ($_.Exception -isnot [System.IO.IOException]) { [Console]::Error.WriteLine("NamiMail Agent writer shutdown: $($_.Exception.Message)") }
      }
    }
    if ($null -ne $reader) {
      try { $reader.Dispose() } catch {
        if ($_.Exception -isnot [System.IO.IOException]) { [Console]::Error.WriteLine("NamiMail Agent reader shutdown: $($_.Exception.Message)") }
      }
    }
    if ($null -ne $pipe) {
      try { $pipe.Dispose() } catch {
        if ($_.Exception -isnot [System.IO.IOException]) { [Console]::Error.WriteLine("NamiMail Agent pipe shutdown: $($_.Exception.Message)") }
      }
    }
    $pipe = $null
  }
  try {
    $pipe = New-SecurePipe -Security $pipeSecurity.Security
  } catch {
    [Console]::Error.WriteLine("NamiMail Agent pipe restart failure: $($_.Exception.Message)")
    break
  }
}
