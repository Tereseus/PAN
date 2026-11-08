package main

import (
	"net/netip"
	"reflect"
	"testing"
)

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
