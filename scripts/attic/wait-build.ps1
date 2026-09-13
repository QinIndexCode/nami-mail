$log = 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-web-desktop.log'
for ($i = 0; $i -lt 150; $i++) {
  if (Select-String -Path $log -Pattern 'BUILD DONE' -Quiet) { echo 'BUILD DONE'; break }
  if (Select-String -Path $log -Pattern 'ELIFECYCLE' -Quiet) { echo 'BUILD ERROR'; break }
  Start-Sleep -Seconds 2
}
Get-Content $log -Tail 18
