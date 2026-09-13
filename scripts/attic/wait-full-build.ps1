$log = 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\full-build.log'
for ($i = 0; $i -lt 240; $i++) {
  if (Select-String -Path $log -Pattern 'npm error' -Quiet) { echo 'BUILD ERROR'; break }
  if (Select-String -Path $log -Pattern 'added|up to date|prepared' -Quiet) { }
  # 完整 build 结束特征：最后一行包含某个 workspace 的 build 完成且无 error
  if ((Select-String -Path $log -Pattern '> @nami/desktop@0.3.0 build' -Quiet) -and (Select-String -Path $log -Pattern 'npm error' -Quiet)) { echo 'DESKTOP BUILD ERROR'; break }
  if (Select-String -Path $log -Pattern 'ELIFECYCLE' -Quiet) { echo 'LIFECYCLE ERROR'; break }
  Start-Sleep -Seconds 3
}
Get-Content $log -Tail 30
