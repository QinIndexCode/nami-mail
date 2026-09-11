$root = 'd:\MyCode\nami-workspace\nami-mail-agent'
$link = Join-Path $root 'node_modules\@nami\agent-contracts'
$target = Join-Path $root 'packages\agent-contracts'

# 移除 junction，改成真实目录拷贝（避免 Node ESM 对 junction 的解析 bug）
if (Test-Path $link) {
  $i = Get-Item $link -Force
  Write-Host ('current LinkType=' + $i.LinkType)
  Remove-Item $link -Force -Recurse
  Write-Host 'removed junction'
}
# 拷贝真实目录
Copy-Item -Path $target -Destination $link -Recurse -Force
Write-Host 'copied real dir'
$i2 = Get-Item $link -Force
Write-Host ('now LinkType=' + $i2.LinkType + ' exists=' + (Test-Path (Join-Path $link 'dist\index.d.ts')))
