# PAN link watchdog - idle-shaped test for the Wi-Fi power-save fix (2026-08-29).
#
# WHY THIS EXISTS: every symptom of the link bug reported success while failing.
# The WoE benchmark can only prove the link survives 20 min of SUSTAINED load,
# which is itself a wake signal. The failure we actually care about happens
# during long IDLE - a 7 hour overnight window that returned "result 0" having
# done nothing. So this samples during idle and, critically, logs LOCALLY, so a
# dead link cannot hide its own outage the way every other signal did.
$log = 'C:\PAN\linkwatch.log'
$ts  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$net = if (Test-Connection -ComputerName 1.1.1.1 -Count 1 -Quiet -ErrorAction SilentlyContinue) { 'up' } else { 'DOWN' }
try { $ts4 = (& 'C:\Program Files\Tailscale\tailscale.exe' status --json | ConvertFrom-Json).BackendState } catch { $ts4 = 'ERR' }
try { $hub = if ((Invoke-WebRequest -Uri 'http://127.0.0.1:7777/health' -TimeoutSec 8 -UseBasicParsing).StatusCode -eq 200) { 'ok' } else { 'bad' } } catch { $hub = 'DOWN' }
Add-Content -Path $log -Value "$ts net=$net tailscale=$ts4 hub=$hub"

