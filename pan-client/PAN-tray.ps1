# PAN-tray.ps1 - System tray icon for PAN Client.
#
# Reads pan-status.json (written every 5s by pan-client.js) from the same
# directory as this script. Renders a tray icon (green/yellow/red) and a
# right-click menu with: Open Dashboard, Open Status, Reinstall Client, Quit.
#
# Launched at login via a schtasks LogonTrigger (see pan-installer.cjs).
# Services on Windows Vista+ run in Session 0 and cannot show UI, so the
# tray must be a separate user-session process from the actual client.
#
# Run hidden: `powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File PAN-tray.ps1`
#
# Single-instance: a named mutex prevents two trays at once (re-running the
# installer or the LogonTrigger firing twice will silently no-op).

# -- Single instance guard ----------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'Global\PAN-Tray-Singleton')
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$statusPath = Join-Path $scriptDir 'pan-status.json'
$statusScript = Join-Path $scriptDir 'PAN-status.ps1'
$configPath = Join-Path $scriptDir 'pan-client-config.json'

# -- Icon factory: 16x16 colored dot on transparent background ---------------
# Cached at module level so we don't leak Bitmap/Icon handles on every refresh.
$global:PAN_ICON_CACHE = @{}
function Get-DotIcon([System.Drawing.Color]$color) {
  $key = "$($color.R)-$($color.G)-$($color.B)"
  if ($global:PAN_ICON_CACHE.ContainsKey($key)) { return $global:PAN_ICON_CACHE[$key] }
  $bmp = New-Object System.Drawing.Bitmap 16,16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 1, 1, 14, 14)
  # Subtle dark border so the dot is visible on both light and dark taskbars.
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 0, 0, 0)), 1
  $g.DrawEllipse($pen, 1, 1, 13, 13)
  $g.Dispose()
  $brush.Dispose()
  $pen.Dispose()
  $hIcon = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($hIcon)
  $global:PAN_ICON_CACHE[$key] = $icon
  return $icon
}

$iconGreen  = Get-DotIcon ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))   # #22c55e
$iconYellow = Get-DotIcon ([System.Drawing.Color]::FromArgb(255, 234, 179, 8))   # #eab308
$iconRed    = Get-DotIcon ([System.Drawing.Color]::FromArgb(255, 239, 68, 68))   # #ef4444
$iconGray   = Get-DotIcon ([System.Drawing.Color]::FromArgb(255, 100, 116, 139)) # #64748b

# -- Status reader -----------------------------------------------------------
function Read-Status {
  if (-not (Test-Path $statusPath)) { return $null }
  try {
    $raw = Get-Content $statusPath -Raw -ErrorAction Stop
    return $raw | ConvertFrom-Json
  } catch { return $null }
}

function Get-HubHttp {
  # Prefer pan-status.json (live), fall back to pan-client-config.json.
  $s = Read-Status
  if ($s -and $s.hub_http) { return $s.hub_http }
  if (Test-Path $configPath) {
    try { return (Get-Content $configPath -Raw | ConvertFrom-Json).hub_http } catch {}
  }
  return $null
}

# -- Tray icon ---------------------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconGray
$notify.Text = 'PAN Client - starting...'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemDashboard = $menu.Items.Add('Open Dashboard')
$itemDashboard.Add_Click({
  $hub = Get-HubHttp
  if ($hub) { Start-Process "$hub/v2/terminal" }
  else { [System.Windows.Forms.MessageBox]::Show('Hub URL unknown - pan-status.json missing or unreadable.', 'PAN') | Out-Null }
})

$itemStatus = $menu.Items.Add('Open Status...')
$itemStatus.Add_Click({
  if (Test-Path $statusScript) {
    Start-Process 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$statusScript`""
  } else {
    [System.Windows.Forms.MessageBox]::Show("Status script not found at:`n$statusScript", 'PAN') | Out-Null
  }
})

$menu.Items.Add('-') | Out-Null

$itemReinstall = $menu.Items.Add('Reinstall PAN Client...')
$itemReinstall.Add_Click({
  $hub = Get-HubHttp
  if ($hub) { Start-Process "$hub/" }
  else { [System.Windows.Forms.MessageBox]::Show('Hub URL unknown. Generate a new install link from the dashboard.', 'PAN') | Out-Null }
})

$menu.Items.Add('-') | Out-Null

$itemQuit = $menu.Items.Add('Quit Tray')
$itemQuit.Add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu

# Double-click on the icon opens the dashboard.
$notify.Add_MouseDoubleClick({
  $hub = Get-HubHttp
  if ($hub) { Start-Process "$hub/v2/terminal" }
})

# -- Refresh loop ------------------------------------------------------------
function Refresh-Tray {
  $s = Read-Status
  if (-not $s) {
    $notify.Icon = $iconGray
    $notify.Text = "PAN Client`nstatus file missing - service may not be running"
    return
  }
  $age = if ($s.heartbeat_age_ms) { [int]($s.heartbeat_age_ms / 1000) } else { -1 }
  # [DateTimeOffset] handles UTC correctly across PS5/PS7. Subtracting two
  # longs avoids the local-vs-UTC ambiguity in (Get-Date) - (Get-Date 'Z').
  $nowMs = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $writtenAgoSec = [int](($nowMs - [int64]$s.written_at_ms) / 1000)
  if ($writtenAgoSec -lt 0) { $writtenAgoSec = 0 }

  $name = $s.device_name
  $hub = $s.hub_http
  $mode = $s.mode
  $approved = $s.approved

  # Pick icon + tooltip text based on state.
  # Red:    service appears alive but unable to heartbeat OR status file stale
  # Yellow: connecting / pending approval
  # Green:  fully connected, fresh heartbeat
  $icon = $iconGray
  $line2 = 'unknown state'
  if ($writtenAgoSec -gt 30) {
    $icon = $iconRed
    $line2 = "status file stale (${writtenAgoSec}s) - client crashed?"
  } elseif ($approved -eq $false) {
    $icon = $iconYellow
    $line2 = 'waiting for hub approval'
  } elseif (-not $s.connected) {
    $icon = $iconRed
    $line2 = "disconnected (retry in $([int]($s.reconnect_delay_ms / 1000))s)"
  } elseif ($s.heartbeat_stale) {
    $icon = $iconRed
    $line2 = "no heartbeat for ${age}s"
  } else {
    $icon = $iconGreen
    $hbLabel = if ($age -ge 0) { "${age}s ago" } else { 'just now' }
    $line2 = "connected ($mode, last heartbeat $hbLabel)"
  }
  $notify.Icon = $icon
  # NotifyIcon.Text is HARD-capped at 63 chars on Win Vista+ via WinForms
  # (the underlying NOTIFYICONDATA struct supports 127, but WinForms checks 64).
  # We can't fit "name + state + hub" in 63 — show name + compact state only.
  $tip = "PAN: $name`n$line2"
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $notify.Text = $tip
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh-Tray })
$timer.Start()
Refresh-Tray

# Pump messages until Quit is selected. Application.Exit() in the Quit handler
# breaks this loop. Without Application.Run(), the NotifyIcon click events
# never fire - the script would exit immediately.
[System.Windows.Forms.Application]::Run()
