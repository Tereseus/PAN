# Registers and starts the PAN-Link scheduled task: at boot, as SYSTEM, no time limit.
param([string]$Dir = (Join-Path $env:LOCALAPPDATA 'PAN\pan-link'))
$ErrorActionPreference = 'Stop'
$bat = Join-Path $Dir 'start-pan-link.bat'
if (-not (Test-Path $bat)) { throw "missing $bat" }
$a = New-ScheduledTaskAction -Execute $bat
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PAN-Link' -Action $a -Trigger $t -Principal $p -Settings $s -Force `
  -Description 'PAN Link hub (pan-link): the WireGuard way in for paired phones and PCs. Its launcher restarts it if it stops.' | Out-Null
Start-ScheduledTask -TaskName 'PAN-Link'
Start-Sleep -Seconds 4
$task = Get-ScheduledTask -TaskName 'PAN-Link'
$info = Get-ScheduledTaskInfo -TaskName 'PAN-Link'
"task: $($task.State), last run $($info.LastRunTime), result $($info.LastTaskResult)"
"limit: $($task.Settings.ExecutionTimeLimit), runs as $($task.Principal.UserId)"
Get-CimInstance Win32_Process -Filter "Name='pan-link.exe'" | ForEach-Object {
  $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
  "pan-link.exe pid $($_.ProcessId) as $($o.Domain)\$($o.User)"
}
