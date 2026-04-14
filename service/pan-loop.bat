@echo off
:: PAN Respawn Loop
:: Uses full System32 paths to bypass git bash PATH shadowing of timeout
set "SYS=%SystemRoot%\System32"
cd /d "%~dp0"

:RESPAWN
echo.
echo [PAN Server] --- Starting Node.js Server ---
echo.
node pan.js start
if %ERRORLEVEL% EQU 0 (
    echo [PAN Server] Clean exit.
    "%SYS%\timeout.exe" /t 5 /nobreak
    exit /b 0
)
echo.
echo [PAN Server] !!! SERVER CRASHED - Exit code: %ERRORLEVEL% !!!
echo [PAN Server] Restarting in 5s... (close this window to stop)
echo.
"%SYS%\timeout.exe" /t 5 /nobreak >NUL
goto RESPAWN
