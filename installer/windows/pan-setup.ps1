# PAN Setup for Windows.
#
# Puts PAN on this computer, for this Windows user, and starts it:
#   1. checks the computer
#   2. downloads the current PAN (one zip, checked against its SHA-256)
#   3. unpacks it into <install folder>\app\<version>
#   4. starts PAN at logon and now, hidden
#   5. opens the page with the code the phone scans
#
# Nothing is installed for other users, no service runs as SYSTEM, and PAN listens on this
# computer's own address only. The one thing that needs an administrator is the Windows
# firewall rule for PAN Link's UDP port, which is how the person's phone gets in.
#
# Run again to update: the new version goes beside the old one and the old one is removed
# only after the new one answers.
#
#   -Source     a folder or an http(s) address holding release.json and the zip
#   -Quiet      no questions, no browser, no administrator prompt (for tests)
#   -Voice      also install what PAN talks with: Ollama (its own signed installer, from
#               ollama.com) and the models in service\model-set.json, straight from their
#               publishers. Several GB. Then one real voice turn to see it answers.
#   -Translator also install the computer's own translator: a Python of its own inside the
#               install folder (fetched with uv) and the translation models, from Hugging
#               Face by plain download, each checked against its SHA-256.
#   -All        -Voice and -Translator
#   -OwnModels  a folder or an http(s) address holding PAN's own two models as .gguf files
#               (see model-set.json). Without it they are skipped and the stock ones stand in.
#   -ModelSet   light or full, instead of choosing by this computer's memory
#   -Dev        test mode: PAN skips the parts that act on the whole computer (its steward,
#               the orphan reaper, the device heartbeat). For an install test on a computer
#               that already runs a real PAN.
#
# Plain ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 files that have no BOM.

param(
    [string]$Source = "https://github.com/Tereseus/PAN/releases/latest/download",
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "PAN"),
    [int]$Port = 7777,
    [int]$CarrierPort = 17760,
    [int]$CraftPortBase = 17700,
    [int]$LinkPort = 41720,
    [string]$LinkAdmin = "127.0.0.1:7792",
    [switch]$Quiet,
    [switch]$NoAutostart,
    [switch]$NoFirewall,
    [switch]$NoStart,
    [switch]$Dev,
    [switch]$Voice,
    [switch]$Translator,
    [switch]$All,
    [string]$OwnModels = "",
    [string]$ModelSet = "",
    [int]$StartTimeoutSec = 240
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($All) { $Voice = $true; $Translator = $true }
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
# Two installs side by side (a test beside the real one) must not share names.
$IsDefaultDir = ($InstallDir -ieq [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "PAN")))
$Tag = if ($IsDefaultDir) { "PAN" } else { "PAN-" + ([Math]::Abs($InstallDir.ToLower().GetHashCode()) % 100000) }
$DataDir = Join-Path $InstallDir "data"
$AppRoot = Join-Path $InstallDir "app"
$LogPath = Join-Path $InstallDir "setup.log"
$ResultPath = Join-Path $InstallDir "setup-result.json"
$script:Result = [ordered]@{ ok = $false; step = "start"; version = $null; installDir = $InstallDir; warnings = @() }

function Say($text) {
    Write-Host $text
    try { Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date -Format s), $text) -Encoding UTF8 } catch {}
}
function Step($name, $text) { $script:Result.step = $name; Say ""; Say ("> " + $text) }
function Warn($text) { $script:Result.warnings += $text; Say ("  ! " + $text) }
function WriteText($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
function SaveResult { try { WriteText $ResultPath ($script:Result | ConvertTo-Json -Depth 5) } catch {} }
function Stop-Setup($text) {
    $script:Result.ok = $false
    $script:Result.error = $text
    Say ""
    Say ("PAN Setup stopped: " + $text)
    SaveResult
    exit 1
}
function Is-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Listening($port) {
    try { return @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop) } catch { return @() }
}
function Health($port) {
    # Ready means all of PAN, not just its front door: the front door answers /health a few
    # seconds before the part behind it (the Craft) can serve anything.
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $port) -UseBasicParsing -TimeoutSec 4
        if ($r.StatusCode -ne 200) { return $false }
        $h = $r.Content | ConvertFrom-Json
        if (-not ($h.craftHealthy -eq $true -or $h.status -eq "running")) { return $false }
        $me = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/v1/auth/me" -f $port) -UseBasicParsing -TimeoutSec 6
        return ($me.StatusCode -eq 200)
    } catch { return $false }
}
function Start-Detached($file, $argLine) {
    # Over ssh, Windows ends everything a session started when the session closes. A process
    # made through WMI is not part of the session, so PAN outlives a remote install.
    if ($env:SSH_CONNECTION -or $env:SSH_CLIENT) {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"{0}" {1}' -f $file, $argLine) }
        if ($r.ReturnValue -ne 0) { throw ("could not start {0} (WMI {1})" -f $file, $r.ReturnValue) }
    } else {
        Start-Process -FilePath $file -ArgumentList $argLine -WindowStyle Hidden
    }
}
function Stop-Tree($dir) {
    # Everything running out of this install folder: the launcher, PAN, pan-link and what they started.
    $prefix = $dir.TrimEnd('\') + '\'
    for ($round = 0; $round -lt 3; $round++) {
        $mine = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $_.ProcessId -ne $PID
        })
        if ($mine.Count -eq 0) { return }
        foreach ($p in $mine) { try { & taskkill.exe /F /T /PID $p.ProcessId 2>$null | Out-Null } catch {} }
        Start-Sleep -Seconds 2
    }
}

try {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Say ("PAN Setup, " + (Get-Date -Format "yyyy-MM-dd HH:mm"))
    Say ("Install folder: " + $InstallDir)

    # ---- 1. the computer -------------------------------------------------------------
    Step "check" "Checking this computer"
    if (-not [Environment]::Is64BitOperatingSystem) { Stop-Setup "PAN needs 64 bit Windows." }
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
        Warn "This is an ARM computer. PAN is built for Intel and AMD and will run slower here."
    }
    $build = [Environment]::OSVersion.Version.Build
    if ($build -lt 17763) { Stop-Setup "PAN needs Windows 10 (version 1809 or newer) or Windows 11." }
    $ramGB = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($InstallDir).Substring(0, 1))
    $freeGB = [Math]::Round($drive.Free / 1GB, 1)
    Say ("  Windows build {0}, {1} GB memory, {2} GB free on {3}:" -f $build, $ramGB, $freeGB, $drive.Name)
    if ($ramGB -lt 7.5) { Warn "Less than 8 GB of memory. PAN will run, the voice models may not." }
    if ($freeGB -lt 3) { Stop-Setup ("PAN needs 3 GB of free disk space. This drive has {0} GB." -f $freeGB) }
    $script:Result.computer = [ordered]@{ build = $build; ramGB = $ramGB; freeGB = $freeGB; admin = (Is-Admin) }

    $oldConfig = $null
    $configPath = Join-Path $InstallDir "install.json"
    if (Test-Path $configPath) {
        try { $oldConfig = Get-Content $configPath -Raw | ConvertFrom-Json } catch {}
        if ($oldConfig) { Say ("  PAN {0} is installed here already. Updating." -f $oldConfig.version) }
    } elseif ((Listening $Port).Count -gt 0) {
        Stop-Setup ("Something else on this computer already uses port {0}. Close it, or it may be another copy of PAN." -f $Port)
    }

    # ---- 2. the download -------------------------------------------------------------
    Step "download" "Getting the current PAN"
    $isWeb = $Source -match '^https?://'
    $dl = Join-Path $InstallDir "download"
    New-Item -ItemType Directory -Path $dl -Force | Out-Null
    if ($isWeb) {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
        try {
            $release = (Invoke-WebRequest -Uri ($Source.TrimEnd('/') + "/release.json") -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
        } catch { Stop-Setup ("Could not reach the download page. Check the internet connection. (" + $_.Exception.Message + ")") }
    } else {
        $relFile = Join-Path $Source "release.json"
        if (-not (Test-Path $relFile)) { Stop-Setup ("No release.json in " + $Source) }
        $release = Get-Content $relFile -Raw | ConvertFrom-Json
    }
    if (-not $release.version -or -not $release.file -or -not $release.sha256) { Stop-Setup "The release list is not readable." }
    if ($release.version -notmatch '^[0-9A-Za-z._-]{1,40}$' -or $release.file -notmatch '^[0-9A-Za-z._-]{1,80}\.zip$') {
        Stop-Setup "The release list names a version or a file that is not allowed."
    }
    $version = [string]$release.version
    $script:Result.version = $version
    $sizeMB = [Math]::Round($release.size / 1MB)
    Say ("  PAN {0}, {1} MB" -f $version, $sizeMB)

    $zip = Join-Path $dl $release.file
    $have = (Test-Path $zip) -and ((Get-FileHash $zip -Algorithm SHA256).Hash -ieq $release.sha256)
    if (-not $have) {
        if ($isWeb) {
            $url = $Source.TrimEnd('/') + "/" + $release.file
            $curl = Join-Path $env:SystemRoot "System32\curl.exe"
            if (Test-Path $curl) {
                # curl picks a broken download up where it stopped.
                $curlArgs = @("-L", "--fail", "--retry", "5", "--retry-delay", "3", "-C", "-", "-o", $zip, $url)
                if ($Quiet) { $curlArgs = @("-sS") + $curlArgs }
                & $curl @curlArgs
                if ($LASTEXITCODE -ne 0) { Stop-Setup ("The download did not finish (curl {0}). Run PAN Setup again to carry on." -f $LASTEXITCODE) }
            } else {
                Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
            }
        } else {
            Copy-Item (Join-Path $Source $release.file) $zip -Force
        }
        $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
        if ($hash -ine $release.sha256) {
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            Stop-Setup "The download does not match what was published, so it was thrown away. Run PAN Setup again."
        }
    }
    Say "  Downloaded and checked."

    # ---- 3. unpack -------------------------------------------------------------------
    Step "unpack" "Unpacking"
    $target = Join-Path $AppRoot $version
    $nodeExe = Join-Path $target "node\node.exe"
    if ($oldConfig -or (Test-Path $target)) {
        Say "  Stopping the PAN that is running."
        Stop-Tree $InstallDir
    }
    if (-not (Test-Path $nodeExe) -or -not (Test-Path (Join-Path $target "VERSION.json"))) {
        $tmp = Join-Path $AppRoot ("." + $version + ".new")
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $tar = Join-Path $env:SystemRoot "System32\tar.exe"
        if (Test-Path $tar) {
            & $tar -xf $zip -C $tmp
            if ($LASTEXITCODE -ne 0) { Stop-Setup ("Unpacking failed (tar {0})." -f $LASTEXITCODE) }
        } else {
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
        }
        if (-not (Test-Path (Join-Path $tmp "app\node\node.exe"))) { Stop-Setup "The download is missing parts." }
        Move-Item (Join-Path $tmp "app") $target
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    $launcher = Join-Path $target "launcher\pan-launcher.cjs"
    foreach ($must in @($nodeExe, $launcher, (Join-Path $target "service\pan.js"), (Join-Path $target "pan-link\pan-link.exe"))) {
        if (-not (Test-Path $must)) { Stop-Setup ("Missing after unpacking: " + $must) }
    }
    Say ("  PAN is in " + $target)

    # ---- 4. settings for the launcher ------------------------------------------------
    Step "configure" "Setting it up"
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    $config = [ordered]@{
        version = $version; installDir = $InstallDir; dataDir = $DataDir
        port = $Port; carrierPort = $CarrierPort; craftPortBase = $CraftPortBase
        linkPort = $LinkPort; linkAdmin = $LinkAdmin; tag = $Tag
        installed = (Get-Date).ToUniversalTime().ToString("s") + "Z"
        firewallRule = $null; autostart = $false; dev = [bool]$Dev
        ollamaInstalledBySetup = $false; modelsAdded = @(); ollama = $null
    }
    if ($oldConfig) {
        if ($oldConfig.ollama -and (Test-Path ([string]$oldConfig.ollama))) { $config.ollama = [string]$oldConfig.ollama }
        if ($oldConfig.ollamaInstalledBySetup) { $config.ollamaInstalledBySetup = $true }
        if ($oldConfig.modelsAdded) { $config.modelsAdded = @($oldConfig.modelsAdded) }
    }
    Copy-Item (Join-Path $target "setup\pan-uninstall.ps1") (Join-Path $InstallDir "uninstall.ps1") -Force

    # The firewall: one rule, PAN Link's UDP port. PAN's own ports stay on this computer.
    $ruleName = "PAN Link ({0})" -f $LinkPort
    if ($NoFirewall) {
        Say "  Firewall rule skipped (asked to)."
    } else {
        $fw = @("advfirewall", "firewall", "add", "rule", ("name=" + $ruleName), "dir=in", "action=allow", "protocol=UDP", ("localport=" + $LinkPort), "profile=any")
        $exists = (& netsh.exe advfirewall firewall show rule ("name=" + $ruleName) 2>$null | Select-String "Rule Name") -ne $null
        if ($exists) {
            $config.firewallRule = $ruleName
            Say "  The firewall already lets PAN Link in."
        } elseif (Is-Admin) {
            & netsh.exe @fw | Out-Null
            if ($LASTEXITCODE -eq 0) { $config.firewallRule = $ruleName; Say "  The firewall now lets PAN Link in (UDP $LinkPort)." }
            else { Warn "Could not add the firewall rule. A phone will not reach this computer until it is added." }
        } elseif ($Quiet) {
            Warn "Not an administrator, so the firewall rule for PAN Link was not added. A phone will not reach this computer until it is."
        } else {
            Say "  Windows will ask once for permission to let your phone reach PAN (one firewall rule)."
            try {
                $quoted = ($fw | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
                $p = Start-Process netsh.exe -ArgumentList $quoted -Verb RunAs -Wait -PassThru -WindowStyle Hidden
                if ($p.ExitCode -eq 0) { $config.firewallRule = $ruleName; Say "  Done." }
                else { Warn "The firewall rule was not added. A phone will not reach this computer until it is." }
            } catch { Warn "Permission was not given, so the firewall rule was not added. A phone will not reach this computer until it is." }
        }
    }

    # Start at logon, as this user (PAN needs this user's own Claude sign in).
    $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
    $startLine = '"{0}" --headless "{1}" "{2}" "{3}"' -f $conhost, $nodeExe, $launcher, $InstallDir
    if ($NoAutostart) {
        try { Remove-ItemProperty -Path $RunKey -Name $Tag -ErrorAction Stop } catch {}
    } else {
        New-ItemProperty -Path $RunKey -Name $Tag -Value $startLine -PropertyType String -Force | Out-Null
        $config.autostart = $true
        Say "  PAN starts when you sign in to Windows."
    }
    WriteText $configPath ($config | ConvertTo-Json)

    # Shows up under Windows Settings, Apps, with a working Uninstall.
    $ukey = Join-Path $UninstallKey $Tag
    New-Item -Path $ukey -Force | Out-Null
    $uninstallLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -InstallDir "{1}"' -f (Join-Path $InstallDir "uninstall.ps1"), $InstallDir
    Set-ItemProperty -Path $ukey -Name DisplayName -Value $(if ($IsDefaultDir) { "PAN" } else { "PAN (" + $InstallDir + ")" })
    Set-ItemProperty -Path $ukey -Name DisplayVersion -Value $version
    Set-ItemProperty -Path $ukey -Name Publisher -Value "PAN"
    Set-ItemProperty -Path $ukey -Name InstallLocation -Value $InstallDir
    Set-ItemProperty -Path $ukey -Name UninstallString -Value $uninstallLine
    Set-ItemProperty -Path $ukey -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -Path $ukey -Name NoRepair -Value 1 -Type DWord
    Set-ItemProperty -Path $ukey -Name EstimatedSize -Value ([int]($release.size / 1KB * 2)) -Type DWord

    if ($IsDefaultDir) {
        $menu = [Environment]::GetFolderPath("Programs")
        WriteText (Join-Path $menu "PAN.url") ("[InternetShortcut]`r`nURL=http://127.0.0.1:{0}/`r`n" -f $Port)
    }

    # ---- 5. start --------------------------------------------------------------------
    if ($NoStart) {
        Say ""; Say "Installed. Not started (asked not to)."
    } else {
        Step "start" "Starting PAN (the first start takes a minute)"
        Start-Detached $conhost ('--headless "{0}" "{1}" "{2}"' -f $nodeExe, $launcher, $InstallDir)
        $deadline = (Get-Date).AddSeconds($StartTimeoutSec)
        $up = $false
        while ((Get-Date) -lt $deadline) {
            if (Health $Port) { $up = $true; break }
            Start-Sleep -Seconds 3
        }
        if (-not $up) {
            Stop-Setup ("PAN did not answer within {0} seconds. Its log is {1}" -f $StartTimeoutSec, (Join-Path $DataDir "hub.log"))
        }
        Say "  PAN is running."

        Step "verify" "Checking it"
        $addresses = @(Listening $Port | ForEach-Object { $_.LocalAddress } | Sort-Object -Unique)
        $script:Result.listen = $addresses
        $open = @($addresses | Where-Object { $_ -ne "127.0.0.1" -and $_ -ne "::1" })
        if ($open.Count -gt 0) {
            Stop-Tree $InstallDir
            Stop-Setup ("PAN was listening on the network ({0}), which must never happen. It was stopped." -f ($open -join ", "))
        }
        Say "  PAN answers on this computer only."
        $linkUp = $false
        for ($i = 0; $i -lt 10 -and -not $linkUp; $i++) {
            $linkUp = Test-Path (Join-Path $DataDir "link.json")
            if (-not $linkUp) { Start-Sleep -Seconds 2 }
        }
        $script:Result.link = $linkUp
        if ($linkUp) { Say "  PAN Link is ready for your phone." } else { Warn ("PAN Link did not start. Its log is " + (Join-Path $DataDir "pan-link.log")) }
    }

    # ---- 6. what PAN talks with ------------------------------------------------------
    if ($Voice -and -not $NoStart) {
        Step "voice" "Getting what PAN talks with"
        $catalog = Get-Content (Join-Path $target "service\model-set.json") -Raw | ConvertFrom-Json
        $ollamaUrl = [string]$catalog.ollama.url
        $setName = if ($ModelSet) { $ModelSet } elseif ($ramGB -ge 24) { "full" } else { "light" }
        $order = @("memory", "talk", "questions", "backup", "photos", "sorting")
        $wanted = @($catalog.models | Where-Object { $_.sets -contains $setName } | Sort-Object { $order.IndexOf($_.role) })
        $needGB = [Math]::Round((($wanted | Measure-Object -Property gb -Sum).Sum), 1)
        Say ("  {0} models, {1} GB, for a computer with {2} GB of memory" -f $wanted.Count, $needGB, $ramGB)
        $freeNow = [Math]::Round((Get-PSDrive -Name $drive.Name).Free / 1GB, 1)
        if ($freeNow -lt ($needGB + 6)) { Stop-Setup ("The models need {0} GB of free disk space. This drive has {1} GB." -f ($needGB + 6), $freeNow) }

        function Ollama-Exe {
            $p = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
            if (Test-Path $p) { return $p }
            $c = Get-Command ollama.exe -ErrorAction SilentlyContinue
            if ($c) { return $c.Source }
            return $null
        }
        function Ollama-Models {
            # $null when Ollama does not answer; a list, empty when it holds no models yet.
            # The comma keeps an empty list a list: PowerShell would hand back nothing.
            try { $names = @(((Invoke-WebRequest -Uri ($ollamaUrl + "/api/tags") -UseBasicParsing -TimeoutSec 8).Content | ConvertFrom-Json).models | ForEach-Object { [string]$_.name }) }
            catch { return $null }
            return ,$names
        }
        function Has-Model($list, $name) {
            $n = $name.ToLower(); if ($n -notmatch ':') { $n += ":latest" }
            foreach ($h in $list) { $x = $h.ToLower(); if ($x -notmatch ':') { $x += ":latest" }; if ($x -eq $n) { return $true } }
            return $false
        }
        function Run-Ollama($ollamaArgs, $workDir) {
            # Through Start-Process: Ollama writes its progress to the error stream, which
            # Windows PowerShell would turn into a failure.
            $a = @{ FilePath = (Ollama-Exe); ArgumentList = $ollamaArgs; Wait = $true; PassThru = $true; NoNewWindow = $true }
            if ($workDir) { $a.WorkingDirectory = $workDir }
            if ($Quiet) { $a.RedirectStandardOutput = (Join-Path $dl "ollama.out.log"); $a.RedirectStandardError = (Join-Path $dl "ollama.err.log") }
            return (Start-Process @a).ExitCode
        }

        # Ollama itself: its own installer, checked for Ollama's signature before it runs.
        if (-not (Ollama-Exe)) {
            Say "  Getting Ollama, the program that runs the models."
            $setupExe = Join-Path $dl "OllamaSetup.exe"
            $curl = Join-Path $env:SystemRoot "System32\curl.exe"
            $curlArgs = @("-L", "--fail", "--retry", "5", "--retry-delay", "3", "-C", "-", "-o", $setupExe, [string]$catalog.ollama.installer)
            if ($Quiet) { $curlArgs = @("-sS") + $curlArgs }
            # A whole, signed copy from an earlier run is used as it is.
            $whole = $false
            if (Test-Path $setupExe) { $s0 = Get-AuthenticodeSignature $setupExe; $whole = ($s0.Status -eq "Valid") }
            if (-not $whole) {
                & $curl @curlArgs
                if ($LASTEXITCODE -ne 0) { Stop-Setup ("Ollama did not download (curl {0}). Run PAN Setup again to carry on." -f $LASTEXITCODE) }
            }
            $sig = Get-AuthenticodeSignature $setupExe
            if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch [regex]::Escape([string]$catalog.ollama.signer)) {
                Remove-Item $setupExe -Force -ErrorAction SilentlyContinue
                Stop-Setup "The Ollama download is not signed by Ollama, so it was thrown away."
            }
            Say "  Installing Ollama."
            $p = Start-Process -FilePath $setupExe -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" -Wait -PassThru
            if ($p.ExitCode -ne 0 -or -not (Ollama-Exe)) { Stop-Setup ("Ollama did not install (code {0})." -f $p.ExitCode) }
            $config.ollamaInstalledBySetup = $true
            WriteText $configPath ($config | ConvertTo-Json)
            Remove-Item $setupExe -Force -ErrorAction SilentlyContinue
        }
        $have = Ollama-Models
        if ($null -eq $have) {
            Start-Detached (Ollama-Exe) "serve"
            for ($i = 0; $i -lt 90 -and $null -eq $have; $i++) { Start-Sleep -Seconds 2; $have = Ollama-Models }   # its first start is slow
            if ($null -eq $have) { Stop-Setup "Ollama is installed but does not answer." }
        }
        Say "  Ollama is running."
        # From now on PAN's launcher starts Ollama at sign in when nothing else has.
        $config.ollama = (Ollama-Exe)
        WriteText $configPath ($config | ConvertTo-Json)

        # Not <install>\models: the translator keeps its models there, and this folder is deleted below.
        $ownDir = Join-Path $dl "own-models"
        foreach ($m in $wanted) {
            $name = [string]$m.name
            if (Has-Model $have $name) { Say ("  have    {0}" -f $name); continue }
            if ($m.from -eq "ollama") {
                Say ("  getting {0} ({1} GB): {2}" -f $name, $m.gb, $m.what)
                if ((Run-Ollama @("pull", $name) $null) -ne 0) { Stop-Setup ("{0} did not download. Run PAN Setup again to carry on." -f $name) }
            } else {
                $ownHere = $false
                if ($OwnModels -match '^https?://') { $ownHere = $true }
                elseif ($OwnModels) { $ownHere = Test-Path (Join-Path $OwnModels ([string]$m.file)) }
                if (-not $ownHere) {
                    Warn ("{0} is PAN's own model and has no public download yet. Skipped." -f $name)
                    if ($m.standIn -and -not (Has-Model $have ([string]$m.standIn))) {
                        Say ("  getting {0} in its place" -f $m.standIn)
                        if ((Run-Ollama @("pull", [string]$m.standIn) $null) -eq 0) { $config.modelsAdded = @($config.modelsAdded) + [string]$m.standIn; WriteText $configPath ($config | ConvertTo-Json) }
                    }
                    continue
                }
                Say ("  getting {0} ({1} GB): {2}" -f $name, $m.gb, $m.what)
                New-Item -ItemType Directory -Path $ownDir -Force | Out-Null
                $gguf = Join-Path $ownDir ([string]$m.file)
                if ($OwnModels -match '^https?://') {
                    & (Join-Path $env:SystemRoot "System32\curl.exe") -L --fail --retry 5 -C - -sS -o $gguf ($OwnModels.TrimEnd('/') + "/" + $m.file)
                    if ($LASTEXITCODE -ne 0) { Stop-Setup ("{0} did not download." -f $name) }
                } else {
                    Copy-Item (Join-Path $OwnModels ([string]$m.file)) $gguf -Force
                }
                $short = ($name -split ':')[0]
                Copy-Item (Join-Path $target ("service\model-files\{0}.Modelfile" -f $short)) (Join-Path $ownDir ($short + ".Modelfile")) -Force
                if ((Run-Ollama @("create", $name, "-f", ($short + ".Modelfile")) $ownDir) -ne 0) { Stop-Setup ("Ollama could not take {0}." -f $name) }
                Remove-Item $gguf -Force -ErrorAction SilentlyContinue   # Ollama keeps its own copy
            }
            $config.modelsAdded = @($config.modelsAdded) + $name
            WriteText $configPath ($config | ConvertTo-Json)
        }
        if (Test-Path $ownDir) { Remove-Item $ownDir -Recurse -Force -ErrorAction SilentlyContinue }

        # Point PAN at what is here, and start it again so it picks its talking model up.
        try {
            $applied = (Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/v1/setup/models/apply" -f $Port) -Method Post -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
        } catch { Stop-Setup ("PAN did not take the model settings: " + $_.Exception.Message) }
        $script:Result.voice = [ordered]@{ set = $setName; canTalk = [bool]$applied.voice; missing = @($applied.missing); models = @($config.modelsAdded) }
        if ($applied.restart) {
            Say "  Restarting PAN with its models."
            Stop-Tree $InstallDir
            Start-Detached $conhost ('--headless "{0}" "{1}" "{2}"' -f $nodeExe, $launcher, $InstallDir)
            $deadline = (Get-Date).AddSeconds($StartTimeoutSec); $up = $false
            while ((Get-Date) -lt $deadline) { if (Health $Port) { $up = $true; break }; Start-Sleep -Seconds 3 }
            if (-not $up) { Stop-Setup "PAN did not come back after the models went in." }
        }
        if ($applied.voice) {
            Say "  Asking PAN to say hello (the first answer loads the model, so it is the slow one)."
            $reply = $null
            for ($try = 0; $try -lt 4 -and -not ($reply -and $reply.ok); $try++) {
                if ($try -gt 0) { Start-Sleep -Seconds 15 }
                $ErrorActionPreference = "Continue"
                $line = (& $nodeExe (Join-Path $target "launcher\voice-check.cjs") $Port 2>$null | Select-Object -Last 1)
                $ErrorActionPreference = "Stop"
                try { $reply = $line | ConvertFrom-Json } catch { $reply = $null }
            }
            $script:Result.voice.reply = $reply
            if ($reply -and $reply.ok) { Say ("  PAN said: ""{0}"" (first word after {1} s)" -f $reply.reply, [Math]::Round($reply.firstMs / 1000, 1)) }
            else { Warn "The models are in, but PAN did not answer a spoken line." }
        } else {
            Warn "PAN has no talking model here, so voice will be slow or silent."
        }
    } elseif ($Voice) {
        Warn "The models were not installed because PAN was not started."
    }

    # ---- 7. the translator -----------------------------------------------------------
    if ($Translator -and -not $NoStart) {
        Step "translator" "Getting the translator"
        $catalog = Get-Content (Join-Path $target "service\model-set.json") -Raw | ConvertFrom-Json
        $tr = $catalog.translator
        $setName = if ($ModelSet) { $ModelSet } elseif ($ramGB -ge 24) { "full" } else { "light" }
        $trModels = @($tr.models | Where-Object { $_.sets -contains $setName } | Sort-Object gb)
        $trDir = Join-Path $InstallDir "translate"
        $venv = Join-Path $trDir "venv"
        $py = Join-Path $venv "Scripts\python.exe"
        $curl = Join-Path $env:SystemRoot "System32\curl.exe"
        New-Item -ItemType Directory -Path $trDir -Force | Out-Null

        # Its own Python, inside the install folder, so nothing is left behind and nothing
        # on the computer is touched. uv is one small program that fetches Python and the
        # two packages; it is checked against its published SHA-256 before it runs.
        $pyOk = $false
        if (Test-Path $py) {
            $ErrorActionPreference = "Continue"
            & $py -c "import ctranslate2, sentencepiece" 2>$null
            $pyOk = ($LASTEXITCODE -eq 0)
            $ErrorActionPreference = "Stop"
        }
        if (-not $pyOk) {
            Say "  Setting up Python for the translator."
            $uvZip = Join-Path $dl "uv.zip"
            & $curl -L --fail --retry 5 -sS -o $uvZip ([string]$tr.uv.windows.url)
            if ($LASTEXITCODE -ne 0) { Stop-Setup ("The translator's installer did not download (curl {0})." -f $LASTEXITCODE) }
            if ((Get-FileHash $uvZip -Algorithm SHA256).Hash -ine [string]$tr.uv.windows.sha256) {
                Remove-Item $uvZip -Force -ErrorAction SilentlyContinue
                Stop-Setup "The translator's installer does not match what its makers published, so it was thrown away."
            }
            $uvDir = Join-Path $trDir "uv"
            if (Test-Path $uvDir) { Remove-Item $uvDir -Recurse -Force }
            New-Item -ItemType Directory -Path $uvDir -Force | Out-Null
            & (Join-Path $env:SystemRoot "System32\tar.exe") -xf $uvZip -C $uvDir
            $uv = Join-Path $uvDir "uv.exe"
            if (-not (Test-Path $uv)) { Stop-Setup "The translator's installer is missing parts." }
            $env:UV_PYTHON_INSTALL_DIR = Join-Path $trDir "python"
            $env:UV_CACHE_DIR = Join-Path $trDir "cache"
            $env:UV_NO_PROGRESS = "1"
            if (Test-Path $venv) { Remove-Item $venv -Recurse -Force }
            foreach ($step in @(
                @("venv", "--python", [string]$tr.python, $venv),
                (@("pip", "install", "--python", $py) + @($tr.packages | ForEach-Object { [string]$_ }))
            )) {
                $p = Start-Process -FilePath $uv -ArgumentList $step -Wait -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $dl "uv.out.log") -RedirectStandardError (Join-Path $dl "uv.err.log")
                if ($p.ExitCode -ne 0) { Stop-Setup ("Python for the translator did not install (uv {0}, code {1}). See {2}" -f $step[0], $p.ExitCode, (Join-Path $dl "uv.err.log")) }
            }
            Remove-Item (Join-Path $trDir "cache") -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item $uvDir -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item $uvZip -Force -ErrorAction SilentlyContinue
        }
        Say "  Python is ready."

        foreach ($m in $trModels) {
            $mdir = Join-Path $InstallDir ("models\" + [string]$m.name)
            New-Item -ItemType Directory -Path $mdir -Force | Out-Null
            $todo = @($m.files | Where-Object { $f = Join-Path $mdir ([string]$_.name); -not ((Test-Path $f) -and ((Get-Item $f).Length -eq [int64]$_.size)) })
            if ($todo.Count -eq 0) { Say ("  have    {0}" -f $m.name); continue }
            Say ("  getting {0} ({1} GB): {2}" -f $m.name, $m.gb, $m.what)
            foreach ($f in $todo) {
                $name = [string]$f.name
                if ($name -notmatch '^[0-9A-Za-z._-]+$') { Stop-Setup "The translator's list names a file that is not allowed." }
                $dest = Join-Path $mdir $name
                # Downloaded beside its final name, so a half file is never taken for a whole one.
                $part = $dest + ".download"
                $url = "https://huggingface.co/{0}/resolve/{1}/{2}" -f $m.repo, $m.rev, $name
                # A whole file left by a run that stopped just before the rename is not fetched again.
                if (-not ((Test-Path $part) -and ((Get-Item $part).Length -eq [int64]$f.size))) {
                    & $curl -L --fail --retry 5 --retry-delay 3 -C - -sS -o $part $url
                } else { $global:LASTEXITCODE = 0 }
                if ($LASTEXITCODE -ne 0) { Stop-Setup ("{0} did not download (curl {1}). Run PAN Setup again to carry on." -f $name, $LASTEXITCODE) }
                if ((Get-Item $part).Length -ne [int64]$f.size) { Remove-Item $part -Force; Stop-Setup ("{0} came down the wrong size." -f $name) }
                if ($f.sha256 -and ((Get-FileHash $part -Algorithm SHA256).Hash -ine [string]$f.sha256)) {
                    Remove-Item $part -Force
                    Stop-Setup ("{0} does not match what was published, so it was thrown away." -f $name)
                }
                Move-Item $part $dest -Force
            }
        }
        New-Item -ItemType Directory -Path (Join-Path $InstallDir "logs") -Force | Out-Null

        Say "  Restarting PAN with its translator."
        Stop-Tree $InstallDir
        Start-Detached $conhost ('--headless "{0}" "{1}" "{2}"' -f $nodeExe, $launcher, $InstallDir)
        $deadline = (Get-Date).AddSeconds($StartTimeoutSec); $up = $false
        while ((Get-Date) -lt $deadline) { if (Health $Port) { $up = $true; break }; Start-Sleep -Seconds 3 }
        if (-not $up) { Stop-Setup "PAN did not come back after the translator went in." }
        $said = $null
        for ($i = 0; $i -lt 40 -and -not $said; $i++) {
            Start-Sleep -Seconds 3
            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:7784/translate" -Method Post -ContentType "application/json" -Body '{"text":"Good morning. Where is the train station?","src":"en","tgt":"es"}' -UseBasicParsing -TimeoutSec 30
                $said = [string]($r.Content | ConvertFrom-Json).text
            } catch {}
        }
        $script:Result.translator = [ordered]@{ set = $setName; models = @($trModels | ForEach-Object { [string]$_.name }); spanish = $said }
        if ($said) { Say "  The translator answers (English to Spanish checked)." }
        else { Warn ("The translator is installed but did not answer. Its log is " + (Join-Path $InstallDir "logs\translate.log")) }
    } elseif ($Translator) {
        Warn "The translator was not installed because PAN was not started."
    }

    # Older versions go once the new one is up. The one before this stays, to go back to.
    $keep = @($version)
    if ($oldConfig -and $oldConfig.version -and $oldConfig.version -ne $version) { $keep += [string]$oldConfig.version }
    Get-ChildItem $AppRoot -Directory -Force | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
        try { Remove-Item $_.FullName -Recurse -Force } catch {}
    }
    Get-ChildItem $dl -File | Where-Object { $_.Name -ne $release.file } | ForEach-Object { try { Remove-Item $_.FullName -Force } catch {} }

    $script:Result.ok = $true
    $script:Result.step = "done"
    $script:Result.pairUrl = "http://127.0.0.1:{0}/pair/" -f $Port
    $script:Result.firewallRule = $config.firewallRule
    $script:Result.autostart = $config.autostart
    SaveResult
    Say ""
    Say "PAN is installed."
    if (-not $NoStart) {
        Say ("Next: open the PAN app on your phone and scan the code on this page: " + $script:Result.pairUrl)
        if (-not $Quiet) { Start-Process $script:Result.pairUrl }
    }
    exit 0
} catch {
    Stop-Setup ($_.Exception.Message + " (at " + $_.InvocationInfo.ScriptLineNumber + ")")
}
