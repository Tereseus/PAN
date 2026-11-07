# Keeps the hub's 127.0.0.1:11435 pointed at this machine's Ollama, so the hub can use this GPU with
# no firewall change. Stand-in until a voice box has its own address. Needs ssh keys to the hub.
#   powershell -File voice-box-tunnel.ps1 -Target user@hub
param([Parameter(Mandatory)][string]$Target)
while ($true) {
    ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -R 127.0.0.1:11435:127.0.0.1:11434 $Target
    Start-Sleep -Seconds 5
}
