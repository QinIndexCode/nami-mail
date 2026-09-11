$env:NODE_PRESERVE_SYMLINKS = '1'
$root = 'd:\MyCode\nami-workspace\nami-mail-agent'
Push-Location $root
$bin = Join-Path $root 'node_modules\.bin\electron.cmd'
Start-Process -FilePath $bin -ArgumentList '.', '--remote-debugging-port=9222' -RedirectStandardOutput (Join-Path $root 'scripts\desktop-run2.log') -RedirectStandardError (Join-Path $root 'scripts\desktop-run2.err') -NoNewWindow
Pop-Location
echo 'launched with NODE_PRESERVE_SYMLINKS=1'
