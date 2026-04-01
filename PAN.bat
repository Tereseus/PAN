@echo off
:: PAN Launcher — starts server and opens dashboard
:: Double-click this or type "PAN" from Start Menu

cd /d "%~dp0service"

:: Check if PAN is already running
curl -s -o NUL -w "%%{http_code}" http://127.0.0.1:7777/health > "%TEMP%\pan-health.txt" 2>NUL
set /p HEALTH=<"%TEMP%\pan-health.txt"
del "%TEMP%\pan-health.txt" 2>NUL

if "%HEALTH%"=="200" (
    echo [PAN] Already running — opening dashboard
    :: Ensure Steward is running even if server was already up
    tasklist /FI "IMAGENAME eq AutoHotkey64.exe" 2>NUL | find "AutoHotkey64" >NUL || (
        echo [PAN] Steward not running — restarting...
        start /b "" powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0service\src\watchdog.ps1"
    )
    start "" "http://127.0.0.1:7777/dashboard/"
    exit /b 0
)

echo [PAN] Starting server...
start /b "" node pan.js start

echo [PAN] Starting Steward...
start /b "" powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0service\src\watchdog.ps1"

:: Wait for server to come up (max 15 seconds)
set ATTEMPTS=0
:WAIT
set /a ATTEMPTS+=1
if %ATTEMPTS% GTR 15 (
    echo [PAN] Server did not start in time — check terminal
    pause
    exit /b 1
)
timeout /t 1 /nobreak >NUL
curl -s -o NUL http://127.0.0.1:7777/health 2>NUL && goto READY
goto WAIT

:READY
echo [PAN] Server running — opening dashboard
start "" "http://127.0.0.1:7777/dashboard/"
