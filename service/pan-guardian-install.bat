@echo off
:: Registers pan-guardian.ps1 as a Windows Task Scheduler task.
:: Run once as Administrator. After that, Windows owns it — completely outside PAN.

set "SCRIPT=%~dp0pan-guardian.ps1"
set "TASKNAME=PAN Guardian"

echo [PAN Guardian] Installing scheduled task...

:: Remove old task if it exists
schtasks /Delete /TN "%TASKNAME%" /F >nul 2>&1

:: Create task: runs at logon + triggers every 1 min indefinitely
schtasks /Create /TN "%TASKNAME%" ^
  /TR "powershell.exe -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%SCRIPT%\"" ^
  /SC ONLOGON ^
  /DELAY 0000:30 ^
  /RL HIGHEST ^
  /F

if %ERRORLEVEL% NEQ 0 (
    echo [PAN Guardian] ERROR: Failed to create task. Try running as Administrator.
    pause
    exit /b 1
)

echo [PAN Guardian] Task installed. Starting now...
schtasks /Run /TN "%TASKNAME%"

echo.
echo [PAN Guardian] Done. Task will auto-start at every login.
echo   Name:   %TASKNAME%
echo   Script: %SCRIPT%
echo   Check:  Task Scheduler ^> Task Scheduler Library ^> PAN Guardian
echo.
pause
