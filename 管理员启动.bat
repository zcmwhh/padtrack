@echo off
rem 以管理员身份启动 PadTrack。
rem 需要它来操作「以管理员身份运行」的程序（例如 WattToolkit / Steam++），
rem 否则 Windows 的 UIPI 会丢掉我们发的输入。
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0PadTrack.exe' -Verb RunAs"