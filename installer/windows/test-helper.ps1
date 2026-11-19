# The install test's hands on the computer under test (install-test.py runs it, here or
# over ssh). Every action prints one line of JSON. It changes nothing by itself except in
# the actions named kill-pan, stop-all, run-autostart and pair.
#
# Plain ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 files that have no BOM.

param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "PAN"),
    [int]$Port = 7777,
    [int]$CarrierPort = 17760,
    [int]$CraftPortBase = 17700,
    [int]$LinkPort = 41720,
    [string]$LinkAdmin = "127.0.0.1:7792",
    [string]$Method = "GET",
    [string]$Url = "",
    [string]$BodyB64 = "",
    [string]$CodeB64 = "",
    [string]$Listen = "127.0.0.1:27779"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$prefix = $InstallDir.TrimEnd('\') + '\'
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"

function Out-Json($o) { Write-Output ($o | ConvertTo-Json -Depth 6 -Compress) }
function Mine {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}
function Tag {
    $cfg = Join-Path $InstallDir "install.json"
    if (Test-Path $cfg) { try { $t = (Get-Content $cfg -Raw | ConvertFrom-Json).tag; if ($t) { return [string]$t } } catch {} }
    if ($InstallDir -ieq [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "PAN"))) { return "PAN" }
    return "PAN-" + ([Math]::Abs($InstallDir.ToLower().GetHashCode()) % 100000)
}
function Listen-Addresses($p) {
    try { @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop | ForEach-Object { $_.LocalAddress } | Sort-Object -Unique) } catch { @() }
}
function Http($method, $url, $bodyB64) {
    try {
        $a = @{ Uri = $url; Method = $method; UseBasicParsing = $true; TimeoutSec = 20 }
        if ($bodyB64) {
            $a.Body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($bodyB64))
            $a.ContentType = "application/json"
        }
        $r = Invoke-WebRequest @a
        return @{ status = [int]$r.StatusCode; body = [string]$r.Content }
    } catch {
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch {}
        return @{ status = $code; body = ""; error = $_.Exception.Message }
    }
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

switch ($Action) {
    "probe" {
        $tag = Tag
        $cfg = $null
        $cfgPath = Join-Path $InstallDir "install.json"
        if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {} }
        $run = $null
        try { $run = (Get-ItemProperty -Path $RunKey -Name $tag -ErrorAction Stop).$tag } catch {}
        $un = $null
        try { $u = Get-ItemProperty -Path (Join-Path $UninstallKey $tag) -ErrorAction Stop; $un = @{ name = $u.DisplayName; version = $u.DisplayVersion } } catch {}
        $craft = @{}
        for ($p = $CraftPortBase; $p -le $CraftPortBase + 40; $p++) { $a = Listen-Addresses $p; if ($a.Count) { $craft["$p"] = $a } }
        $udp = $false
        try { $udp = @(Get-NetUDPEndpoint -LocalPort $LinkPort -ErrorAction Stop).Count -gt 0 } catch {}
        $ruleName = "PAN Link ({0})" -f $LinkPort
        $rule = (& netsh.exe advfirewall firewall show rule ("name=" + $ruleName) 2>$null | Select-String "Rule Name") -ne $null
        $apps = @()
        if (Test-Path (Join-Path $InstallDir "app")) { $apps = @(Get-ChildItem (Join-Path $InstallDir "app") -Directory -Force | ForEach-Object { $_.Name }) }
        $data = Join-Path $InstallDir "data"
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        Out-Json ([ordered]@{
            computer = $env:COMPUTERNAME
            admin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            installDirExists = (Test-Path $InstallDir)
            config = $cfg
            tag = $tag
            run = $run
            uninstallEntry = $un
            startMenu = (Test-Path (Join-Path ([Environment]::GetFolderPath("Programs")) "PAN.url"))
            processes = @(Mine | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name; cmd = [string]$_.CommandLine } })
            listen = @{ pan = @(Listen-Addresses $Port); carrier = @(Listen-Addresses $CarrierPort); craft = $craft; linkAdmin = @(Listen-Addresses ([int]($LinkAdmin.Split(':')[-1]))) }
            linkUdp = $udp
            health = ((Http "GET" ("http://127.0.0.1:{0}/health" -f $Port) "").status -eq 200)
            appVersions = $apps
            dataExists = (Test-Path $data)
            dbExists = (Test-Path (Join-Path $data "pan.db"))
            linkJson = (Test-Path (Join-Path $data "link.json"))
            firewallRule = $rule
        })
    }
    "http" { Out-Json (Http $Method $Url $BodyB64) }
    "kill-pan" {
        # PAN itself, not its launcher: the launcher has to bring it back.
        $pan = @(Mine | Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match 'pan\.js"?\s+start' })
        foreach ($p in $pan) { & taskkill.exe /F /T /PID $p.ProcessId 2>$null | Out-Null }
        Out-Json @{ killed = @($pan | ForEach-Object { $_.ProcessId }) }
    }
    "stop-all" {
        # What signing out of Windows does to it.
        $n = 0
        for ($round = 0; $round -lt 4; $round++) {
            $mine = Mine
            if ($mine.Count -eq 0) { break }
            foreach ($p in $mine) { try { & taskkill.exe /F /T /PID $p.ProcessId 2>$null | Out-Null; $n++ } catch {} }
            Start-Sleep -Seconds 2
        }
        Out-Json @{ stopped = $n; left = (Mine).Count }
    }
    "run-autostart" {
        # What signing in to Windows does: run the line PAN Setup put under Run.
        $tag = Tag
        $line = (Get-ItemProperty -Path $RunKey -Name $tag -ErrorAction Stop).$tag
        if ($line -notmatch '^"([^"]+)"\s+(.*)$') { Out-Json @{ ok = $false; error = "unreadable Run line"; line = $line }; break }
        Start-Detached $Matches[1] $Matches[2]
        Out-Json @{ ok = $true; line = $line }
    }
    "pair" {
        # Pair a stand-in device on this same computer and ask PAN, through the link, who it is.
        $cfg = Get-Content (Join-Path $InstallDir "install.json") -Raw | ConvertFrom-Json
        $link = Join-Path $InstallDir ("app\{0}\pan-link\pan-link.exe" -f $cfg.version)
        $client = Join-Path $InstallDir "test-client"
        if (Test-Path $client) { Remove-Item $client -Recurse -Force }
        New-Item -ItemType Directory -Path $client -Force | Out-Null
        $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CodeB64))
        $ErrorActionPreference = "Continue"
        $out = (& $link pair --code $code --data $client --name "install test device" 2>&1 | Out-String)
        $paired = ($LASTEXITCODE -eq 0)
        $me = $null
        if ($paired) {
            Start-Detached $link ('client --data "{0}" --listen {1}' -f $client, $Listen)
            for ($i = 0; $i -lt 10 -and -not $me; $i++) {
                Start-Sleep -Seconds 2
                $r = Http "GET" ("http://{0}/api/v1/auth/me" -f $Listen) ""
                if ($r.status -eq 200) { $me = $r.body }
            }
        }
        Out-Json @{ paired = $paired; output = $out.Trim(); me = $me }
    }
    default { Out-Json @{ error = "unknown action $Action" }; exit 2 }
}
