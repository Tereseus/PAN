# Keep the host's port forwards pointed at the HomeAssistant VM.
#
# WHY: the VM is on Hyper-V's "Default Switch", whose subnet Windows
# re-randomises on every host reboot. A forward written today points into a
# black hole tomorrow — which is exactly what had happened (forward said
# 172.30.40.157, VM was on 172.18.153.173, so nothing on the LAN could reach
# HA). Idempotent; safe to run on a timer and at boot.
#
# Port 80 matters as well as 8123: HA redirects 8123 -> :80/onboarding.html,
# so forwarding only 8123 dead-ends the redirect on the host.
$ErrorActionPreference = 'Stop'

$vmName = 'HomeAssistant'
$ports  = @(8123, 80)

$ip = (Get-VMNetworkAdapter -VMName $vmName).IPAddresses |
      Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } |
      Select-Object -First 1

if (-not $ip) { Write-Output "FAIL: VM has no IPv4 (not running?)"; exit 1 }
Write-Output ("VM IPv4: {0}" -f $ip)

foreach ($port in $ports) {
    $existing = netsh interface portproxy show v4tov4 | Select-String -Pattern "\s$port\s+\d"
    foreach ($line in $existing) {
        $f = ($line -split '\s+') | Where-Object { $_ }
        if ($f.Count -ge 4 -and $f[1] -eq "$port") {
            netsh interface portproxy delete v4tov4 listenaddress=$($f[0]) listenport=$($f[1]) | Out-Null
        }
    }
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$port connectaddress=$ip connectport=$port | Out-Null
    Write-Output ("  forward 0.0.0.0:{0} -> {1}:{0}" -f $port, $ip)

    $rule = "PAN Home Assistant $port"
    if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP `
            -LocalPort $port -Action Allow -Profile Any | Out-Null
        Write-Output ("  firewall rule created for {0}" -f $port)
    }
}

Write-Output "done"
