$dir = 'd:\MyCode\nami-workspace\nami-mail-agent\scripts'
Get-ChildItem $dir -Filter 'kill-all.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'wait-cdp.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'copy-workspace-deps.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'build-desktop.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'desktop-build.log' | Remove-Item -Force
Get-ChildItem $dir -Filter 'desktop-fixed.log' | Remove-Item -Force
Get-ChildItem $dir -Filter 'vite-web.log' | Remove-Item -Force
Write-Host 'cleaned'
