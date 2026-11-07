@echo off
rem One-click updater: compares remote version, downloads changes, then restarts the service.
rem Usage: double-click, or run .\update.cmd [--check] [--no-restart]
setlocal
cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PY=%~dp0.venv\Scripts\python.exe"
) else (
    set "PY=python"
)
"%PY%" "%~dp0update.py" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" echo [FAILED] exit code %EXITCODE%
pause
exit /b %EXITCODE%
