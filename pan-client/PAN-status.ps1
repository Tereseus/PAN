# PAN-status.ps1 - Native status window for PAN Client.
#
# Opened from:
#   • Start Menu shortcut "PAN Status"
#   • Tray right-click → "Open Status..."
#
# Reads pan-status.json (same dir) and renders a compact WinForms window with
# every field the user might care about + action buttons. Auto-refreshes every
# 2 seconds while open.
#
# Run hidden console: `powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File PAN-status.ps1`

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$statusPath = Join-Path $scriptDir 'pan-status.json'
$configPath = Join-Path $scriptDir 'pan-client-config.json'

function Read-Status {
  if (-not (Test-Path $statusPath)) { return $null }
  try { Get-Content $statusPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}

function Format-Duration([int]$seconds) {
  if ($seconds -lt 0)    { return 'never' }
  if ($seconds -lt 60)   { return "${seconds}s" }
  if ($seconds -lt 3600) { return "$([int]($seconds / 60))m" }
  if ($seconds -lt 86400){ return "$([int]($seconds / 3600))h" }
  return "$([int]($seconds / 86400))d"
}

# -- Form --------------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'PAN Client Status'
$form.Size = New-Object System.Drawing.Size(480, 420)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 17, 24, 39) # slate-900
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

# Title strip with colored dot + device name
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Location = New-Object System.Drawing.Point(16, 14)
$titleLabel.Size = New-Object System.Drawing.Size(440, 28)
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.Text = 'PAN Client'
$form.Controls.Add($titleLabel)

$stateLabel = New-Object System.Windows.Forms.Label
$stateLabel.Location = New-Object System.Drawing.Point(16, 44)
$stateLabel.Size = New-Object System.Drawing.Size(440, 22)
$stateLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$stateLabel.Text = '...'
$form.Controls.Add($stateLabel)

# Key/value detail rows
function New-Row($yPos, $key) {
  $kLabel = New-Object System.Windows.Forms.Label
  $kLabel.Location = New-Object System.Drawing.Point(16, $yPos)
  $kLabel.Size = New-Object System.Drawing.Size(140, 18)
  $kLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 156, 163, 175) # slate-400
  $kLabel.Text = $key
  $form.Controls.Add($kLabel)

  $vLabel = New-Object System.Windows.Forms.Label
  $vLabel.Location = New-Object System.Drawing.Point(160, $yPos)
  $vLabel.Size = New-Object System.Drawing.Size(296, 18)
  $vLabel.ForeColor = [System.Drawing.Color]::White
  $vLabel.Text = '-'
  $form.Controls.Add($vLabel)
  return $vLabel
}

$vDevice    = New-Row 86  'Device'
$vHub       = New-Row 108 'Hub'
$vMode      = New-Row 130 'Mode'
$vApproved  = New-Row 152 'Approved'
$vHeartbeat = New-Row 174 'Last heartbeat'
$vUptime    = New-Row 196 'Client uptime'
$vRetry     = New-Row 218 'Reconnect delay'
$vPid       = New-Row 240 'PID'
$vVersion   = New-Row 262 'Version'
$vWritten   = New-Row 284 'Status file age'

# -- Buttons -----------------------------------------------------------------
$btnDash = New-Object System.Windows.Forms.Button
$btnDash.Location = New-Object System.Drawing.Point(16, 326)
$btnDash.Size = New-Object System.Drawing.Size(140, 32)
$btnDash.Text = 'Open Dashboard'
$btnDash.FlatStyle = 'Flat'
$btnDash.BackColor = [System.Drawing.Color]::FromArgb(255, 59, 130, 246) # blue-500
$btnDash.ForeColor = [System.Drawing.Color]::White
$btnDash.Add_Click({
  $s = Read-Status
  if ($s -and $s.hub_http) { Start-Process "$($s.hub_http)/v2/terminal" }
})
$form.Controls.Add($btnDash)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Location = New-Object System.Drawing.Point(166, 326)
$btnRefresh.Size = New-Object System.Drawing.Size(100, 32)
$btnRefresh.Text = 'Refresh'
$btnRefresh.FlatStyle = 'Flat'
$btnRefresh.BackColor = [System.Drawing.Color]::FromArgb(255, 71, 85, 105) # slate-600
$btnRefresh.ForeColor = [System.Drawing.Color]::White
$btnRefresh.Add_Click({ Update-Form })
$form.Controls.Add($btnRefresh)

$btnReinstall = New-Object System.Windows.Forms.Button
$btnReinstall.Location = New-Object System.Drawing.Point(276, 326)
$btnReinstall.Size = New-Object System.Drawing.Size(100, 32)
$btnReinstall.Text = 'Reinstall'
$btnReinstall.FlatStyle = 'Flat'
$btnReinstall.BackColor = [System.Drawing.Color]::FromArgb(255, 71, 85, 105)
$btnReinstall.ForeColor = [System.Drawing.Color]::White
$btnReinstall.Add_Click({
  $s = Read-Status
  if ($s -and $s.hub_http) { Start-Process "$($s.hub_http)/" }
})
$form.Controls.Add($btnReinstall)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Location = New-Object System.Drawing.Point(386, 326)
$btnClose.Size = New-Object System.Drawing.Size(70, 32)
$btnClose.Text = 'Close'
$btnClose.FlatStyle = 'Flat'
$btnClose.BackColor = [System.Drawing.Color]::FromArgb(255, 71, 85, 105)
$btnClose.ForeColor = [System.Drawing.Color]::White
$btnClose.Add_Click({ $form.Close() })
$form.Controls.Add($btnClose)

# -- Update logic ------------------------------------------------------------
function Update-Form {
  $s = Read-Status
  if (-not $s) {
    $stateLabel.Text = '* No status file - pan-client may not be running'
    $stateLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
    $vDevice.Text = $env:COMPUTERNAME
    return
  }
  $titleLabel.Text = "PAN Client - $($s.device_name)"

  $age = if ($s.heartbeat_age_ms) { [int]($s.heartbeat_age_ms / 1000) } else { -1 }
  $nowMs = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $writtenAgoSec = [int](($nowMs - [int64]$s.written_at_ms) / 1000)
  if ($writtenAgoSec -lt 0) { $writtenAgoSec = 0 }

  if ($writtenAgoSec -gt 30) {
    $stateLabel.Text = "* Status file stale ($writtenAgoSec s) - client process likely crashed"
    $stateLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
  } elseif ($s.approved -eq $false) {
    $stateLabel.Text = '* Waiting for hub owner approval'
    $stateLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 234, 179, 8)
  } elseif (-not $s.connected) {
    $stateLabel.Text = "* Disconnected - retrying in $([int]($s.reconnect_delay_ms / 1000)) s"
    $stateLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
  } elseif ($s.heartbeat_stale) {
    $stateLabel.Text = "* Heartbeat stale (last $(Format-Duration $age))"
    $stateLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
  } else {
    $stateLabel.Text = "* Connected ($($s.mode))"
    $stateLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
  }

  $vDevice.Text     = "$($s.device_name) ($($s.device_id))"
  $vHub.Text        = if ($s.hub_http) { $s.hub_http } else { '-' }
  $vMode.Text       = $s.mode
  $vApproved.Text   = if ($s.approved -eq $true) { 'Yes' } elseif ($s.approved -eq $false) { 'Pending' } else { 'Unknown' }
  $vHeartbeat.Text  = if ($age -ge 0) { "$(Format-Duration $age) ago" } else { 'never' }
  $vUptime.Text     = Format-Duration ([int]$s.uptime_s)
  $vRetry.Text      = "$([int]($s.reconnect_delay_ms / 1000)) s"
  $vPid.Text        = "$($s.pid)"
  $vVersion.Text    = "$($s.version) / $($s.platform)"
  $vWritten.Text    = "$writtenAgoSec s"
}

# Auto-refresh every 2 seconds. Stopped on close so the timer doesn't keep
# the process alive after the window goes away.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Form })
$timer.Start()
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })

Update-Form
[void]$form.ShowDialog()
