@echo off
chcp 936 >nul
cd /d "%~dp0"

rem 优先走 vbs（零闪），没有就退回直接起 powershell
if exist "%~dp0控制中心.vbs" (
  start "" wscript.exe //nologo "%~dp0控制中心.vbs"
  exit /b 0
)
if not exist "%~dp0PadTrack控制台.ps1" (
  echo 找不到 PadTrack控制台.ps1
  pause
  exit /b 1
)
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0PadTrack控制台.ps1"
exit /b 0
