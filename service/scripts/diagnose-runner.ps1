# diagnose-runner.ps1 - automated, crash-resilient hang hunt.
#
# The problem with running the stress phases by hand is that a hang destroys the
# test along with the machine. So this keeps its state on disk and re-enters
# itself from the Startup folder after every reboot:
#
#   - marks a phase "running" BEFORE starting it and flushes to disk
#   - if it starts up and finds a phase still marked "running", that phase
#     HUNG the machine. That is the result we want, recorded automatically.
#   - otherwise it marks the phase "survived" and moves to the next
#   - when every phase is done it writes a verdict and disarms itself
#
# Net effect: fire once, walk away, read the verdict. A hang no longer loses data,
# it IS the data.

$ErrorActionPreference = 'Continue'

# Single-instance guard. Without this, a delayed Startup-folder launch can race a
# running instance: the newcomer sees the phase the live instance just marked
# "running" and mis-reports it as HUNG. Only one runner may exist at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Global\PAN-DiagnoseRunner')
if (-not $mutex.WaitOne(0)) {
    Write-Host "another diagnose-runner is already active - exiting"
    return
}

$Dir       = Join-Path $env:LOCALAPPDATA 'PAN\blackbox'
$StatePath = Join-Path $Dir 'diagnose-state.json'
$VerdictPath = Join-Path $Dir 'diagnose-verdict.txt'
$StressScript = Join-Path $PSScriptRoot 'stress-core.ps1'
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }

function Save-State($s) {
    $json = $s | ConvertTo-Json -Depth 6
    $fs = [System.IO.FileStream]::new($StatePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    $sw = [System.IO.StreamWriter]::new($fs)
    $sw.Write($json); $sw.Flush(); $fs.Flush($true); $sw.Dispose(); $fs.Dispose()
}
function Log($m) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path (Join-Path $Dir 'diagnose.log') -Value $line -Encoding UTF8
    Write-Host $line
}

# ---------- load or create state ----------
if (Test-Path $StatePath) {
    try { $state = Get-Content $StatePath -Raw | ConvertFrom-Json } catch { $state = $null }
}
if (-not $state) {
    $state = [pscustomobject]@{
        started  = (Get-Date).ToString('s')
        active   = $true
        phases   = @(
            [pscustomobject]@{ name='Bad';  minutes=20; status='pending'; note='load ONLY the degrading core (cpu 8,9)' },
            [pscustomobject]@{ name='Good'; minutes=20; status='pending'; note='load the other 30 threads, avoid 8,9' }
        )
    }
    Save-State $state
    Log "new diagnostic session created"
}

if (-not $state.active) { Log "session already complete - nothing to do"; return }

# ---------- did a phase hang the machine? ----------
$interrupted = $state.phases | Where-Object { $_.status -eq 'running' }
foreach ($p in $interrupted) {
    $p.status = 'HUNG'
    Log "*** PHASE '$($p.name)' WAS RUNNING WHEN THE MACHINE DIED -> recorded as HUNG ***"
}
if ($interrupted) { Save-State $state }

# ---------- run the next pending phase ----------
$next = $state.phases | Where-Object { $_.status -eq 'pending' } | Select-Object -First 1

if ($next) {
    Log "starting phase '$($next.name)' for $($next.minutes) min - $($next.note)"
    $next.status = 'running'
    Save-State $state          # flushed BEFORE the burn, so a hang is detectable

    try {
        & $StressScript -Target $next.name -Minutes $next.minutes
        $next.status = 'survived'
        Log "phase '$($next.name)' SURVIVED $($next.minutes) min"
    } catch {
        $next.status = 'error'
        Log "phase '$($next.name)' errored: $($_.Exception.Message)"
    }
    Save-State $state

    # more to do? relaunch self so the next phase runs without waiting for a reboot
    $more = $state.phases | Where-Object { $_.status -eq 'pending' }
    if ($more) {
        Log "chaining to next phase"
        Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"" -WindowStyle Hidden
        return
    }
}

# ---------- all phases resolved: verdict ----------
$bad  = ($state.phases | Where-Object { $_.name -eq 'Bad' }).status
$good = ($state.phases | Where-Object { $_.name -eq 'Good' }).status

if ($bad -eq 'pending' -or $good -eq 'pending') { return }

$v = @()
$v += "DIAGNOSTIC VERDICT   (session started $($state.started))"
$v += "=================================================="
$v += "Phase 'Bad'  (only cpu 8,9 - the degrading core) : $bad"
$v += "Phase 'Good' (the other 30 threads)              : $good"
$v += ""

if ($bad -eq 'HUNG' -and $good -eq 'survived') {
    $v += "CONCLUSION: THE FAILING CORE IS THE CAUSE."
    $v += "Loading only the degraded P-core hung the machine; loading all 30 healthy"
    $v += "threads did not. That is a direct causal link. The CPU is failing and no"
    $v += "software change will fix it - plan the replacement."
} elseif ($bad -eq 'HUNG' -and $good -eq 'HUNG') {
    $v += "CONCLUSION: LOAD-TRIGGERED, BUT NOT CORE-SPECIFIC."
    $v += "Both loads hung it, so this is not isolated to the bad core. Suspect power"
    $v += "delivery / VRM under load, or a platform-wide fault. Check the blackbox CSV"
    $v += "for the AC and discharging columns in the seconds before each hang."
} elseif ($bad -eq 'survived' -and $good -eq 'HUNG') {
    $v += "CONCLUSION: UNEXPECTED - the healthy cores hung it and the bad one did not."
    $v += "That inverts the CPU theory. Look hard at drivers (Hyper-V + VirtualBox) and"
    $v += "at the blackbox data around the hang."
} else {
    $v += "CONCLUSION: NOT REPRODUCIBLE UNDER LOAD."
    $v += "Neither phase hung the machine. Be careful reading this as 'the CPU is fine' -"
    $v += "the real crashes are 10-17 hours apart, so 20 minutes of load surviving is WEAK"
    $v += "evidence, not a clean bill of health. It does argue the hang is not simply"
    $v += "load-driven. Next suspects: driver deadlock (Hyper-V + VirtualBox coexist here,"
    $v += "with recurring VBoxNetLwf errors) and the RAM Windows itself occupies, which"
    $v += "the live test could not reach - that needs MemTest86 from USB."
}
$v += ""
$v += "Black box CSV : $Dir\blackbox-<date>.csv"
$v += "Heartbeat log : $Dir\stress-heartbeat.log"
$v += "Read the run-up to any hang with: read-blackbox.ps1"

$text = $v -join "`r`n"
Set-Content -Path $VerdictPath -Value $text -Encoding UTF8
Log "VERDICT WRITTEN -> $VerdictPath"
Write-Host ""
Write-Host $text

$state.active = $false
Save-State $state

# disarm the startup resume hook so this never re-runs on future boots
$hook = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\PAN-Diagnose.vbs'
if (Test-Path $hook) { Remove-Item $hook -Force -EA SilentlyContinue; Log "startup resume hook removed" }
