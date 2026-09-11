$dir = 'd:\MyCode\nami-workspace\nami-mail-agent\scripts'
Get-ChildItem $dir -Filter 'diag-*.mjs' | Remove-Item -Force
Get-ChildItem $dir -Filter 'diag-*.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'kill-all.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'check-procs.ps1' | Remove-Item -Force
Get-ChildItem $dir -Filter 'vite-build-web.ps1' | Remove-Item -Force
Write-Host 'cleaned'
