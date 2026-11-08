//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

// adapterDescriptions maps interface index to the adapter's description. The description
// names the driver ("VirtualBox Host-Only Ethernet Adapter") even when the adapter itself
// is only called "Ethernet 2".
func adapterDescriptions() map[int]string {
	out := map[int]string{}
	aas, err := winipcfg.GetAdaptersAddresses(windows.AF_UNSPEC,
		winipcfg.GAAFlagSkipAnycast|winipcfg.GAAFlagSkipMulticast|winipcfg.GAAFlagSkipDNSServer)
	if err != nil {
		return out
	}
	for _, aa := range aas {
		out[int(aa.IfIndex)] = aa.Description()
	}
	return out
}
