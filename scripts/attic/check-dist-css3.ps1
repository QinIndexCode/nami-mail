$css = Resolve-Path 'd:\MyCode\nami-workspace\nami-mail-agent\apps\web\dist\assets\*.css'
$c = Get-Content $css -Raw
$idx = $c.IndexOf('.desktop-app .window-bar')
if ($idx -ge 0) {
  $end = $c.IndexOf('}', $idx)
  echo $c.Substring($idx, $end - $idx + 1)
} else {
  echo 'NO .desktop-app .window-bar in dist'
}
