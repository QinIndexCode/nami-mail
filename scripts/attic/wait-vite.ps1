for ($i = 0; $i -lt 90; $i++) {
  if (Select-String -Path 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\vite-web.log' -Pattern 'VITE WEB BUILD DONE' -Quiet) { echo 'DONE'; break }
  if (Select-String -Path 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\vite-web.log' -Pattern 'error' -Quiet) { echo 'ERROR'; break }
  Start-Sleep -Seconds 2
}
Get-Content 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\vite-web.log' -Tail 15
