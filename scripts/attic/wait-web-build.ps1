for ($i = 0; $i -lt 120; $i++) {
  if (Select-String -Path 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-web.log' -Pattern 'WEB BUILD ATTEMPT DONE' -Quiet) { echo 'WEB BUILD DONE'; break }
  if (Select-String -Path 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-web.log' -Pattern 'error TS' -Quiet) { echo 'WEB TS ERROR (but vite may still run)'; break }
  Start-Sleep -Seconds 2
}
Get-Content 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-web.log' -Tail 20
