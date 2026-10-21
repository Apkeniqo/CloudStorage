@echo off
rem One-click self check: environment, config, dirs, database and the running service.
setlocal
cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PY=%~dp0.venv\Scripts\python.exe"
) else (
    set "PY=python"
)
"%PY%" "%~dp0selfcheck.py" %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
