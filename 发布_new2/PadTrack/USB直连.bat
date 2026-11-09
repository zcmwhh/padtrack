@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
rem adb 默认把日志写到 %TEMP%，部分机器没权限会起不来，指到本地目录
if not exist "%~dp0tools\tmp" mkdir "%~dp0tools\tmp" >nul 2>nul
set "TMP=%~dp0tools\tmp"
set "TEMP=%~dp0tools\tmp"

set "ADB=%~dp0tools\platform-tools\adb.exe"
if exist "%ADB%" goto :have_adb

echo 没有找到 adb，尝试下载 platform-tools...
if not exist "%~dp0tools" mkdir "%~dp0tools" >nul 2>nul
del /q "%~dp0tools\pt.zip" >nul 2>nul
curl.exe -sSL --max-time 180 -o "%~dp0tools\pt.zip" "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
if exist "%~dp0tools\pt.zip" goto :unzip
echo Google 下载不到，换腾讯镜像...
curl.exe -sSL --max-time 180 -o "%~dp0tools\pt.zip" "https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools-latest-windows.zip"
:unzip
if not exist "%~dp0tools\pt.zip" goto :no_adb
powershell -NoProfile -Command "Expand-Archive -Path '%~dp0tools\pt.zip' -DestinationPath '%~dp0tools' -Force"
del /q "%~dp0tools\pt.zip" >nul 2>nul
:have_adb
if not exist "%ADB%" goto :no_adb

echo.
echo === 检查平板连接 ===
rem 先清掉可能卡死的 adb 进程：服务端卡住时 adb devices 会一直等，表现为脚本没反应
taskkill /f /im adb.exe >nul 2>nul
ping -n 2 127.0.0.1 >nul
"%ADB%" start-server >nul 2>nul
set "DEV="
for /f "skip=1 tokens=1,2" %%a in ('"%ADB%" devices') do (
  if "%%b"=="device" set "DEV=%%a"
)
if not defined DEV goto :no_device
echo 检测到设备: %DEV%

echo.
echo === 建立 USB 端口映射 ===
"%ADB%" reverse --remove-all >nul 2>nul
"%ADB%" reverse tcp:8765 tcp:8765
if errorlevel 1 goto :reverse_fail
"%ADB%" reverse --list

set "KEY="
if exist "%~dp0key.txt" for /f "usebackq delims=" %%k in ("%~dp0key.txt") do set "KEY=%%k"

echo.
echo ============================================================
echo   USB 直连已就绪
echo ============================================================
echo   在平板浏览器打开：
echo       http://127.0.0.1:8765/?k=%KEY%
echo.
echo   这个地址走 USB 线，不经过 WiFi，延迟一般在 1ms 以内。
echo.
echo   注意：
echo     - PadTrack 服务必须已经在电脑上跑着
echo     - 拔线或重启电脑后，要重新运行本脚本
echo     - 平板连不上就先刷新一次页面
echo ============================================================
echo.
pause
exit /b 0

:no_adb
echo.
echo 没有可用的 adb。手动下载 platform-tools 解压到 tools\platform-tools\ 再运行：
echo   https://dl.google.com/android/repository/platform-tools-latest-windows.zip
pause
exit /b 1

:no_device
echo.
echo 没有检测到已授权的设备，请确认：
echo   1. 数据线插好（不是只能充电的线）
echo   2. 平板上「开发者选项 - USB 调试」已打开
echo   3. 平板弹出的「允许 USB 调试」点了允许
echo.
"%ADB%" devices
pause
exit /b 1

:reverse_fail
echo.
echo 端口映射失败，试试拔插一次数据线再运行。
pause
exit /b 1
