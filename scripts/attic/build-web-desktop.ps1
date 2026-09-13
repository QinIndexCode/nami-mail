# 仅构建 web 与 desktop workspace，供 Electron 加载最新产物
$ErrorActionPreference = 'Stop'
$root = 'd:\MyCode\nami-workspace\nami-mail-agent'

Write-Host '==> build web'
Push-Location $root
npm --workspace @nami/web run build
Write-Host '==> build desktop'
npm --workspace @nami/desktop run build
Pop-Location
Write-Host 'BUILD DONE'
