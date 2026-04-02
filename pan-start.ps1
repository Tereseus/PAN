# PAN Startup Script
# 1. PAN service runs as Windows service (auto-starts on boot)
# 2. Start the desktop agent (handles terminal opens and GUI actions)
# 3. Launch project terminals from the database
# NOTE: Terminals launch elevated (admin) so Claude Code has full system access

$panRoot = $PSScriptRoot

# Ensure we're running as admin — re-launch elevated if not
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

# Start desktop agent (hidden window, polls service for GUI actions)
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File `"$panRoot\pan-agent.ps1`""

# Give service a moment
Start-Sleep -Seconds 3

# Launch project terminals
node "$panRoot\service\pan.js" launch
