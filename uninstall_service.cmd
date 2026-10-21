@echo off
rem One-click uninstaller wrapper: bypasses PowerShell execution policy.
rem Usage: double-click, or run from cmd/PowerShell as .\uninstall_service.cmd
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_service.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" echo [FAILED] exit code %EXITCODE%
pause
exit /b %EXITCODE%
