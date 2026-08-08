# PAN Guardian - External Watchdog
# Runs via Windows Task Scheduler. Completely outside PAN/Steward.
# Checks port 7777 every 60s. If dead, kills stuck processes and relaunches pan-loop.bat.

$PANDir    = "$env:USERPROFILE\Desktop\PAN\service"
$LogFile   = "$env:USERPROFILE\AppData\Local\PAN\data\guardian.log"
$LoopBat   = "$PANDir\pan-loop.bat"
$CheckPort = 7777
$Interval  = 60   # seconds between health checks

function Log($msg) {
    $ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Is-PANUp {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar  = $tcp.BeginConnect("127.0.0.1", $CheckPort, $null, $null)
        $ok  = $ar.AsyncWaitHandle.WaitOne(2000)
        $tcp.Close()
        return $ok
    } catch { return $false }
}

function Kill-StuckPAN {
    foreach ($port in @(7777, 17700)) {
        $lines = netstat -ano 2>$null | Select-String ":$port\s.*LISTENING"
        foreach ($line in $lines) {
            $pid = ($line -split '\s+')[-1]
            if ($pid -match '^\d+$' -and $pid -ne '0') {
                try {
                    Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
                    Log "Killed PID $pid (was holding :$port)"
                } catch {}
            }
        }
    }
    Start-Sleep -Seconds 2
}

function Launch-PAN {
    Log "Launching pan-loop.bat..."
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c `"$LoopBat`"" `
        -WorkingDirectory $PANDir `
        -WindowStyle Normal
    Start-Sleep -Seconds 10

    if (Is-PANUp) {
        Log "PAN is UP on :$CheckPort"
    } else {
        Log "WARNING: PAN did not respond after launch. Will retry next cycle."
    }
}

# Main loop
Log "PAN Guardian started. Watching :$CheckPort every ${Interval}s. PID: $PID"

while ($true) {
    if (-not (Is-PANUp)) {
        Log "PAN is DOWN on :$CheckPort - recovering"
        Kill-StuckPAN
        Launch-PAN
    }
    Start-Sleep -Seconds $Interval
}
