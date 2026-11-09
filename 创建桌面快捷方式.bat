@echo off
chcp 936 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0桌面快捷方式.ps1"
echo.
pause
