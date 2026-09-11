$css = Resolve-Path 'd:\MyCode\nami-workspace\nami-mail-agent\apps\web\dist\assets\index-*.css'
$c = Get-Content $css -Raw
$idx = $c.IndexOf('.desktop-app .window-bar')
if ($idx -ge 0) {
  $end = $c.IndexOf('}', $idx)
  echo ('FOUND: ' + $c.Substring($idx, $end - $idx + 1))
} else {
  echo 'NOT FOUND'
}
