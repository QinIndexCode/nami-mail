$root = 'd:\MyCode\nami-workspace\nami-mail-agent'
$js = Resolve-Path "$root\apps\web\dist\assets\index-*.js"
$css = Resolve-Path "$root\apps\web\dist\assets\*.css"
$jc = Get-Content $js -Raw
$cc = Get-Content $css -Raw

$bareCount = ([regex]::Matches($jc, '@nami/agent-contracts')).Count
echo ('JS @nami/agent-contracts occurrences: ' + $bareCount)

$idx = $cc.IndexOf('.desktop-app .window-bar')
if ($idx -ge 0) {
  $end = $cc.IndexOf('}', $idx)
  echo ('CSS: ' + $cc.Substring($idx, $end - $idx + 1))
} else {
  echo 'CSS: no .desktop-app .window-bar found'
}
