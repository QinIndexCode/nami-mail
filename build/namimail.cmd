@echo off
setlocal
"%~dp0Nami Mail.exe" --cli %*
exit /b %ERRORLEVEL%
