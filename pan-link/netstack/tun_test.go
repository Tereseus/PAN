package netstack

import (
	"io"
	"net/netip"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/tun"
)

// pump carries packets from one stack to the other, as WireGuard would.
func pump(from, to tun.Device) {
	buf := [][]byte{make([]byte, 2048)}
	sizes := []int{0}
	for {
		n, err := from.Read(buf, sizes, 0)
		if err != nil {
			return
		}
		if n == 1 {
			to.Write([][]byte{buf[0][:sizes[0]]}, 0)
		}
	}
}

// TestBulkTransferNoSpuriousRetransmits sends 16 MB between two stacks joined back to
// back: no loss, no reordering. With gVisor's RACK on, Windows' coarse clock made the
// sender retransmit a large share of the segments for nothing (the APK download from
// the hub stalled, Nov 15 2026); with setTCPOptions it retransmits none.
func TestBulkTransferNoSpuriousRetransmits(t *testing.T) {
	a := netip.MustParseAddr("10.77.0.1")
	b := netip.MustParseAddr("10.77.0.2")
	tunA, netA, err := CreateNetTUN([]netip.Addr{a}, nil, 1280)
	if err != nil {
		t.Fatal(err)
	}
	defer tunA.Close()
	tunB, netB, err := CreateNetTUN([]netip.Addr{b}, nil, 1280)
	if err != nil {
		t.Fatal(err)
	}
	defer tunB.Close()
	go pump(tunA, tunB)
	go pump(tunB, tunA)

	ln, err := netA.ListenTCPAddrPort(netip.AddrPortFrom(a, 7777))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	const size = 16 << 20
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.Write(make([]byte, size))
	}()
	c, err := netB.DialTCPAddrPort(netip.AddrPortFrom(a, 7777))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	start := time.Now()
	n, err := io.Copy(io.Discard, c)
	if n != size {
		t.Fatalf("got %d of %d bytes: %v", n, size, err)
	}
	stats := netA.stack.Stats().TCP
	sent, retrans := stats.SegmentsSent.Value(), stats.Retransmits.Value()
	t.Logf("%d MB in %v, %d segments, %d retransmitted", size>>20, time.Since(start), sent, retrans)
	if retrans*100 > sent {
		t.Fatalf("%d of %d segments retransmitted on a path that loses nothing", retrans, sent)
	}
}
