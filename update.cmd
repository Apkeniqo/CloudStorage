@echo off
rem One-click updater: compares remote version, downloads changes, restarts the service.
rem Usage: double-click, or run .\update.cmd [--check] [--no-restart]
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "EXITCODE="

rem 1) Prefer the project venv, but verify it actually runs (a broken venv must not block updates)
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        "%~dp0.venv\Scripts\python.exe" "%~dp0update.py" %*
        set "EXITCODE=!ERRORLEVEL!"
        goto :done
    )
    echo [WARN] .venv\Scripts\python.exe cannot run, falling back to system Python.
    echo        Rebuild it later with: py -3 -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
)

rem 2) py launcher
where py >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        py -3 "%~dp0update.py" %*
        set "EXITCODE=!ERRORLEVEL!"
        goto :done
    )
)

rem 3) plain python on PATH
python -c "import sys" >nul 2>&1
if not errorlevel 1 (
    python "%~dp0update.py" %*
    set "EXITCODE=!ERRORLEVEL!"
    goto :done
)

echo [ERROR] No usable Python found. Install Python 3.9+ or rebuild .venv.
set "EXITCODE=1"

:done
echo.
if not "!EXITCODE!"=="0" echo [FAILED] exit code !EXITCODE!
pause
exit /b !EXITCODE!
