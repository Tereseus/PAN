# read-blackbox.ps1 - find the crash gaps and show what the machine was doing
# in the seconds before each one. Run this after any hard reset.
#
# A "gap" is a jump in the timestamp column bigger than the sampling interval.
# Since the recorder flushes every sample to physical disk, the last row before
# a gap is at most ~2 seconds before the machine died.

param(
    [int]$Show = 15,          # samples to show before each gap
    [int]$GapSec = 15,        # a jump bigger than this counts as a crash gap
    [int]$Days = 7
)

$LogDir = Join-Path $env:LOCALAPPDATA 'PAN\blackbox'
if (-not (Test-Path $LogDir)) { Write-Output "No blackbox data yet at $LogDir"; return }

$rows = @()
Get-ChildItem $LogDir -Filter 'blackbox-*.csv' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge (Get-Date).AddDays(-$Days) } |
    Sort-Object Name | ForEach-Object {
        $rows += Import-Csv $_.FullName
    }

if ($rows.Count -eq 0) { Write-Output "No samples recorded yet."; return }

# parse timestamps once
$parsed = foreach ($r in $rows) {
    $t = [datetime]::MinValue
    if ([datetime]::TryParse($r.ts, [ref]$t)) { $r | Add-Member -NotePropertyName T -NotePropertyValue $t -Force -PassThru }
}
$parsed = @($parsed | Sort-Object T)

Write-Output ("Samples: {0}   from {1}   to {2}" -f $parsed.Count, $parsed[0].T, $parsed[-1].T)

$gaps = @()
for ($i = 1; $i -lt $parsed.Count; $i++) {
    $d = ($parsed[$i].T - $parsed[$i-1].T).TotalSeconds
    if ($d -gt $GapSec) { $gaps += [pscustomobject]@{ Index=$i; Before=$parsed[$i-1].T; After=$parsed[$i].T; GapSec=[int]$d } }
}

if ($gaps.Count -eq 0) { Write-Output "`nNo gaps found. No crash captured yet."; return }

Write-Output "`n$($gaps.Count) gap(s) found:`n"

foreach ($g in $gaps) {
    Write-Output ("=" * 100)
    Write-Output ("GAP: last sample {0}  ->  back up {1}   (down {2}s)" -f $g.Before, $g.After, $g.GapSec)
    Write-Output ("=" * 100)

    $start = [Math]::Max(0, $g.Index - $Show)
    $slice = $parsed[$start..($g.Index-1)]

    $slice | Select-Object @{n='time';e={$_.T.ToString('HH:mm:ss')}},
        @{n='cpu%';e={$_.cpu_pct}}, @{n='MHz';e={$_.cpu_mhz}}, @{n='perf%';e={$_.cpu_perf_pct}},
        @{n='ram%';e={$_.ram_pct}}, @{n='gpuC';e={$_.gpu_temp_c}}, @{n='gpuW';e={$_.gpu_power_w}},
        @{n='gpu%';e={$_.gpu_util_pct}}, @{n='AC';e={$_.ac_online}}, @{n='dischg';e={$_.discharging}},
        @{n='whea';e={$_.whea_since_boot}}, @{n='top';e={$_.top_proc}} |
        Format-Table -AutoSize | Out-String -Width 160 | Write-Output

    # --- verdict ---
    $last = $slice[-1]
    $findings = @()

    $acDrop = @($slice | Where-Object { $_.ac_online -eq '0' })
    $dischg = @($slice | Where-Object { $_.discharging -eq '1' })
    if ($acDrop.Count -gt 0 -or $dischg.Count -gt 0) {
        $findings += "POWER DELIVERY: adapter went offline or battery began discharging before the reset. Suspect the AC adapter / VRM, NOT the CPU."
    }

    $temps = @($slice | Where-Object { $_.gpu_temp_c -match '^\d+$' } | ForEach-Object { [int]$_.gpu_temp_c })
    if ($temps.Count -ge 2) {
        $peak = ($temps | Measure-Object -Maximum).Maximum
        $rise = $temps[-1] - $temps[0]
        if ($peak -ge 85) { $findings += "THERMAL: GPU peaked at ${peak}C before the reset. Chassis thermals are a live suspect." }
        elseif ($rise -ge 15) { $findings += "THERMAL: GPU rose ${rise}C across the window (peak ${peak}C). Worth watching." }
    }

    $cpuVals = @($slice | Where-Object { $_.cpu_pct -match '^[\d.]+$' } | ForEach-Object { [double]$_.cpu_pct })
    if ($cpuVals.Count -gt 0) {
        $avg = [math]::Round(($cpuVals | Measure-Object -Average).Average,1)
        $findings += "Load at death: cpu avg ${avg}%, last sample $($last.cpu_pct)% @ $($last.cpu_mhz)MHz, gpu $($last.gpu_util_pct)% @ $($last.gpu_temp_c)C"
    }

    if ($findings.Count -le 1) {
        $findings += "NOTHING ANOMALOUS: power steady, temps unremarkable, load normal right up to the gap. That pattern points at CATERR - an instant CPU-level fault with no warning, consistent with the degrading core."
    }

    Write-Output "VERDICT:"
    foreach ($f in $findings) { Write-Output "  - $f" }
    Write-Output ""
}
