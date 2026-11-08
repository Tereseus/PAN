@echo off
REM PAN Link hub (pan-link), started at boot by the PAN-Link scheduled task as SYSTEM.
REM It lives in <PAN folder>\pan-link\, next to PAN's data folder, which holds link.json
REM (the hub key, the link secret and the paired devices); PAN reads the secret from there.
REM If pan-link stops, it starts again after about 5 s. To stop it for good:
REM   schtasks /end /tn PAN-Link   (ends this launcher and pan-link with it)
setlocal
for %%I in ("%~dp0..\data") do set "PAN_DATA_DIR=%%~fI"
if not exist "%PAN_DATA_DIR%\" (
  echo [pan-link] FATAL: no PAN data folder at "%PAN_DATA_DIR%"
  exit /b 1
)
:loop
echo [pan-link] start %DATE% %TIME%>> "%PAN_DATA_DIR%\pan-link.log"
"%~dp0pan-link.exe" hub --data "%PAN_DATA_DIR%" --name "PAN hub" >> "%PAN_DATA_DIR%\pan-link.log" 2>&1
echo [pan-link] stopped, code %ERRORLEVEL%, %DATE% %TIME%>> "%PAN_DATA_DIR%\pan-link.log"
REM About 5 s. timeout.exe won't run without a console, ping does.
ping -n 6 127.0.0.1 > nul
goto loop
