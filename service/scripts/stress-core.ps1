# stress-core.ps1 - try to reproduce the hang ON DEMAND, and pin down whether
# the failing P-core is responsible.
#
# WHEA says every corrected parity error is on APIC 8 and 9, which are the two
# hyperthreads of ONE physical P-core. So instead of a generic all-core burn,
# we can load that core SPECIFICALLY and compare it against the healthy ones:
#
#   -Target Bad    load ONLY logical CPUs 8,9   (the degraded core)
#   -Target Good   load everything EXCEPT 8,9   (the healthy cores)
#   -Target All    load everything
#
# If Bad hangs the machine and Good runs clean for the same duration, that is
# as close to proof as we can get without a parts swap. If BOTH run clean,
# the hang is probably not load-driven and we look at drivers or RAM instead.
#
# A heartbeat is flushed to disk every few seconds. If the machine hangs, the
# last heartbeat tells us exactly how long it survived and under what load.
#
# WARNING: this is DESIGNED to provoke a hang. Save your work first.

param(
    [ValidateSet('Bad','Good','All')]
    [string]$Target = 'Bad',
    [int]$Minutes = 10,
    [int]$ThreadsPerCpu = 1
)

$ErrorActionPreference = 'Continue'

$LogDir = Join-Path $env:LOCALAPPDATA 'PAN\blackbox'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir 'stress-heartbeat.log'

$cpuCount = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$BAD_CPUS = @(8,9)   # the two hyperthreads of the degrading P-core

switch ($Target) {
    'Bad'  { $cpus = $BAD_CPUS }
    'Good' { $cpus = (0..($cpuCount-1)) | Where-Object { $BAD_CPUS -notcontains $_ } }
    'All'  { $cpus = 0..($cpuCount-1) }
}

# affinity mask: bit N = logical CPU N
[int64]$mask = 0
foreach ($c in $cpus) { $mask = $mask -bor ([int64]1 -shl $c) }

$fs = [System.IO.FileStream]::new($LogPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
$sw = [System.IO.StreamWriter]::new($fs); $sw.AutoFlush = $true
function Beat($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    $sw.WriteLine($line); $sw.Flush(); $fs.Flush($true)
    Write-Host $line
}

Beat "==== START target=$Target cpus=[$($cpus -join ',')] mask=0x$('{0:X}' -f $mask) minutes=$Minutes ===="

# Worker: pure PowerShell arithmetic loop.
#
# This used to Add-Type a C# burner, which is faster per core but breaks at scale:
# 30 workers launching at once means 30 concurrent csc.exe compilations fighting
# over the same temp directory, and most of them silently fail to start. We ended
# up with 3 workers instead of 30 and a worthless control run. A plain interpreter
# loop is less efficient per thread but pegs it just as hard and always starts.
# NOTE the placeholder token. It used to be bare "SECONDS", which -replace matched
# case-insensitively against the "Seconds" inside "AddSeconds" - every worker got
# (Get-Date).Add1230(1230) and died instantly, silently invalidating a whole run.
# Use a token that cannot collide with real code.
$workerCode = @'
$end = (Get-Date).AddSeconds(__BURNSECS__)
$a = 1.0000001
$n = 0
while ((Get-Date) -lt $end) {
    for ($i = 0; $i -lt 200000; $i++) {
        $a = $a * 1.0000000001 + 0.0000001
        if ($a -gt 1e10) { $a = 1.0000001 }
        $n = $n + ($i -band 0xFF)
    }
}
'@

$seconds = $Minutes * 60
$procs = @()
$spawn = @()
foreach ($c in $cpus) { for ($t = 0; $t -lt $ThreadsPerCpu; $t++) { $spawn += $c } }

foreach ($c in $spawn) {
    $code = $workerCode -replace '__BURNSECS__', ($seconds + 30)
    $bytes = [Text.Encoding]::Unicode.GetBytes($code)
    $enc = [Convert]::ToBase64String($bytes)
    $p = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$enc -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 250
    try {
        $p.ProcessorAffinity = [IntPtr]([int64]1 -shl $c)   # pin each worker to one logical CPU
        $procs += $p
    } catch {
        Beat "  WARN: could not set affinity for pid $($p.Id) on cpu $c : $($_.Exception.Message)"
        $procs += $p
    }
}
# Verify the workers actually exist. A silently-failed spawn produced an invalid
# control run once, so count survivors rather than trusting the loop.
Start-Sleep -Seconds 3
$alive = @($procs | Where-Object { -not $_.HasExited })
Beat "spawned $($procs.Count) workers, $($alive.Count) still alive, pinned to cpus [$($spawn -join ',')]"
if ($alive.Count -lt $spawn.Count) {
    Beat "  WARNING: $($spawn.Count - $alive.Count) worker(s) died on launch - results may be invalid"
}

$startWhea = 0
try { $startWhea = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; Id=19; StartTime=(Get-Date).AddMinutes(-1)} -EA Stop).Count } catch {}

$deadline = (Get-Date).AddMinutes($Minutes)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $cpuNow = ''
    try { $cpuNow = [math]::Round((Get-Counter '\Processor Information(_Total)\% Processor Time' -EA Stop).CounterSamples[0].CookedValue,1) } catch {}
    $whea = 0
    try { $whea = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; Id=19; StartTime=(Get-Date).AddMinutes(-$Minutes)} -EA Stop).Count } catch {}
    $left = [int](($deadline - (Get-Date)).TotalSeconds)
    Beat ("  alive  cpu={0}%  whea_this_run={1}  {2}s left" -f $cpuNow, $whea, $left)
}

foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -EA SilentlyContinue } catch {} }
Beat "==== SURVIVED target=$Target for $Minutes min - no hang ===="
$sw.Dispose(); $fs.Dispose()

Write-Host ""
Write-Host "Machine survived. Heartbeat log: $LogPath"
Write-Host "If it had hung, the last heartbeat line would show how far it got."
