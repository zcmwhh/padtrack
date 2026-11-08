@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "FOUND="

rem 1) kill by pid file first
if exist "padtrack.pid" (
  set "PID="
  for /f "usebackq tokens=1 delims= " %%L in ("padtrack.pid") do set "PID=%%L"
  if defined PID (
    taskkill /f /pid !PID! >nul 2>nul
    if errorlevel 1 (
      echo [warn] cannot kill PID !PID! - try running as administrator
    ) else (
      echo [ok] killed PID !PID!
      set "FOUND=1"
    )
  )
  del /q "padtrack.pid" >nul 2>nul
)

rem 2) sweep the port range as a fallback
for %%o in (8765 8766 8767 8768 8769 8770 8771 8772 8773 8774) do call :killport %%o
goto :done

:killport
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%1 " ^| findstr /c:"LISTENING"') do (
  taskkill /f /pid %%p >nul 2>nul
  if errorlevel 1 (
    echo [warn] cannot kill PID %%p on port %1 - try running as administrator
  ) else (
    echo [ok] killed PID %%p on port %1
    set "FOUND=1"
  )
)
exit /b

:done
if not defined FOUND echo nothing was killed (maybe it was not running).
echo.
ping -n 4 127.0.0.1 >nul