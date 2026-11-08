package main

import (
	"net/netip"
	"reflect"
	"testing"

	"tailscale.com/net/netmon"
)

// Virtual machine and container adapters stay out of the pairing code, except the one
// with the default route (a Hyper-V external switch holds the real home address).
func TestKeepAdapter(t *testing.T) {
	wifi := netmon.DefaultRouteDetails{InterfaceName: "Wi-Fi 2", InterfaceIndex: 7}
	external := netmon.DefaultRouteDetails{InterfaceName: "vEthernet (External)", InterfaceIndex: 15}
	linux := netmon.DefaultRouteDetails{InterfaceName: "br0", InterfaceIndex: 4}
	cases := []struct {
		name, desc string
		index      int
		def        netmon.DefaultRouteDetails
		keep       bool
	}{
		{"Wi-Fi 2", "Intel(R) Wi-Fi 6E AX211 160MHz", 7, wifi, true},
		{"Ethernet", "Realtek PCIe GbE Family Controller", 3, wifi, true},
		{"Tailscale", "Tailscale Tunnel", 12, wifi, true},
		{"Local Area Connection* 10", "Microsoft Wi-Fi Direct Virtual Adapter #2", 18, wifi, true}, // the PC's own hotspot
		{"vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter", 31, wifi, false},
		{"vEthernet (WSL (Hyper-V firewall))", "Hyper-V Virtual Ethernet Adapter #2", 45, wifi, false},
		{"Ethernet 2", "VirtualBox Host-Only Ethernet Adapter", 16, wifi, false},
		{"VMware Network Adapter VMnet8", "VMware Virtual Ethernet Adapter for VMnet8", 21, wifi, false},
		{"vEthernet (External)", "Hyper-V Virtual Ethernet Adapter #3", 15, external, true},
		{"vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter", 31, external, false},
		{"eth0", "", 2, linux, true},
		{"wlan0", "", 3, linux, true},
		{"br0", "", 4, linux, true},
		{"tailscale0", "", 9, linux, true},
		{"docker0", "", 5, linux, false},
		{"br-3f2a9c1d7e6b", "", 6, linux, false},
		{"veth9f8e7d6", "", 7, linux, false},
		{"virbr0", "", 8, linux, false},
		{"vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter", 31, netmon.DefaultRouteDetails{}, true}, // route unknown: keep all
	}
	for _, c := range cases {
		if got := keepAdapter(c.name, c.desc, c.index, c.def); got != c.keep {
			t.Errorf("keepAdapter(%q, %q, %d, %q) = %v, want %v", c.name, c.desc, c.index, c.def.InterfaceName, got, c.keep)
		}
	}
}

func TestOrderEndpoints(t *testing.T) {
	addrs := []netip.Addr{
		netip.MustParseAddr("100.101.102.103"),      // Tailscale
		netip.MustParseAddr("2001:db8:1:2::5"),      // global IPv6
		netip.MustParseAddr("192.168.50.10"),        // home network
		netip.MustParseAddr("fd7a:115c:a1e0::1234"), // Tailscale IPv6
		netip.MustParseAddr("fd0a:b2e1::1"),         // home-only IPv6 (ULA): not useful away from home
		netip.MustParseAddr("fe80::1"),              // link local: skip
		netip.MustParseAddr("169.254.10.10"),        // link local: skip
		netip.MustParseAddr("::ffff:10.0.0.7"),      // mapped IPv4 home address
		netip.MustParseAddr("198.51.100.20"),        // a public IPv4 right on an interface
	}
	public := netip.MustParseAddrPort("203.0.113.9:51000")
	got := orderEndpoints(addrs, 41720, public, []string{"pan.example:41720"})
	want := []string{
		"192.168.50.10:41720",
		"10.0.0.7:41720",
		"[2001:db8:1:2::5]:41720",
		"198.51.100.20:41720",
		"203.0.113.9:51000",
		"100.101.102.103:41720",
		"[fd7a:115c:a1e0::1234]:41720",
		"pan.example:41720",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
	if got := orderEndpoints(addrs[:1], 41720, netip.AddrPort{}, nil); !reflect.DeepEqual(got, []string{"100.101.102.103:41720"}) {
		t.Fatalf("tailnet only: %v", got)
	}
}
