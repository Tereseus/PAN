# Registers and starts the PAN-Link-Client scheduled task on a second computer: at boot, as
# SYSTEM, no time limit. Needs an elevated PowerShell. Pair first:
#   pan-link.exe pair --data "<PAN folder>\link-client" --code "pan://pair?..." --name "<this PC>"
# (the code from PAN's /pair/ page, "Pairing a computer instead?"). Then PAN is at
# http://127.0.0.1:7779 on this computer.
param([string]$Dir = (Join-Path $env:LOCALAPPDATA 'PAN\pan-link'))
$ErrorActionPreference = 'Stop'
$bat = Join-Path $Dir 'start-pan-link-client.bat'
if (-not (Test-Path $bat)) { throw "missing $bat" }
$state = Join-Path (Split-Path $Dir -Parent) 'link-client\client.json'
if (-not (Test-Path $state)) { throw "not paired yet: no $state" }
$a = New-ScheduledTaskAction -Execute $bat
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PAN-Link-Client' -Action $a -Trigger $t -Principal $p -Settings $s -Force `
  -Description 'PAN Link on this computer (pan-link client): PAN on the hub at http://127.0.0.1:7779. Its launcher restarts it if it stops.' | Out-Null
Start-ScheduledTask -TaskName 'PAN-Link-Client'
Start-Sleep -Seconds 4
$task = Get-ScheduledTask -TaskName 'PAN-Link-Client'
$info = Get-ScheduledTaskInfo -TaskName 'PAN-Link-Client'
"task: $($task.State), last run $($info.LastRunTime), result $($info.LastTaskResult)"
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 'http://127.0.0.1:7779/health'
  "PAN through the link: $($r.StatusCode)"
} catch { "PAN through the link: not yet ($($_.Exception.Message)); see link-client\pan-link-client.log" }
