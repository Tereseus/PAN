@echo off
REM PAN Link on a second computer (pan-link client), started at boot by the
REM PAN-Link-Client scheduled task as SYSTEM. It lives in <PAN folder>\pan-link\; the
REM pairing (client.json, which holds this computer's private key) is in
REM <PAN folder>\link-client\. PAN on the hub is then at http://127.0.0.1:7779 here: point
REM this computer's PAN tools there (PAN_BASE_URL for the MCP server, the client's hub URL).
REM If pan-link stops, it starts again after about 5 s. To stop it for good:
REM   schtasks /end /tn PAN-Link-Client   (ends this launcher and pan-link with it)
setlocal
for %%I in ("%~dp0..\link-client") do set "LINK_DIR=%%~fI"
if not exist "%LINK_DIR%\client.json" (
  echo [pan-link client] FATAL: not paired, no "%LINK_DIR%\client.json"
  exit /b 1
)
if "%PAN_LINK_LISTEN%"=="" set "PAN_LINK_LISTEN=127.0.0.1:7779"
:loop
echo [pan-link client] start %DATE% %TIME%>> "%LINK_DIR%\pan-link-client.log"
"%~dp0pan-link.exe" client --data "%LINK_DIR%" --listen %PAN_LINK_LISTEN% %PAN_LINK_EXTRA% >> "%LINK_DIR%\pan-link-client.log" 2>&1
echo [pan-link client] stopped, code %ERRORLEVEL%, %DATE% %TIME%>> "%LINK_DIR%\pan-link-client.log"
REM About 5 s. timeout.exe won't run without a console, ping does.
ping -n 6 127.0.0.1 > nul
goto loop
