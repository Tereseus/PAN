@echo off
echo [PAN DEBUG] --- STARTING PAN IN FOREGROUND ---
echo.

set "PAN_ROOT=%~dp0"
set "PAN_SERVICE=%~dp0service"

echo [PAN DEBUG] Root: %PAN_ROOT%
echo [PAN DEBUG] Service: %PAN_SERVICE%
echo.

echo [PAN DEBUG] Step 1: Checking Node.js version...
node -v
if %ERRORLEVEL% NEQ 0 (
    echo [PAN DEBUG] ERROR: Node.js not found in PATH!
    pause
    exit /b 1
)

echo.
echo [PAN DEBUG] Step 2: Checking for existing port 7777...
netstat -ano | findstr ":7777 " | findstr "LISTENING"
if %ERRORLEVEL% EQU 0 (
    echo [PAN DEBUG] WARNING: Something is already on port 7777.
) else (
    echo [PAN DEBUG] Port 7777 is free.
)

echo.
echo [PAN DEBUG] Step 3: Checking dependencies in service/node_modules...
if not exist "%PAN_SERVICE%\node_modules" (
    echo [PAN DEBUG] ERROR: node_modules folder is missing!
    pause
    exit /b 1
)

echo.
echo [PAN DEBUG] Step 4: Starting Node server (foreground)...
echo [PAN DEBUG] Press Ctrl+C to stop.
echo.

cd /d "%PAN_SERVICE%"
node pan.js start

echo.
echo [PAN DEBUG] Server exited with code: %ERRORLEVEL%
echo.
pause
