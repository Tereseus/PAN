# push-hardware-health.ps1
# Collects CPU degradation telemetry for the Dell G16 7630 (desktop-pc) and renders a
# self-contained HTML page into service/public/, registered in the PAN dashboard
# registry. Pattern: push script + plain HTML page + registry entry.
#
# Background: one physical P-core (APIC 8/9) is throwing Raptor Lake internal
# parity errors. Max processor state was capped to 85% on 2026-08-03 to slow the
# voltage-driven degradation. This page answers one question: is the cap working?

$ErrorActionPreference = 'Stop'

$OutFile   = Join-Path $PSScriptRoot '..\public\hardware-health.html'
# Two interventions. The max cap (Aug 3) limits further degradation. The min-state
# raise (Aug 4) is the one that should stop errors NOW: Vmin shift means the core
# needs more voltage than stock to stay stable, and at 5% min state it idled below
# that. Baseline against the floor raise, since that's the live hypothesis.
$CapApplied = [datetime]'2026-08-04 05:45:00'   # PROCTHROTTLEMIN 5% -> 50%
$Now = Get-Date

# ---------- collect ----------

function Get-WheaEvents {
    param([int]$Days = 60)
    try {
        Get-WinEvent -FilterHashtable @{
            LogName      = 'System'
            ProviderName = 'Microsoft-Windows-WHEA-Logger'
            Id           = 19
            StartTime    = $Now.AddDays(-$Days)
        } -ErrorAction Stop
    } catch { @() }
}

function Get-UnexpectedShutdowns {
    param([int]$Days = 60)
    try {
        Get-WinEvent -FilterHashtable @{
            LogName      = 'System'
            ProviderName = 'Microsoft-Windows-Kernel-Power'
            Id           = 41
            StartTime    = $Now.AddDays(-$Days)
        } -ErrorAction Stop
    } catch { @() }
}

$whea      = @(Get-WheaEvents -Days 60)
$shutdowns = @(Get-UnexpectedShutdowns -Days 60)

# per-day counts
$byDay = @{}
foreach ($e in $whea) {
    $k = $e.TimeCreated.ToString('yyyy-MM-dd')
    if ($byDay.ContainsKey($k)) { $byDay[$k]++ } else { $byDay[$k] = 1 }
}

# per-core breakdown
$byCore = @{}
foreach ($e in $whea) {
    if ($e.Message -match 'APIC ID:\s*(\d+)') {
        $k = $matches[1]
        if ($byCore.ContainsKey($k)) { $byCore[$k]++ } else { $byCore[$k] = 1 }
    }
}

# the headline number: rate before vs after the voltage cap
$preCap  = @($whea | Where-Object { $_.TimeCreated -lt $CapApplied })
$postCap = @($whea | Where-Object { $_.TimeCreated -ge $CapApplied })

$firstErr = $null
if ($whea.Count -gt 0) { $firstErr = ($whea | Sort-Object TimeCreated | Select-Object -First 1).TimeCreated }

$preDays  = 1.0
if ($firstErr) { $preDays = [Math]::Max(1.0, ($CapApplied - $firstErr).TotalDays) }
$postDays = [Math]::Max(0.04, ($Now - $CapApplied).TotalDays)

$preRate  = [Math]::Round($preCap.Count  / $preDays,  2)
$postRate = [Math]::Round($postCap.Count / $postDays, 2)

# verdict
if ($postDays -lt 3) {
    $verdict = 'TOO EARLY'; $vclass = 'warn'
    $vtext = "Only $([Math]::Round($postDays,1)) days since the floor raise. Need ~7 days before the trend means anything."
} elseif ($postRate -le ($preRate * 0.5)) {
    $verdict = 'CAP HOLDING'; $vclass = 'good'
    $vtext = 'Error rate dropped meaningfully after the voltage cap. Keep the cap in place.'
} elseif ($postRate -le $preRate) {
    $verdict = 'FLAT'; $vclass = 'warn'
    $vtext = 'Rate is roughly unchanged. Degradation is stable but not improving. Keep watching.'
} else {
    $verdict = 'STILL CLIMBING'; $vclass = 'bad'
    $vtext = 'Rate increased despite the cap. Start planning a replacement on your own schedule.'
}

# ---------- mitigation still applied? ----------

function Test-Mitigations {
    $r = @()

    $maxState = $null
    try {
        $q = powercfg /query SCHEME_CURRENT SUB_PROCESSOR bc5038f7-23e0-4960-96da-33abaf5935ec 2>&1 | Out-String
        if ($q -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { $maxState = [Convert]::ToInt32($matches[1],16) }
    } catch {}
    $ok = ($null -ne $maxState -and $maxState -le 90)
    $shown = 'unknown'
    if ($null -ne $maxState) { $shown = "$maxState%" }
    $r += [pscustomobject]@{ Name='Max processor state (AC)'; Value=$shown; Ok=$ok }

    $susp = $null
    try {
        $q = powercfg /query SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 2>&1 | Out-String
        if ($q -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { $susp = [Convert]::ToInt32($matches[1],16) }
    } catch {}
    $shown2 = 'unknown'
    if ($null -ne $susp) { if ($susp -eq 0) { $shown2 = 'disabled' } else { $shown2 = 'ENABLED' } }
    $r += [pscustomobject]@{ Name='USB selective suspend (AC)'; Value=$shown2; Ok=($susp -eq 0) }

    $dockOn = 0; $dockTotal = 0
    try {
        Get-CimInstance -Namespace root\wmi -ClassName MSPower_DeviceEnable -ErrorAction Stop |
            Where-Object { $_.InstanceName -match 'VID_17E9|VID_05E3' } | ForEach-Object {
                $dockTotal++
                if ($_.Enable) { $dockOn++ }
            }
    } catch {}
    $dv = 'no dock detected'
    if ($dockTotal -gt 0) { $dv = "$($dockTotal - $dockOn)/$dockTotal excluded from power-down" }
    $r += [pscustomobject]@{ Name='Dock USB power management'; Value=$dv; Ok=($dockTotal -gt 0 -and $dockOn -eq 0) }

    return $r
}
$mitigations = @(Test-Mitigations)

# ---------- render ----------

function E($s) { if ($null -eq $s) { return '' } [System.Net.WebUtility]::HtmlEncode([string]$s) }

# 30-day sparkline bars
$days = @()
for ($i = 29; $i -ge 0; $i--) { $days += $Now.AddDays(-$i).ToString('yyyy-MM-dd') }
$maxDay = 1
foreach ($d in $days) { if ($byDay.ContainsKey($d) -and $byDay[$d] -gt $maxDay) { $maxDay = $byDay[$d] } }

$bars = ''
foreach ($d in $days) {
    $c = 0
    if ($byDay.ContainsKey($d)) { $c = $byDay[$d] }
    $h = [Math]::Round(100.0 * $c / $maxDay)
    if ($c -gt 0 -and $h -lt 6) { $h = 6 }
    $cls = 'b0'
    if ($c -gt 0) { $cls = 'bx' }
    if ([datetime]$d -ge $CapApplied.Date) { $cls += ' post' }
    $bars += "<div class='bar $cls' style='height:$h%' title='$d : $c errors'></div>"
}

$coreRows = ''
foreach ($k in ($byCore.Keys | Sort-Object { [int]$_ })) {
    $coreRows += "<tr><td>APIC $k</td><td class='num'>$($byCore[$k])</td></tr>"
}
if (-not $coreRows) { $coreRows = "<tr><td colspan='2' class='muted'>No CPU errors recorded</td></tr>" }

$mitRows = ''
foreach ($m in $mitigations) {
    $dot = 'bad'; if ($m.Ok) { $dot = 'good' }
    $mitRows += "<tr><td>$(E $m.Name)</td><td class='num'><span class='dot $dot'></span>$(E $m.Value)</td></tr>"
}

$shutRows = ''
foreach ($s in ($shutdowns | Sort-Object TimeCreated -Descending | Select-Object -First 10)) {
    $shutRows += "<tr><td>$($s.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'))</td><td class='muted'>unexpected power-off</td></tr>"
}
if (-not $shutRows) { $shutRows = "<tr><td colspan='2' class='muted'>None in 60 days</td></tr>" }

$html = @"
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="900">
<title>Hardware Health - desktop-pc</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:16px;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
     background:#0e1117;color:#e6edf3}
h1{font-size:18px;margin:0 0 2px}
.sub{color:#8b949e;font-size:13px;margin-bottom:18px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;margin-bottom:14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 10px;font-weight:600}
.verdict{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px}
.good{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}
.vtext{color:#8b949e;font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px}
.stat .n{font-size:24px;font-weight:700;letter-spacing:-.02em}
.stat .l{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.chart{display:flex;align-items:flex-end;gap:2px;height:90px;margin-top:4px}
.bar{flex:1;border-radius:2px 2px 0 0;min-height:2px;background:#21262d}
.bar.bx{background:#f85149}
.bar.post{background:#21262d}
.bar.bx.post{background:#d29922}
.legend{display:flex;gap:14px;font-size:11px;color:#8b949e;margin-top:8px}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:6px 0;border-bottom:1px solid #21262d}
td.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.muted{color:#8b949e}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot.good{background:#3fb950}.dot.bad{background:#f85149}
.foot{color:#484f58;font-size:11px;text-align:center;margin-top:18px}
@media(prefers-color-scheme:light){
 body{background:#f6f8fa;color:#1f2328}
 .card{background:#fff;border-color:#d1d9e0}
 .stat{background:#f6f8fa;border-color:#d1d9e0}
 .bar{background:#d1d9e0}.bar.post{background:#d1d9e0}
 td{border-color:#d1d9e0}
}
</style></head><body>

<h1>Hardware Health</h1>
<div class="sub">Dell G16 7630 &middot; i9-13900HX &middot; Service Tag JTSY434</div>

<div class="card">
  <h2>Is the voltage floor fix working?</h2>
  <div class="verdict $vclass">$verdict</div>
  <div class="vtext">$(E $vtext)</div>
</div>

<div class="grid">
  <div class="stat"><div class="n">$preRate</div><div class="l">errors/day before fix</div></div>
  <div class="stat"><div class="n $vclass">$postRate</div><div class="l">errors/day since fix</div></div>
  <div class="stat"><div class="n">$($whea.Count)</div><div class="l">CPU errors, 60d</div></div>
  <div class="stat"><div class="n">$($shutdowns.Count)</div><div class="l">hard power-offs, 60d</div></div>
</div>

<div class="card">
  <h2>Corrected CPU errors, last 30 days</h2>
  <div class="chart">$bars</div>
  <div class="legend">
    <span><span class="sw" style="background:#f85149"></span>before fix</span>
    <span><span class="sw" style="background:#d29922"></span>after fix</span>
  </div>
</div>

<div class="card">
  <h2>Which core</h2>
  <table>$coreRows</table>
</div>

<div class="card">
  <h2>Mitigations still applied</h2>
  <table>$mitRows</table>
</div>

<div class="card">
  <h2>Unexpected power-offs</h2>
  <table>$shutRows</table>
</div>

<div class="foot">Updated $($Now.ToString('yyyy-MM-dd HH:mm')) &middot; auto-refresh 15 min &middot; PAN-HardwareHealth</div>
</body></html>
"@

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$html | Out-File -FilePath $OutFile -Encoding utf8 -Force

Write-Output "wrote $OutFile"
Write-Output "verdict=$verdict pre=$preRate/day post=$postRate/day total60d=$($whea.Count)"

