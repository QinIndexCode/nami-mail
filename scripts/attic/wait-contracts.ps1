for ($i = 0; $i -lt 60; $i++) {
  if (Select-String -Path 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-contracts.log' -Pattern 'CONTRACTS BUILD DONE' -Quiet) { echo 'DONE'; break }
  if (Select-String -Path 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-contracts.log' -Pattern 'error' -Quiet) { echo 'ERROR'; break }
  Start-Sleep -Seconds 2
}
Get-Content 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-contracts.log' -Tail 12
