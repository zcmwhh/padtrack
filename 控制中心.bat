@echo off
chcp 936 >nul
cd /d "%~dp0"

rem 用 -WindowStyle Hidden 起 PowerShell，避免多一个黑框
if not exist "%~dp0PadTrack控制台.ps1" (
  echo 找不到 PadTrack控制台.ps1，请确认文件和本脚本在同一目录。
  pause
  exit /b 1
)
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0PadTrack控制台.ps1"
exit /b 0
