# PAN Startup Script
# 1. PAN service runs as Windows service (auto-starts on boot)
# 2. Start the desktop agent (handles terminal opens and GUI actions)
# 3. Launch project terminals from the database

$panRoot = "$env:USERPROFILE\OneDrive\Desktop\PAN"

# Start desktop agent (hidden window, polls service for GUI actions)
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File `"$panRoot\pan-agent.ps1`""

# Give service a moment
Start-Sleep -Seconds 3

# Launch project terminals
node "$panRoot\service\pan.js" launch
