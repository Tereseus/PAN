# Removes PAN from this computer, for this Windows user.
#
# Stops PAN, takes away the start at logon, the Apps entry, the Start menu link, the
# firewall rule and the program files. The data folder (memory, settings, pairings) stays
# unless -RemoveData is given, or the person says yes when asked.
#
# It only ever touches a folder that holds PAN's own install.json.
#
# Plain ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 files that have no BOM.

param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "PAN"),
    [switch]$RemoveData,
    [switch]$KeepModels,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$left = @()

function Say($text) { Write-Host $text }
function Is-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$configPath = Join-Path $InstallDir "install.json"
if (-not (Test-Path $configPath)) {
    Say ("PAN is not installed in " + $InstallDir + " (no install.json). Nothing was changed.")
    exit 2
}
if ($InstallDir.Length -lt 8 -or $InstallDir -ieq $env:USERPROFILE -or $InstallDir -ieq $env:LOCALAPPDATA) {
    Say ("Refusing to remove " + $InstallDir)
    exit 3
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$tag = if ($config.tag) { [string]$config.tag } else { "PAN" }
$dataDir = if ($config.dataDir) { [string]$config.dataDir } else { Join-Path $InstallDir "data" }
Say ("Removing PAN {0} from {1}" -f $config.version, $InstallDir)

# 1. Stop everything that runs out of this folder.
$prefix = $InstallDir.TrimEnd('\') + '\'
for ($round = 0; $round -lt 4; $round++) {
    $mine = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $_.ProcessId -ne $PID
    })
    if ($mine.Count -eq 0) { break }
    foreach ($p in $mine) { try { & taskkill.exe /F /T /PID $p.ProcessId 2>$null | Out-Null } catch {} }
    Start-Sleep -Seconds 2
}
Say "  Stopped."

# 1b. The models PAN Setup downloaded, and Ollama if PAN Setup installed it and nothing else
#     is left in it. A person's own models, and an Ollama they had before, are not touched.
$added = @($config.modelsAdded | Where-Object { $_ })
if ($added.Count -gt 0 -and -not $KeepModels) {
    foreach ($port in 7786, 7787) {
        # PAN's own two readers run Ollama's llama-server from outside this folder.
        try {
            $owner = (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -First 1).OwningProcess
            if ((Get-Process -Id $owner).ProcessName -ieq "llama-server") { & taskkill.exe /F /PID $owner 2>$null | Out-Null }
        } catch {}
    }
    $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $ollama) {
        function Ollama-Left {
            # $null when Ollama does not answer; else the models it still holds (maybe none).
            try { $m = @(((Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 8).Content | ConvertFrom-Json).models) }
            catch { return $null }
            return ,$m
        }
        # Ollama has to be running to delete a model. PAN's launcher ran it and step 1 just
        # stopped it, so start it for the cleanup and stop it again after.
        $mine = $null
        if ($null -eq (Ollama-Left)) {
            $mine = Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden -PassThru
            for ($i = 0; $i -lt 60 -and $null -eq (Ollama-Left); $i++) { Start-Sleep -Seconds 2 }
        }
        if ($null -eq (Ollama-Left)) {
            $left += "the models and Ollama (Ollama did not start, so they were left alone)"
        } else {
            foreach ($m in $added) {
                try { Start-Process -FilePath $ollama -ArgumentList @("rm", [string]$m) -Wait -NoNewWindow -RedirectStandardOutput (Join-Path $env:TEMP "pan-ollama-rm.out") -RedirectStandardError (Join-Path $env:TEMP "pan-ollama-rm.err") | Out-Null } catch {}
            }
            Say ("  Removed {0} models." -f $added.Count)
            $rest = Ollama-Left
            if ($config.ollamaInstalledBySetup -and $null -ne $rest -and $rest.Count -eq 0) {
                Get-Process | Where-Object { $_.ProcessName -match '^(ollama|ollama app|llama-server)$' } | ForEach-Object { try { & taskkill.exe /F /PID $_.Id 2>$null | Out-Null } catch {} }
                Start-Sleep -Seconds 2
                $un = Join-Path $env:LOCALAPPDATA "Programs\Ollama\unins000.exe"
                if (Test-Path $un) { Start-Process -FilePath $un -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" -Wait | Out-Null }
                $store = Join-Path $env:USERPROFILE ".ollama"
                if (Test-Path $store) { Remove-Item $store -Recurse -Force -ErrorAction SilentlyContinue }
                Say "  Removed Ollama (PAN Setup had installed it)."
            } else {
                if ($config.ollamaInstalledBySetup) { Say "  Ollama stays: it holds models that are not PAN's." }
                if ($mine) { try { & taskkill.exe /F /T /PID $mine.Id 2>$null | Out-Null } catch {} }
            }
        }
    }
}

# 2. Start at logon, the Apps entry, the Start menu link.
try { Remove-ItemProperty -Path $RunKey -Name $tag -ErrorAction Stop } catch {}
try { Remove-Item -Path (Join-Path $UninstallKey $tag) -Recurse -Force -ErrorAction Stop } catch {}
if ($tag -eq "PAN") {
    $link = Join-Path ([Environment]::GetFolderPath("Programs")) "PAN.url"
    if (Test-Path $link) { Remove-Item $link -Force -ErrorAction SilentlyContinue }
}

# 3. The firewall rule, if PAN Setup added one.
if ($config.firewallRule) {
    $rule = [string]$config.firewallRule
    $fw = 'advfirewall firewall delete rule name="{0}"' -f $rule
    if (Is-Admin) {
        & netsh.exe advfirewall firewall delete rule ("name=" + $rule) | Out-Null
        Say "  Firewall rule removed."
    } elseif ($Quiet) {
        $left += ('the firewall rule "{0}" (needs an administrator)' -f $rule)
    } else {
        try {
            Say "  Windows will ask once for permission to remove PAN's firewall rule."
            Start-Process netsh.exe -ArgumentList $fw -Verb RunAs -Wait -WindowStyle Hidden
        } catch { $left += ('the firewall rule "{0}"' -f $rule) }
    }
}

# 4. The data: only when asked.
$dropData = [bool]$RemoveData
if (-not $dropData -and -not $Quiet -and (Test-Path $dataDir)) {
    $answer = Read-Host "Also delete PAN's memory and settings on this computer? This cannot be undone. Type YES to delete"
    $dropData = ($answer -ceq "YES")
}

# 5. The files.
$dataInside = $dataDir.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
foreach ($item in Get-ChildItem $InstallDir -Force) {
    if ($dataInside -and ($item.FullName -ieq $dataDir) -and -not $dropData) { continue }
    try { Remove-Item $item.FullName -Recurse -Force -ErrorAction Stop }
    catch {
        Start-Sleep -Seconds 2
        try { Remove-Item $item.FullName -Recurse -Force -ErrorAction Stop } catch { $left += $item.FullName }
    }
}
if ($dropData -and -not $dataInside -and (Test-Path $dataDir)) {
    try { Remove-Item $dataDir -Recurse -Force } catch { $left += $dataDir }
}
if (@(Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
    Set-Location $env:TEMP
    Remove-Item $InstallDir -Force -ErrorAction SilentlyContinue
}

if (-not $dropData -and (Test-Path $dataDir)) { Say ("  Your memory and settings were kept in " + $dataDir) }
if ($left.Count -gt 0) {
    Say "PAN was removed, except for:"
    $left | ForEach-Object { Say ("  " + $_) }
    exit 1
}
Say "PAN was removed."
exit 0
