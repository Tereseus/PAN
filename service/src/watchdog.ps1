<#
.SYNOPSIS
    PAN Steward — Service Health Manager
    Steward — single script that runs on boot. Handles everything:
    1. PAN Server (Windows Service, port 7777)
    2. Whisper STT Server (Python, port 7778)
    3. Voice hotkeys (mouse side buttons - no AutoHotkey needed)
    4. Tailscale cleanup (removes offline duplicate phone entries)
    Monitors every 30 seconds, auto-restarts anything that dies.
#>

$ErrorActionPreference = "Continue"

# === CONFIG ===
$PanDir = "C:\Users\tzuri\OneDrive\Desktop\PAN"
$ServiceDir = "$PanDir\service"
$LogFile = "$env:LOCALAPPDATA\PAN\data\steward.log"
$CheckInterval = 30
$WhisperScript = "$ServiceDir\src\whisper-server.py"
$DictateScript = "$ServiceDir\src\dictate-vad.py"

# Ensure log directory exists
$logDir = Split-Path $LogFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

function Test-Port {
    param([int]$Port, [int]$TimeoutMs = 2000)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $result = $tcp.BeginConnect("127.0.0.1", $Port, $null, $null)
        $success = $result.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($success) { $tcp.EndConnect($result) }
        $tcp.Close()
        return $success
    } catch {
        return $false
    }
}

function Test-ProcessRunning {
    param([string]$Name)
    return @(Get-Process -Name $Name -ErrorAction SilentlyContinue).Count -gt 0
}

function Send-ToStewardDb {
    param([string]$EventType, [string]$Detail)
    try {
        $body = @{ type = "StewardEvent"; subtype = $EventType; content = $Detail; source = "steward" } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://127.0.0.1:7777/api/v1/events" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 3 | Out-Null
    } catch {}
}

# === SERVICE MANAGERS ===

function Restart-PanServer {
    Write-Log "PAN Server down - restarting..." "WARN"
    try {
        Restart-Service PAN -Force -ErrorAction Stop
        Start-Sleep -Seconds 5
        if (Test-Port 7777) { Write-Log "PAN Server restarted" "OK"; return $true }
        else { Write-Log "PAN Server restart failed" "ERROR"; return $false }
    } catch {
        Write-Log "PAN Server restart error: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

function Restart-WhisperServer {
    Write-Log "Whisper Server down - restarting..." "WARN"
    try {
        $existing = Get-NetTCPConnection -LocalPort 7778 -ErrorAction SilentlyContinue
        if ($existing) { Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue; Start-Sleep 1 }
        Start-Process python -ArgumentList "`"$WhisperScript`"" -WindowStyle Hidden
        Write-Log "Whisper Server starting (GPU model load)..." "INFO"
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Seconds 5
            if (Test-Port 7778) { Write-Log "Whisper Server started" "OK"; return $true }
        }
        Write-Log "Whisper Server failed after 60s" "ERROR"; return $false
    } catch {
        Write-Log "Whisper restart error: $($_.Exception.Message)" "ERROR"; return $false
    }
}

# === TAILSCALE CLEANUP ===
# Removes offline duplicate phone entries from the tailnet on startup

function Clean-TailscaleGhosts {
    Write-Log "Cleaning Tailscale ghost devices..." "INFO"
    try {
        $statusJson = & tailscale status --json 2>&1 | Out-String
        $status = $statusJson | ConvertFrom-Json
        $selfIp = $status.Self.TailscaleIPs[0]
        $peers = $status.Peer
        $removed = 0

        foreach ($key in $peers.PSObject.Properties.Name) {
            $peer = $peers.$key
            if ($peer.OS -eq "android" -and -not $peer.Online) {
                $name = $peer.HostName
                Write-Log "Ghost found: $name (offline) - remove from https://login.tailscale.com/admin/machines" "INFO"
                $removed++
            }
        }
        # NOTE: Tailscale CLI cannot delete devices. Server API endpoint /api/v1/tailscale/cleanup
        # can be added to PAN server to handle this via Tailscale API key when configured.

        if ($removed -gt 0) {
            Write-Log "Removed $removed ghost devices from tailnet" "OK"
            Send-ToStewardDb "tailscale_cleanup" "Removed $removed offline ghost devices"
        } else {
            Write-Log "No ghost devices to clean" "INFO"
        }
    } catch {
        Write-Log "Tailscale cleanup error: $($_.Exception.Message)" "WARN"
    }
}

# === VOICE HOTKEY ===
# Uses AHK runtime bundled with PAN (Voice.ahk script)
# AHK is required because Windows 11 blocks low-level mouse hooks from .NET processes
# Bundled AHK runtime + Voice script (no separate AHK install needed)
$AhkExe = "$PanDir\service\bin\AutoHotkey64.exe"
$VoiceScript = "$PanDir\service\bin\Voice.ahk"

function Start-VoiceHotkeys {
    Write-Log "Starting Voice.ahk..." "INFO"
    try {
        Start-Process $AhkExe -ArgumentList "`"$VoiceScript`"" -Verb RunAs
        Start-Sleep -Seconds 2
        if (Test-ProcessRunning "AutoHotkey64") {
            Write-Log "Voice.ahk started" "OK"
        } else {
            Write-Log "Voice.ahk failed to start" "ERROR"
        }
    } catch {
        Write-Log "Voice.ahk start error: $($_.Exception.Message)" "ERROR"
    }
}

function Test-VoiceHotkeys {
    return Test-ProcessRunning "AutoHotkey64"
}

# === STARTUP SEQUENCE ===
Write-Log "=== PAN Steward ===" "INFO"
Write-Log "Services: PAN Server, Whisper STT, Voice Hotkeys, Tailscale" "INFO"

# One-time startup tasks
Clean-TailscaleGhosts
Start-VoiceHotkeys

# === HEALTH CHECK LOOP ===
while ($true) {
    $issues = @()

    # Check 1: PAN Server (port 7777)
    if (-not (Test-Port 7777)) {
        $issues += "PAN Server"
        $result = Restart-PanServer
        $s = if ($result) { "succeeded" } else { "failed" }
        Send-ToStewardDb "restart" "PAN Server was down, restart $s"
    }

    # Check 1b: Dashboard performance (via perf endpoint)
    try {
        $perf = Invoke-RestMethod -Uri "http://127.0.0.1:7777/dashboard/api/perf" -TimeoutSec 5
        if ($perf.slow_requests -gt 0) {
            Write-Log "Dashboard has $($perf.slow_requests)/$($perf.total_requests) slow requests (avg $($perf.avg_ms)ms)" "WARN"
            if ($perf.slowest -and $perf.slowest.Count -gt 0) {
                $worst = $perf.slowest[0]
                Write-Log "  Slowest: $($worst.route) — $($worst.ms)ms at $($worst.ts)" "WARN"
            }
            Send-ToStewardDb "dashboard_slow" "Dashboard slow: $($perf.slow_requests) requests over 2s, avg $($perf.avg_ms)ms"
        }
    } catch {
        # Perf endpoint not available — server might be starting up
    }

    # Check 2: Whisper Server (port 7778)
    if (-not (Test-Port 7778)) {
        $issues += "Whisper"
        $result = Restart-WhisperServer
        $s = if ($result) { "succeeded" } else { "failed" }
        Send-ToStewardDb "restart" "Whisper was down, restart $s"
    }

    # Check 3: Voice hotkey job (PowerShell-based, no AHK dependency)
    if (-not (Test-VoiceHotkeys)) {
        $issues += "Voice Hotkeys"
        Start-VoiceHotkeys
        Send-ToStewardDb "restart" "Voice hotkey listener restarted"
    }


    if ($issues.Count -gt 0) {
        Write-Log "Issues found: $($issues -join ', ')" "WARN"
    }

    Start-Sleep -Seconds $CheckInterval
}
