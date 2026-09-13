@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

rem ════════════════════════════════════════════════════════════════════════
rem  IRONFALL · 钢铁远征
rem
rem  和开发仓库里的启动方式完全一致（tools/launch-app.mjs + tools/serve.mjs），
rem  只是多了一层：系统里没有 Node.js 时自动下载一个便携版。
rem
rem  效果：独立 App 窗口（没有标签栏 / 地址栏），不会被 Ctrl+W 之类的
rem        浏览器标签页快捷键干扰。
rem ════════════════════════════════════════════════════════════════════════

set "APPDIR=%LOCALAPPDATA%\IRONFALL"
set "RUNTIME=%APPDIR%\runtime"
set "NODE_VER=22.14.0"
set "ZIP=%TEMP%\ironfall-node-%NODE_VER%.zip"
set "URL=https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%~dp0tools\launch-app.mjs" (
  echo.
  echo   [错误] 缺少 tools\launch-app.mjs
  echo   发布包必须解压后再运行，不要在压缩包里直接双击。
  echo.
  pause
  exit /b 1
)

rem ── 1. 找 Node.js（PATH → 标准安装位置 → 之前下载的便携版）──────────
set "NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%RUNTIME%\node.exe" set "NODE=%RUNTIME%\node.exe"
if not defined NODE for /d %%D in ("%RUNTIME%\node-*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"

if defined NODE goto run

rem ── 2. 没有就自动下载便携版（只下一次）─────────────────────────────────
echo.
echo   ==========================================================
echo    本游戏需要 Node.js 运行环境，你的电脑上还没有。
echo    现在自动下载一个便携版（约 30 MB），只下载这一次。
echo.
echo    安装位置: %RUNTIME%
echo    不需要管理员权限，不会修改系统设置。
echo   ==========================================================
echo.

if not exist "%ZIP%" (
  echo   正在下载 Node.js v%NODE_VER% ...
  "%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%' -UseBasicParsing } catch { Write-Host $_.Exception.Message; exit 1 }"
  if errorlevel 1 goto dl_fail
)

echo   正在解压 ...
if not exist "%RUNTIME%" mkdir "%RUNTIME%" >nul 2>nul
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; try { Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%RUNTIME%' -Force } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto ex_fail

for /d %%D in ("%RUNTIME%\node-*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"
if not defined NODE goto dl_fail
echo   完成，运行环境已就绪。

rem ── 3. 交给 launch-app.mjs（与开发环境同一套代码）─────────────────────
rem    --single <html>：告诉它以"单文件游戏"模式启动
rem    （游戏本体是一个自包含 HTML，用 serve-single.mjs 直接吐它）
:run
"%NODE%" "%~dp0tools\launch-app.mjs" --single "%~dp0IRONFALL.html"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo   [提示] 启动器返回码 %RC%
  echo   若游戏窗口没出现，可以手动起服务器：
  echo     "%NODE%" "%~dp0tools\serve-single.mjs" "%~dp0IRONFALL.html" 18080
  echo   然后浏览器打开 http://127.0.0.1:18080/
  echo.
  pause
)
exit /b %RC%

:dl_fail
echo.
echo   [失败] Node.js 下载失败（网络不通或被拦截）。
echo.
echo   手动解决办法（任选其一）：
echo     1. 安装 Node.js: https://nodejs.org/
echo     2. 手动下载这个文件:
echo          %URL%
echo        解压到: %RUNTIME%
echo.
pause
exit /b 2

:ex_fail
echo.
echo   [失败] 解压失败，压缩包可能不完整。
echo   删除 %ZIP% 后重新运行本启动器。
echo.
pause
exit /b 3
