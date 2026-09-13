$log = 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\dev-desktop-full.log'
$ready = $false
for ($i = 0; $i -lt 180; $i++) {
  if (Select-String -Path $log -Pattern 'App threw an error' -Quiet) { echo 'APP ERROR'; break }
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 2
    if ($r) { echo 'CDP-READY'; $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  echo '--- tail log ---'
  Get-Content $log -Tail 25 -ErrorAction SilentlyContinue
}
