# PAN Desktop Agent
# Runs in the user session, polls PAN service for desktop actions

$panUrl = "http://127.0.0.1:7777"
$pollInterval = 2
$claudePath = "$env:APPDATA\npm\claude.cmd"

Write-Host "[PAN Agent] Desktop agent started." -ForegroundColor Cyan

function Get-OriginalPath($path) {
    # Read .pan file to find original project path (handles renamed folders)
    $panFile = Join-Path $path ".pan"
    if (-not (Test-Path $panFile)) { return $path }

    try {
        $panData = Get-Content $panFile -Raw | ConvertFrom-Json
        $claudeDir = $panData.claude_project_dir
        if (-not $claudeDir) { return $path }

        $indexFile = Join-Path $claudeDir "sessions-index.json"
        if (-not (Test-Path $indexFile)) { return $path }

        $idx = Get-Content $indexFile -Raw | ConvertFrom-Json
        if ($idx.entries.Count -gt 0) {
            $origPath = $idx.entries[0].projectPath
            if (Test-Path $origPath) {
                return $origPath
            }
        }
    } catch {}

    return $path
}

while ($true) {
    try {
        $response = Invoke-RestMethod -Uri "$panUrl/api/v1/actions" -Method Get -TimeoutSec 5 -ErrorAction Stop

        foreach ($action in $response) {
            if ($action.type -eq "command") {
                Write-Host "[PAN Agent] Running command: $($action.command)" -ForegroundColor Magenta
                try {
                    Invoke-Expression $action.command
                    Write-Host "[PAN Agent] Command completed" -ForegroundColor Green
                } catch {
                    Write-Host "[PAN Agent] Command failed: $_" -ForegroundColor Red
                }
            }
            elseif ($action.type -eq "terminal") {
                $name = $action.name
                $path = $action.path

                Write-Host "[PAN Agent] Opening: $name at $path" -ForegroundColor Green

                # Find original path so --continue can find existing sessions
                $resumePath = Get-OriginalPath $path
                if ($resumePath -ne $path) {
                    Write-Host "[PAN Agent] Using original path: $resumePath" -ForegroundColor Yellow
                }

                $batPath = "$env:TEMP\pan-terminal-$($action.id).bat"

                @"
@echo off
cd /d "$resumePath"
echo === $name ===
"$claudePath" --continue
"@ | Out-File -FilePath $batPath -Encoding ascii

                Start-Process "wt.exe" -ArgumentList "$batPath"
            }
        }
    }
    catch {}

    Start-Sleep -Seconds $pollInterval
}
