# push-pan-system.ps1
# Renders PAN's own system diagnostics into service/public/pan-system.html and
# serves it via the dashboard registry. Companion to push-hardware-health.ps1.
# Pattern: push script + plain HTML page + registry entry (no monolith widgets).
#
# This page is the index for everything PAN: process tier health, the tailnet,
# registered devices, AI spend, DB growth, and links to every other registered
# dashboard with live up/down dots.

$ErrorActionPreference = 'Stop'

$OutFile = Join-Path $PSScriptRoot '..\public\pan-system.html'
$Base    = 'http://localhost:7777'
$Now     = Get-Date

function Get-Api($path) {
    try { return Invoke-RestMethod -Uri "$Base$path" -TimeoutSec 6 -ErrorAction Stop }
    catch { return $null }
}

$health   = Get-Api '/health'
$stats    = Get-Api '/api/v1/stats'
$carrier  = Get-Api '/api/carrier/status'
$usage    = Get-Api '/api/automation/usage'
$tailnet  = Get-Api '/api/v1/tailscale/peers'
$devices  = Get-Api '/api/v1/client/devices'
$dashes   = Get-Api '/api/v1/dashboards/probe'

function E($s) { if ($null -eq $s) { return '' } [System.Net.WebUtility]::HtmlEncode([string]$s) }
function Fmt($n) { if ($null -eq $n) { return '-' } '{0:N0}' -f [double]$n }

function HumanUptime($sec) {
    if ($null -eq $sec) { return '-' }
    $t = [TimeSpan]::FromSeconds([double]$sec)
    if ($t.TotalDays -ge 1) { return "$([int]$t.TotalDays)d $($t.Hours)h" }
    if ($t.TotalHours -ge 1) { return "$([int]$t.TotalHours)h $($t.Minutes)m" }
    return "$([int]$t.TotalMinutes)m"
}

# ---------- core tier health ----------
$tiers = @()
$scOk = ($health -and $health.superCarrier)
$caOk = ($health -and $health.carrier)
$crOk = ($health -and $health.craftHealthy)
$tiers += [pscustomobject]@{ Name='Super-Carrier'; Detail="pid $($health.superCarrierPid) - port 7777"; Ok=$scOk }
$caDetail = "pid $($health.carrierPid)"
if ($carrier -and $carrier.carrier) { $caDetail = "pid $($carrier.carrier.pid) - port $($carrier.carrier.port) - up $(HumanUptime $carrier.carrier.uptime)" }
$tiers += [pscustomobject]@{ Name='Carrier'; Detail=$caDetail; Ok=$caOk }
$crDetail = 'unknown'
if ($carrier -and $carrier.primaryCraft) { $crDetail = "pid $($carrier.primaryCraft.pid) - port $($carrier.primaryCraft.port) - up $(HumanUptime ($carrier.primaryCraft.uptime/1000))" }
$tiers += [pscustomobject]@{ Name='Craft'; Detail=$crDetail; Ok=$crOk }

$allUp = ($scOk -and $caOk -and $crOk)
if ($allUp) { $bannerText = 'ALL SYSTEMS UP'; $bannerClass = 'good' }
else { $bannerText = 'DEGRADED'; $bannerClass = 'bad' }

$commit = '-'
if ($carrier -and $carrier.carrier) { $commit = $carrier.carrier.gitCommit }

# ---------- local resources ----------
$dbBytes = 0; $dbFiles = 0
$dataDir = Join-Path $env:LOCALAPPDATA 'PAN\data'
if (Test-Path $dataDir) {
    Get-ChildItem $dataDir -Filter *.db -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $dbBytes += $_.Length; $dbFiles++ }
}
$dbGB = [Math]::Round($dbBytes/1GB,2)

$panMem = 0
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $panMem += $_.PrivateMemorySize64 }
$panMemGB = [Math]::Round($panMem/1GB,2)

$sysDisk = Get-PSDrive C -ErrorAction SilentlyContinue
$freeGB = '-'
if ($sysDisk) { $freeGB = [Math]::Round($sysDisk.Free/1GB) }

$os = Get-CimInstance Win32_OperatingSystem
$ramPct = [Math]::Round(100*($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/$os.TotalVisibleMemorySize)

# ---------- rows ----------
$tierRows = ''
foreach ($t in $tiers) {
    $d = 'bad'; if ($t.Ok) { $d = 'good' }
    $tierRows += "<tr><td><span class='dot $d'></span>$(E $t.Name)</td><td class='num muted'>$(E $t.Detail)</td></tr>"
}

# tailnet
$peerRows = ''
$onlineCount = 0; $peerCount = 0
if ($tailnet -and $tailnet.peers) {
    foreach ($p in ($tailnet.peers | Sort-Object @{e={-[int][bool]$_.online}}, host)) {
        $peerCount++
        $d = 'bad'; $when = 'offline'
        if ($p.online) { $d = 'good'; $when = 'online'; $onlineCount++ }
        elseif ($p.lastSeen) { try { $when = "last seen $([datetime]$p.lastSeen | Get-Date -Format 'yyyy-MM-dd')" } catch { $when = 'offline' } }
        $peerRows += "<tr><td><span class='dot $d'></span>$(E $p.host)</td><td class='num muted'>$(E $p.ip) &middot; $(E $when)</td></tr>"
    }
}
if (-not $peerRows) { $peerRows = "<tr><td colspan='2' class='muted'>Tailnet unreachable</td></tr>" }
$tsState = 'unknown'
if ($tailnet) { $tsState = $tailnet.backendState }

# devices
$devRows = ''
if ($devices -and $devices.devices) {
    foreach ($d in $devices.devices) {
        $caps = ''
        if ($d.capabilities) { $caps = (($d.capabilities -split '\s+') | Select-Object -First 3) -join ', ' }
        $devRows += "<tr><td>$(E $d.name)</td><td class='num muted'>$(E $d.device_id) &middot; $(E $caps)</td></tr>"
    }
}
if (-not $devRows) { $devRows = "<tr><td colspan='2' class='muted'>No registered devices</td></tr>" }

# AI usage
$usageRows = ''
$costToday = 0; $callsToday = 0
if ($usage -and $usage.today) {
    if ($usage.today.total_cost_cents) { $costToday = [Math]::Round([double]$usage.today.total_cost_cents,2) }
    if ($usage.today.total_calls) { $callsToday = $usage.today.total_calls }
    if ($usage.today.by_caller) {
        $callers = @()
        foreach ($prop in $usage.today.by_caller.PSObject.Properties) {
            $v = $prop.Value
            $c = 0; $cost = 0
            try { $c = [int]$v.calls } catch {}
            try { $cost = [Math]::Round([double]$v.cost_cents,2) } catch {}
            $callers += [pscustomobject]@{ Name=$prop.Name; Calls=$c; Cost=$cost }
        }
        foreach ($c in ($callers | Sort-Object Cost -Descending | Select-Object -First 8)) {
            $usageRows += "<tr><td>$(E $c.Name)</td><td class='num muted'>$($c.Calls) calls &middot; $($c.Cost)&cent;</td></tr>"
        }
    }
}
if (-not $usageRows) { $usageRows = "<tr><td colspan='2' class='muted'>No usage recorded today</td></tr>" }

# registered dashboards (this page is the index)
$dashRows = ''
if ($dashes -and $dashes.dashboards) {
    foreach ($d in $dashes.dashboards) {
        $dot = 'bad'; if ($d.status -eq 'up') { $dot = 'good' }
        $dashRows += "<tr><td><span class='dot $dot'></span><a href='$(E $d.url)' target='_blank'>$(E $d.name)</a></td><td class='num muted'>$(E $d.category)</td></tr>"
    }
}
if (-not $dashRows) { $dashRows = "<tr><td colspan='2' class='muted'>No dashboards registered</td></tr>" }

$evTotal = '-'; $memItems = '-'; $projects = '-'
if ($stats) { $evTotal = Fmt $stats.total_events; $memItems = Fmt $stats.memory_items; $projects = $stats.projects }

$html = @"
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>PAN System</title>
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
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.stat{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px}
.stat .n{font-size:22px;font-weight:700;letter-spacing:-.02em}
.stat .l{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:6px 0;border-bottom:1px solid #21262d;vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
tr:last-child td{border-bottom:none}
.muted{color:#8b949e}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:middle}
.dot.good{background:#3fb950}.dot.bad{background:#f85149}
.foot{color:#484f58;font-size:11px;text-align:center;margin-top:18px}
@media(prefers-color-scheme:light){
 body{background:#f6f8fa;color:#1f2328}
 .card{background:#fff;border-color:#d1d9e0}
 .stat{background:#f6f8fa;border-color:#d1d9e0}
 td{border-color:#d1d9e0}
}
</style></head><body>

<h1>PAN System</h1>
<div class="sub">desktop-pc hub &middot; commit $(E $commit) &middot; Tailscale $(E $tsState)</div>

<div class="card">
  <h2>Process tiers</h2>
  <div class="verdict $bannerClass">$bannerText</div>
  <table>$tierRows</table>
</div>

<div class="grid">
  <div class="stat"><div class="n">$evTotal</div><div class="l">events stored</div></div>
  <div class="stat"><div class="n">$memItems</div><div class="l">memory items</div></div>
  <div class="stat"><div class="n">$dbGB GB</div><div class="l">database on disk</div></div>
  <div class="stat"><div class="n">$costToday&cent;</div><div class="l">AI spend today ($callsToday calls)</div></div>
  <div class="stat"><div class="n">$onlineCount/$peerCount</div><div class="l">tailnet peers online</div></div>
  <div class="stat"><div class="n">$ramPct%</div><div class="l">host RAM used</div></div>
</div>

<div class="card">
  <h2>All dashboards</h2>
  <table>$dashRows</table>
</div>

<div class="card">
  <h2>Tailnet</h2>
  <table>$peerRows</table>
</div>

<div class="card">
  <h2>Registered devices</h2>
  <table>$devRows</table>
</div>

<div class="card">
  <h2>AI usage today, by caller</h2>
  <table>$usageRows</table>
</div>

<div class="card">
  <h2>Host resources</h2>
  <table>
    <tr><td>PAN node processes</td><td class="num muted">$panMemGB GB private</td></tr>
    <tr><td>C: free space</td><td class="num muted">$freeGB GB</td></tr>
    <tr><td>Database files</td><td class="num muted">$dbFiles files &middot; $dbGB GB</td></tr>
    <tr><td>Projects tracked</td><td class="num muted">$projects</td></tr>
  </table>
</div>

<div class="foot">Updated $($Now.ToString('yyyy-MM-dd HH:mm')) &middot; auto-refresh 5 min &middot; PAN-SystemDashboard</div>
</body></html>
"@

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$html | Out-File -FilePath $OutFile -Encoding utf8 -Force

Write-Output "wrote $OutFile"
Write-Output "tiers: SC=$scOk CA=$caOk CR=$crOk | events=$evTotal db=$dbGB GB | peers=$onlineCount/$peerCount | AI=$costToday cents"
