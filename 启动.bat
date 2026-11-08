@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PY=python"
where python >nul 2>nul || (
  echo [!] Python not found. Install Python 3.9+ first.
  pause
  exit /b 1
)

echo Starting PadTrack (port 8765)...
"%PY%" -u server.py --port 8765 %*
echo.
pause