@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 带了 /elevated 参数说明是提权后重新进来的
set "ELEV=0"
if /i "%~1"=="/elevated" set "ELEV=1"

set "FOUND=0"
set "DENIED=0"

rem 1) 先按 pid 文件杀
if exist "padtrack.pid" (
  set "PID="
  for /f "usebackq tokens=1 delims= " %%L in ("padtrack.pid") do set "PID=%%L"
  if defined PID (
    taskkill /f /pid !PID! >nul 2>nul
    if errorlevel 1 (
      echo [警告] 结束 PID !PID! 失败（多半是管理员权限启动的）
      set "DENIED=1"
    ) else (
      echo [ok] 已结束 PID !PID!
      set "FOUND=1"
    )
  )
  del /q "padtrack.pid" >nul 2>nul
)

rem 2) 再扫端口兜底
for %%o in (8765 8766 8767 8768) do call :killport %%o

rem 3) 有杀不掉的，就提权重来一遍
if "%DENIED%"=="1" (
  if "%ELEV%"=="0" (
    echo.
    echo 需要管理员权限，正在申请提权……（会弹出确认框，点“是”）
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '/elevated' -Verb RunAs" >nul 2>nul
    exit /b 0
  ) else (
    echo.
    echo 提权后仍然结束不掉，可能已被别的东西占用，重启电脑最稳。
  )
)

if "%FOUND%"=="0" if "%DENIED%"=="0" echo 没有发现正在运行的 PadTrack。
echo.
ping -n 3 127.0.0.1 >nul
exit /b 0

:killport
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%1 " ^| findstr /c:"LISTENING"') do (
  taskkill /f /pid %%p >nul 2>nul
  if errorlevel 1 (
    echo [警告] 端口 %1 上的进程 %%p 结束失败
    set "DENIED=1"
  ) else (
    echo [ok] 已结束端口 %1 上的进程 %%p
    set "FOUND=1"
  )
)
exit /b
