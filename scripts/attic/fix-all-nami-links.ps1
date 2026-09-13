$root = 'd:\MyCode\nami-workspace\nami-mail-agent'
$nmNami = Join-Path $root 'node_modules\@nami'

Get-ChildItem $nmNami -Force | ForEach-Object {
  $link = $_.FullName
  # 找到它真实指向的 packages/apps 源目录
  $target = $_.Target
  if (-not $target) { Write-Host ($_.Name + ': no target, skip'); return }
  if (-not (Test-Path $target)) { Write-Host ($_.Name + ': target missing ' + $target + ', skip'); return }
  $lt = (Get-Item $link -Force).LinkType
  Write-Host ($_.Name + ': LinkType=' + $lt + ' -> ' + $target)
  if ($lt -eq 'Junction') {
    Remove-Item $link -Force -Recurse
    Copy-Item -Path $target -Destination $link -Recurse -Force
    Write-Host ('  -> copied real dir')
  }
}
Write-Host 'DONE'
