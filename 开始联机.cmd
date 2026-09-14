@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

>>"%~dp0launch.log" echo [%date% %time%] LAN entry started.

set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE%" goto run_lan

set "NODE=%LOCALAPPDATA%\IRONFALL\runtime\node.exe"
if exist "%NODE%" goto run_lan

set "NODE="
for /d %%D in ("%LOCALAPPDATA%\IRONFALL\runtime\node-*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"
if defined NODE goto run_lan
for /f "delims=" %%I in ('where.exe node.exe 2^>nul') do if not defined NODE set "NODE=%%I"
if defined NODE goto run_lan

>>"%~dp0launch.log" echo [%date% %time%] ERROR: node.exe was not found.
echo.
echo IRONFALL LAN could not start because Node.js was not found.
echo See: %~dp0launch.log
pause
exit /b 2

:run_lan
set "IRONFALL_LAN_PORT=18200"
if not "%IRONFALL_PORT%"=="" set "IRONFALL_LAN_PORT=%IRONFALL_PORT%"
>>"%~dp0launch.log" echo [%date% %time%] Using Node: %NODE%  port: %IRONFALL_LAN_PORT%
"%NODE%" "%~dp0tools\lan-server.mjs" %IRONFALL_LAN_PORT% --open 2>"%~dp0lan-error.log"
set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" exit /b 0

>>"%~dp0launch.log" echo [%date% %time%] ERROR: LAN server exited with code %RESULT%.
echo.
echo IRONFALL LAN server failed to start. Error code: %RESULT%
echo See: %~dp0launch.log
echo.
type "%~dp0lan-error.log"
pause
exit /b %RESULT%
