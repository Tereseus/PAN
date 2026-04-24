# PAN Metrics Agent — Windows
# Collects CPU, RAM, Disk and POSTs to PAN hub every 30s.
#
# Setup on the mini PC (run once as admin to install as scheduled task):
#   powershell -ExecutionPolicy Bypass -File pan-metrics-agent.ps1 -Install
#
# Or run manually (keeps console open):
#   powershell -ExecutionPolicy Bypass -File pan-metrics-agent.ps1
#
# Config — edit these:
$PAN_URL     = "http://100.x.x.x:7777"   # ← your PAN hub's Tailscale IP
$DEVICE_ID   = $env:COMPUTERNAME          # e.g. MINI-PC or TZURI-TOWER
$INTERVAL_S  = 30

param([switch]$Install, [switch]$Uninstall)

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName "PAN-Metrics-Agent" -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Unregistered PAN-Metrics-Agent scheduled task."
    exit
}

if ($Install) {
    $scriptPath = $MyInvocation.MyCommand.Path
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                 -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -RestartOnIdle -ExecutionTimeLimit (New-TimeSpan -Hours 0)
    Register-ScheduledTask -TaskName "PAN-Metrics-Agent" -Action $action `
        -Trigger $trigger -RunLevel Highest -Settings $settings -Force
    Start-ScheduledTask -TaskName "PAN-Metrics-Agent"
    Write-Host "Installed and started PAN-Metrics-Agent. It will auto-start on boot."
    exit
}

Write-Host "PAN Metrics Agent starting — reporting to $PAN_URL every ${INTERVAL_S}s as $DEVICE_ID"

# Network baseline for delta calculation
$prevNet = $null
$prevNetTime = $null

while ($true) {
    try {
        # ── CPU ──────────────────────────────────────────────────────────────
        $cpuPct = [math]::Round((Get-CimInstance Win32_Processor |
            Measure-Object -Property LoadPercentage -Average).Average, 1)

        # ── RAM ──────────────────────────────────────────────────────────────
        $os = Get-CimInstance Win32_OperatingSystem
        $ramTotalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
        $ramFreeMB  = [math]::Round($os.FreePhysicalMemory / 1024)
        $ramUsedMB  = $ramTotalMB - $ramFreeMB
        $ramPct     = [math]::Round($ramUsedMB / $ramTotalMB * 100, 1)

        # ── Disk (C:) ────────────────────────────────────────────────────────
        $disk = Get-PSDrive C -ErrorAction SilentlyContinue
        $diskFreeGB = $null; $diskPct = $null
        if ($disk) {
            $diskFreeGB  = [math]::Round($disk.Free / 1GB, 1)
            $diskTotalGB = [math]::Round(($disk.Used + $disk.Free) / 1GB, 1)
            $diskPct     = if ($diskTotalGB -gt 0) { [math]::Round($disk.Used / ($disk.Used + $disk.Free) * 100, 1) } else { $null }
        }

        # ── Network (delta bytes → kbps) ─────────────────────────────────────
        $netUpKbps = $null; $netDownKbps = $null
        $curNet = Get-NetAdapterStatistics -ErrorAction SilentlyContinue |
                  Where-Object { $_.ReceivedBytes -gt 0 }
        $curTime = Get-Date
        if ($prevNet -and $curNet) {
            $dtSec = ($curTime - $prevNetTime).TotalSeconds
            if ($dtSec -gt 0) {
                $sentDelta = ($curNet | Measure-Object SentBytes -Sum).Sum -
                             ($prevNet | Measure-Object SentBytes -Sum).Sum
                $recvDelta = ($curNet | Measure-Object ReceivedBytes -Sum).Sum -
                             ($prevNet | Measure-Object ReceivedBytes -Sum).Sum
                $netUpKbps   = [math]::Round([math]::Max(0, $sentDelta) / $dtSec / 128, 1)
                $netDownKbps = [math]::Round([math]::Max(0, $recvDelta) / $dtSec / 128, 1)
            }
        }
        $prevNet = $curNet; $prevNetTime = $curTime

        # ── POST to PAN ───────────────────────────────────────────────────────
        $body = @{
            device_id    = $DEVICE_ID
            platform     = "windows"
            cpu_pct      = $cpuPct
            ram_pct      = $ramPct
            ram_used_mb  = $ramUsedMB
            ram_total_mb = $ramTotalMB
            disk_pct     = $diskPct
            disk_free_gb = $diskFreeGB
            net_up_kbps  = $netUpKbps
            net_down_kbps = $netDownKbps
        } | ConvertTo-Json

        $r = Invoke-RestMethod -Uri "$PAN_URL/api/v1/client/metrics" `
               -Method POST -Body $body -ContentType "application/json" `
               -TimeoutSec 8 -ErrorAction Stop

        Write-Host "$(Get-Date -f 'HH:mm:ss') CPU:${cpuPct}% RAM:${ramPct}% (${ramUsedMB}/${ramTotalMB}MB) Disk:${diskPct}% ✓"
    } catch {
        Write-Host "$(Get-Date -f 'HH:mm:ss') POST failed: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $INTERVAL_S
}
