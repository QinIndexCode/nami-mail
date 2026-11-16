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
# Two instances keep the name registered while the serving instance is being
# replaced: the pre-built one is still listening across Dispose and the
# rebuild, so a client that arrives in that window connects instead of hitting
# ENOENT on a name that does not exist. Capacity is therefore one exchange plus
# one waiting client; a third client is refused by the OS while both are busy.
$MaximumInstances = 2
# Opening the second instance is itself an access check against the existing
# pipe DACL (FILE_CREATE_PIPE_INSTANCE). ReadWrite alone is not enough: the
# second New-SecurePipe fails with "Access to the path is denied".
$PipeAccessRights = [System.IO.Pipes.PipeAccessRights]::ReadWrite -bor [System.IO.Pipes.PipeAccessRights]::CreateNewInstance
# Stage timings are reported with `ready` so a starved start shows which part
# of the relay lost the CPU instead of appearing as an unexplained timeout.
$Clock = [System.Diagnostics.Stopwatch]::StartNew()

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
  $accessRule = [System.IO.Pipes.PipeAccessRule]::new(
    $ownerSid,
    $PipeAccessRights,
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
    $MaximumInstances,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,
    $MaximumMessageLength,
    $MaximumMessageLength,
    $Security
  )
}

function Get-PipeSddl {
  param([System.IO.Pipes.NamedPipeServerStream]$Pipe)
  $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
  return $Pipe.GetAccessControl().GetSecurityDescriptorSddlForm($sections)
}

# The OS applies the descriptor of the first instance to every later instance of
# the same name, and nothing in the constructor makes that visible. Reading it
# back is the only way to prove the pre-built instance is not weaker than the
# one already serving, so a mismatch is treated as a security failure instead of
# being assumed away.
function New-VerifiedSecurePipe {
  param(
    [System.IO.Pipes.PipeSecurity]$Security,
    [string]$ExpectedSddl
  )
  $instance = New-SecurePipe -Security $Security
  if ([string]::IsNullOrEmpty($ExpectedSddl)) {
    return $instance
  }
  try {
    $actualSddl = Get-PipeSddl -Pipe $instance
  } catch {
    try { $instance.Dispose() } catch { }
    throw [System.Security.SecurityException]::new("The Agent pipe security descriptor could not be read: $($_.Exception.Message)")
  }
  if ($actualSddl -ne $ExpectedSddl) {
    try { $instance.Dispose() } catch { }
    throw [System.Security.SecurityException]::new('The Agent pipe security descriptor changed between instances.')
  }
  return $instance
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
    -and (($rule.PipeAccessRights -band $PipeAccessRights) -eq $PipeAccessRights)
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
$daclMilliseconds = $Clock.ElapsedMilliseconds

$pipePath = "\\.\pipe\$PipeName"
$pipe = New-VerifiedSecurePipe -Security $pipeSecurity.Security -ExpectedSddl $null
# Every later instance is compared against this descriptor, so the value comes
# from the first pipe itself rather than from the object that was passed in.
$expectedSddl = Get-PipeSddl -Pipe $pipe
$spare = $null
$preBuildFailureReported = $false
try {
  $spare = New-VerifiedSecurePipe -Security $pipeSecurity.Security -ExpectedSddl $expectedSddl
} catch {
  # Availability first: a relay that cannot pre-build still serves from one
  # instance, and the reason is reported once instead of being swallowed.
  [Console]::Error.WriteLine("NamiMail Agent pipe pre-build failure: $($_.Exception.Message)")
  $preBuildFailureReported = $true
}
$pipeMilliseconds = $Clock.ElapsedMilliseconds - $daclMilliseconds

Write-ParentMessage @{
  type = 'ready'
  pipeName = $PipeName
  path = $pipePath
  ownerSid = $pipeSecurity.OwnerSid
  daclProtected = $true
  ownerOnly = $true
  accessRuleCount = 1
  pid = $PID
  stageTimings = @{
    daclMs = $daclMilliseconds
    pipeMs = $pipeMilliseconds
    readyMs = $Clock.ElapsedMilliseconds - $daclMilliseconds - $pipeMilliseconds
  }
}

function Test-PreBuildFailureIsSecurityRelevant {
  param($ErrorRecord)
  return $ErrorRecord.Exception -is [System.Security.SecurityException] `
    -or $ErrorRecord.Exception.InnerException -is [System.Security.SecurityException]
}

while ($true) {
  # Keep one instance listening while the other serves. If the pre-built one is
  # missing, try again before accepting: doing it here never leaves the name
  # unregistered, because the serving instance still exists.
  if ($null -eq $spare) {
    try {
      $spare = New-VerifiedSecurePipe -Security $pipeSecurity.Security -ExpectedSddl $expectedSddl
      $preBuildFailureReported = $false
    } catch {
      if (Test-PreBuildFailureIsSecurityRelevant -ErrorRecord $_) {
        # An instance whose descriptor differs from the verified one must never
        # serve traffic, and without a replacement the current instance cannot
        # be released safely, so stop rather than continue unverified.
        [Console]::Error.WriteLine("NamiMail Agent pipe stopped: $($_.Exception.Message)")
        break
      }
      if (-not $preBuildFailureReported) {
        [Console]::Error.WriteLine("NamiMail Agent pipe pre-build failure: $($_.Exception.Message)")
        $preBuildFailureReported = $true
      }
    }
  }
  $reader = $null
  $writer = $null
  try {
    $pipe.WaitForConnection()
    $reader = [System.IO.StreamReader]::new($pipe, $Utf8, $false, $MaximumMessageLength, $true)
    $writer = [System.IO.StreamWriter]::new($pipe, $Utf8, $MaximumMessageLength, $true)
    $writer.AutoFlush = $true
    $request = Read-PipeRequest -Reader $reader
    if ($request.TimedOut) {
      # A client that connects and never sends holds one instance for at most
      # this long (RequestReadTimeoutMilliseconds); the other instance stays
      # connectable meanwhile, so a silent client cannot take the relay down.
      $writer.WriteLine('{"type":"response","error":"request-timeout"}')
    } elseif ($null -eq $request.Payload -or $request.Payload.Length -gt $MaximumMessageLength) {
      $writer.WriteLine('{"type":"response","error":"invalid-request"}')
    } else {
      $connectionId = [Guid]::NewGuid().ToString('N')
      Write-ParentMessage @{ type = 'request'; connectionId = $connectionId; payload = $request.Payload }
      $responsePayload = Read-ParentResponse -ConnectionId $connectionId
      if ($null -eq $responsePayload) {
        $writer.WriteLine('{"type":"response","error":"broker-unavailable"}')
      } else {
        $writer.WriteLine($responsePayload)
      }
    }
  } catch {
    [Console]::Error.WriteLine("NamiMail Agent pipe failure: $($_.Exception.Message)")
  } finally {
    # A client can close immediately after reading a response. The pre-built
    # instance is already registered, so releasing this one cannot make the name
    # disappear: the next iteration adopts it and builds the replacement.
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
    $pipe = $spare
    $spare = $null
  }
  if ($null -eq $pipe) {
    try {
      $pipe = New-VerifiedSecurePipe -Security $pipeSecurity.Security -ExpectedSddl $expectedSddl
    } catch {
      [Console]::Error.WriteLine("NamiMail Agent pipe restart failure: $($_.Exception.Message)")
      break
    }
  }
}
