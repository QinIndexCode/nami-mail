$ErrorActionPreference = 'Continue'
$root = 'd:\MyCode\nami-workspace\nami-mail-agent'
Push-Location $root
Write-Host '==> build agent-contracts'
npm --workspace @nami/agent-contracts run build 2>&1 | Tee-Object -FilePath 'd:\MyCode\nami-workspace\nami-mail-agent\scripts\build-contracts.log'
Pop-Location
Write-Host 'CONTRACTS BUILD DONE'
