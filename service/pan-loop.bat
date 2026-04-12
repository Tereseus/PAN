@echo off
:: PAN Respawn Loop — restarts node on crash, stops on clean exit (code 0)
:: Called by PAN.bat in its own CMD window. Closing this window stops PAN.

cd /d "%~dp0"
echo %PID% > .pan-server.lock

:RESPAWN
echo [PAN Server] starting node...
node pan.js start
if %ERRORLEVEL% EQU 0 (
    echo [PAN Server] clean exit — stopping restart loop
    goto DONE
)
echo [PAN Server] exited with code %ERRORLEVEL%, restarting in 2s...
timeout /t 2 /nobreak >NUL
goto RESPAWN

:DONE
del /f .pan-server.lock >NUL 2>&1
