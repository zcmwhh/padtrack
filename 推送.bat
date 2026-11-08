@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   推送到 https://github.com/zcmwhh/padtrack
echo ============================================
echo.

echo [1/2] 先用默认方式推送...
git push -u origin main
if not errorlevel 1 goto ok

echo.
echo [2/2] 失败，改用 Windows 证书库重试...
git config --local http.sslBackend schannel
git push -u origin main
if not errorlevel 1 goto ok

echo.
echo --------------------------------------------
echo 两次都失败了。请把窗口里的报错截图发给助手。
echo --------------------------------------------
goto end

:ok
echo.
echo ============================================
echo   推送成功
echo   https://github.com/zcmwhh/padtrack
echo ============================================

:end
echo.
pause