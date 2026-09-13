$css = Resolve-Path 'd:\MyCode\nami-workspace\nami-mail-agent\apps\web\dist\assets\*.css'
$c = Get-Content $css -Raw
if ($c -match 'no-drag') { echo 'has no-drag' } else { echo 'NO no-drag' }
$m = [regex]::Match($c, 'window-bar\{[^}]*?-webkit-app-region:([a-z]+)[^}]*?width:([0-9]+)px')
if ($m.Success) {
  echo ('region=' + $m.Groups[1].Value + ' width=' + $m.Groups[2].Value)
} else {
  echo 'pattern-not-found'
}
