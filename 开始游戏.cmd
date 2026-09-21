@echo off
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

>>"%~dp0launch.log" echo [%date% %time%] CMD entry started.

set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE%" goto run_game

set "NODE="
for /f "delims=" %%I in ('where.exe node.exe 2^>nul') do if not defined NODE set "NODE=%%I"
if defined NODE goto run_game

>>"%~dp0launch.log" echo [%date% %time%] ERROR: node.exe was not found.
echo.
echo IRONFALL could not start because Node.js was not found.
echo See: %~dp0launch.log
pause
exit /b 2

:run_game
>>"%~dp0launch.log" echo [%date% %time%] Using Node: %NODE%
"%NODE%" "%~dp0tools\launch-app.mjs" >>"%~dp0launch.log" 2>&1
set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" exit /b 0

>>"%~dp0launch.log" echo [%date% %time%] ERROR: launcher exited with code %RESULT%.
echo.
echo IRONFALL failed to start. Error code: %RESULT%
echo See: %~dp0launch.log
echo.
powershell.exe -NoLogo -NoProfile -Command "Get-Content -LiteralPath '%~dp0launch.log' -Encoding UTF8 -Tail 16"
pause
exit /b %RESULT%
