# blackbox.ps1 - flight recorder for the desktop-pc hard-reset investigation
#
# The machine dies with NO bugcheck, NO dump, and NO WHEA record: an instant
# platform-level reset. Nothing survives because nothing gets a chance to write.
# So we write continuously instead, flushing every single sample to disk, and
# read back whatever landed before the gap.
#
# The point is to discriminate between the three candidate causes:
#   1. CATERR (degrading CPU core)  -> everything looks NORMAL right up to the gap
#   2. Power delivery failure       -> ac/discharging flips, or battery starts draining
#   3. EC thermal trip              -> gputemp climbs toward a trip point
#
# Sampling at 2s means the last row before a gap is at most 2s stale.

$ErrorActionPreference = 'Continue'
$IntervalSec = 2
$LogDir = Join-Path $env:LOCALAPPDATA 'PAN\blackbox'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$smi = "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
if (-not (Test-Path $smi)) {
    $c = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($c) { $smi = $c.Source } else { $smi = $null }
}

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$totalRamKB = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize

function New-Writer {
    $path = Join-Path $LogDir ("blackbox-{0}.csv" -f (Get-Date -Format 'yyyy-MM-dd'))
    $fresh = -not (Test-Path $path)
    $fs = [System.IO.FileStream]::new($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $sw = [System.IO.StreamWriter]::new($fs)
    $sw.AutoFlush = $true
    if ($fresh) {
        $sw.WriteLine('ts,uptime_s,cpu_pct,cpu_mhz,cpu_perf_pct,ram_pct,gpu_temp_c,gpu_power_w,gpu_mhz,gpu_util_pct,ac_online,discharging,batt_mwh,whea_since_boot,top_proc,top_proc_cpu_s')
        $sw.Flush(); $fs.Flush($true)
    }
    return [pscustomobject]@{ SW = $sw; FS = $fs; Path = $path; Day = (Get-Date).Date }
}

$w = New-Writer
Write-Output "blackbox recording -> $($w.Path)  (interval ${IntervalSec}s)"

# perf counters are far cheaper read as a set
$counterPaths = @(
    '\Processor Information(_Total)\% Processor Time',
    '\Processor Information(_Total)\Processor Frequency',
    '\Processor Information(_Total)\% Processor Performance'
)

while ($true) {
    try {
        # roll the file at midnight
        if ((Get-Date).Date -ne $w.Day) {
            $w.SW.Dispose(); $w.FS.Dispose()
            $w = New-Writer
        }

        $now = Get-Date
        $uptime = [int]((New-TimeSpan -Start $boot -End $now).TotalSeconds)

        $cpuPct = ''; $cpuMhz = ''; $cpuPerf = ''
        try {
            $cs = (Get-Counter $counterPaths -ErrorAction Stop).CounterSamples
            $cpuPct  = [math]::Round($cs[0].CookedValue,1)
            $cpuMhz  = [math]::Round($cs[1].CookedValue,0)
            $cpuPerf = [math]::Round($cs[2].CookedValue,1)
        } catch {}

        $ramPct = ''
        try {
            $free = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory
            $ramPct = [math]::Round(100.0 * ($totalRamKB - $free) / $totalRamKB, 1)
        } catch {}

        # GPU sampling was firing nvidia-smi every tick - ~900 process spawns an hour,
        # which is real churn on a machine already flashing consoles. Thermals move
        # slowly; every ~20s is plenty. Carry the last reading between samples.
        if ($smi -and ($null -eq $script:gpuAt -or ((Get-Date) - $script:gpuAt).TotalSeconds -ge 20)) {
            try {
                $line = & $smi --query-gpu=temperature.gpu,power.draw,clocks.sm,utilization.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
                if ($line) {
                    $p = $line -split '\s*,\s*'
                    if ($p.Count -ge 4) {
                        $script:gT=$p[0]; $script:gP=$p[1]; $script:gC=$p[2]; $script:gU=$p[3]
                    }
                }
            } catch {}
            $script:gpuAt = Get-Date
        }
        $gT=$script:gT; $gP=$script:gP; $gC=$script:gC; $gU=$script:gU

        # adapter/battery - this is what catches a power-delivery failure
        $ac=''; $dis=''; $mwh=''
        try {
            $b = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1
            $ac  = [int][bool]$b.PowerOnline
            $dis = [int][bool]$b.Discharging
            $mwh = $b.RemainingCapacity
        } catch {}

        # Scanning the event log every 2s would be brutal - refresh once a minute
        # and carry the value between samples.
        if ($null -eq $script:wheaCache -or ((Get-Date) - $script:wheaAt).TotalSeconds -ge 60) {
            try {
                $script:wheaCache = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; Id=19; StartTime=$boot} -ErrorAction Stop).Count
            } catch { $script:wheaCache = 0 }
            $script:wheaAt = Get-Date
        }
        $whea = $script:wheaCache

        $tp=''; $tpc=''
        try {
            $p = Get-Process -ErrorAction Stop | Sort-Object CPU -Descending | Select-Object -First 1
            $tp = $p.ProcessName; $tpc = [math]::Round($p.CPU,0)
        } catch {}

        $row = "{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13},{14},{15}" -f `
            $now.ToString('yyyy-MM-dd HH:mm:ss'), $uptime, $cpuPct, $cpuMhz, $cpuPerf, $ramPct,
            $gT, $gP, $gC, $gU, $ac, $dis, $mwh, $whea, $tp, $tpc

        $w.SW.WriteLine($row)
        $w.SW.Flush()
        $w.FS.Flush($true)   # force to physical disk - survives an instant power cut
    } catch {
        # never let the recorder die
    }
    Start-Sleep -Seconds $IntervalSec
}
